import type {
  BridgeConfig,
  DocsConfig,
  KernelConfig,
  LspConfig,
  ToolFamily,
  Unavailable,
} from "../../config/env.js";
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
): RegisteredTool[] {
  return [versionTool(config), healthTool(config, transports)];
}

// ---------------------------------------------------------------------------
// bridge:version

function versionTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "bridge:version",
      description:
        "Identify this MCP server: package name and version, the Node runtime it " +
        "is running on, and which persona mode it resolved to. Use it to confirm " +
        "which bridge build an answer came from.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () =>
      ok({
        name: "exeris-ai-bridge",
        version: getServerVersion(),
        node: process.version,
        mode: config.mode,
        modeSource: config.modeSource,
      }),
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
  return {
    family,
    state: "available",
    source: config.source,
    transport: transport === undefined ? null : describeTransport(transport),
  };
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
