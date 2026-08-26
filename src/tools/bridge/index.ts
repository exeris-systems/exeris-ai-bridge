import type {
  BridgeConfig,
  DocsConfig,
  KernelConfig,
  LspConfig,
  ToolFamily,
  Unavailable,
} from "../../config/env.js";
import { loadBundle, type BundleState } from "../../data/bundle.js";
import type { KernelAdapter, KernelCloseReason, KernelStatus } from "../../transport/kernel-adapter.js";
import type { LspClient, LspCloseReason, LspStatus } from "../../transport/lsp-client.js";
import type { RegisteredTool } from "../types.js";
import { getServerVersion } from "../../version.js";

// bridge:* — the bridge's own diagnostic surface. It reports on the server
// rather than on Exeris: which persona the environment resolved to, which
// families are live, and why the dark ones are dark.
//
// This family is the one that CANNOT go dark. Everything else here is gated by
// config resolution (../unavailable.ts); bridge:* has no external dependency to
// resolve, which is precisely what makes it useful — it is the surface that
// explains the others when they fail. It is therefore deliberately absent from
// the `ToolFamily` union that guard() ranges over.
//
// Zero spawns, by construction. Both handlers read config that was resolved at
// boot and call the transports' non-spawning status() accessors. An agent can
// call bridge:health as often as it likes; it costs nothing and — just as
// importantly — it does not perturb the state it reports. "Can this child
// actually launch?" is deliberately NOT answered here: the family's own tools
// answer it by doing the work, and the resulting transport state then shows up
// in the next bridge:health. See the ADR-025 bridge:* addendum.
//
// The family is frozen at two tools. Adding a third needs an ADR-025 amendment.

export interface BridgeTransports {
  /** Present when lsp:* resolved a launch spec; shares the instance the family uses. */
  readonly lsp?: LspClient;
  /** Present when kernel:* resolved a launch spec; shares the instance the family uses. */
  readonly kernel?: KernelAdapter;
}

export function registerBridgeTools(
  config: BridgeConfig,
  transports: BridgeTransports = {},
  bundle: BundleState = loadBundle(),
): RegisteredTool[] {
  return [versionTool(config, bundle), healthTool(config, transports)];
}

// ---------------------------------------------------------------------------
// bridge:version

function versionTool(config: BridgeConfig, bundle: BundleState): RegisteredTool {
  return {
    definition: {
      name: "bridge:version",
      description:
        "Identify this MCP server: package name and version, the Node runtime it " +
        "is running on, which persona mode it resolved to, and what bundled " +
        "reference data it carries. Use it to confirm which bridge build an " +
        "answer came from, and which upstream release that data reflects.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () =>
      ok({
        name: "exeris-ai-bridge",
        version: getServerVersion(),
        node: process.version,
        mode: config.mode,
        modeSource: config.modeSource,
        bundle: describeBundle(bundle),
      }),
  };
}

/**
 * Render the bundled reference data for the wire.
 *
 * Absent is a first-class answer, not an omission: it is the ordinary state of
 * a bridge run from a source checkout, and it is the first thing to check when
 * an agent asks why the reference surfaces know nothing. Entries carry their
 * own `sourceArtifact` so the answer can name which upstream release it
 * reflects rather than only how many files it has.
 */
function describeBundle(bundle: BundleState): unknown {
  if (bundle.state === "unavailable") {
    return { state: "unavailable", reason: bundle.reason, remedy: bundle.remedy };
  }
  return {
    state: "available",
    generatedAt: bundle.generatedAt,
    bridgeVersion: bundle.bridgeVersion,
    entryCount: bundle.entries.length,
    sourceArtifacts: [...new Set(bundle.entries.map((e) => e.sourceArtifact))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

// ---------------------------------------------------------------------------
// bridge:health

function healthTool(config: BridgeConfig, transports: BridgeTransports): RegisteredTool {
  return {
    definition: {
      name: "bridge:health",
      description:
        "Report which tool families can serve requests and why the others cannot. " +
        "Each family carries its state and, when unavailable, the reason and the " +
        "remedy. Families backed by a child process also report that process's " +
        "current state — without starting it. Call this first when a tool returns " +
        "'family_unavailable'.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () =>
      ok({
        mode: config.mode,
        modeSource: config.modeSource,
        families: [
          plainFamilyReport("docs", config.docs),
          childFamilyReport("lsp", config.lsp, transports.lsp?.status()),
          childFamilyReport("kernel", config.kernel, transports.kernel?.status()),
        ],
      }),
  };
}

interface FamilyReport {
  readonly family: ToolFamily;
  readonly state: "available" | "unavailable";
  /** Which rung of the launch ladder produced the spec. Absent for docs:*. */
  readonly source?: string;
  /** Which artifact version the ladder picked, when it resolved one by coordinate. */
  readonly artifactVersion?: string;
  readonly reason?: string;
  readonly remedy?: string;
  readonly transport?: TransportReport | null;
}

interface TransportReport {
  readonly state: string;
  /** Path-free summary of the last failure, or null if there has been none. */
  readonly lastError: string | null;
}

/**
 * A family with no child process behind it — docs:* reads the filesystem
 * directly. The `transport` key is absent entirely, not null.
 */
function plainFamilyReport(family: ToolFamily, config: DocsConfig | Unavailable): FamilyReport {
  if (config.state === "unavailable") return darkFamilyReport(family, config);
  return { family, state: "available" };
}

/**
 * A family served by a child process: reports which ladder rung produced the
 * launch spec, and the child's current state.
 *
 * `transport` is `null` — not absent — when the family resolved but no instance
 * was handed in. That distinguishes "this family has no child process" (the
 * absent key above) from "it has one and we cannot see it", which would
 * otherwise read identically to an agent.
 *
 * Which of the two shapes a family gets is chosen at the CALL SITE, not
 * inferred from whether its config happens to carry a `source` field. A fourth
 * family has to say which kind it is.
 */
function childFamilyReport(
  family: ToolFamily,
  config: LspConfig | KernelConfig | Unavailable,
  transport: LspStatus | KernelStatus | undefined,
): FamilyReport {
  if (config.state === "unavailable") return darkFamilyReport(family, config);
  const report: FamilyReport = {
    family,
    state: "available",
    source: config.source,
    transport: transport === undefined ? null : describeTransport(transport),
  };
  // Only the local-repository rung resolves a version, and when it does the
  // operator needs to see WHICH one — "kernel:* is live" is a different claim
  // from "kernel:* is live against 0.10.2 while your project builds 0.11.0".
  return config.artifactVersion === undefined
    ? report
    : { ...report, artifactVersion: config.artifactVersion };
}

function darkFamilyReport(family: ToolFamily, config: Unavailable): FamilyReport {
  return { family, state: "unavailable", reason: config.reason, remedy: config.remedy };
}

/**
 * Summarise a transport's state for the wire.
 *
 * Deliberately does NOT include the launch command, which the transports embed
 * in their own thrown errors. bridge:health already reports `source`, so the
 * command adds nothing here, and keeping it out holds the line the config
 * `reason`/`remedy` strings hold: operator paths belong on stderr. Note this
 * reports strictly less than the family's own tools already return on failure.
 */
function describeTransport(status: LspStatus | KernelStatus): TransportReport {
  const fallback = "lastStartError" in status ? status.lastStartError : status.lastSoftReset;
  return {
    state: status.state,
    lastError: status.closeReason !== null ? describeClose(status.closeReason) : fallback,
  };
}

function describeClose(reason: LspCloseReason | KernelCloseReason): string {
  switch (reason.kind) {
    case "spawn-error":
      return `spawn failed: ${reason.message}`;
    case "exited":
      return `exited (code=${reason.code}, signal=${reason.signal ?? "none"})`;
    case "disposed":
      return "disposed";
  }
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
