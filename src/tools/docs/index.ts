import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { BridgeConfig } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { RegisteredTool } from "../types.js";
import { parseAdrIndex, type AdrEntry } from "./adr-index.js";

// docs:* — surfaces the exeris-docs ADR registry to AI agents over MCP.
// Filesystem reads route through the path-sandbox (ecosystemRoot) so that
// cross-repo ADR links (../exeris-kernel/..., ../exeris-sdk/..., etc.) work
// without granting the agent access to anything else on disk.

const ADR_INDEX_FILENAME = "adr-index.md";

export function registerDocsTools(config: BridgeConfig): RegisteredTool[] {
  return [
    listAdrsTool(config),
    getAdrTool(config),
  ];
}

function listAdrsTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:list_adrs",
      description:
        "List all ADRs from the Exeris ecosystem registry. Each entry " +
        "carries number, title, owning repo, scope, visibility, status, " +
        "and link. Optional `status` filter narrows the result by the " +
        "first token of the status cell (e.g. 'accepted', 'proposed', " +
        "'superseded', 'reserved').",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Filter to entries whose status.state equals this value " +
              "(case-insensitive; trimmed before comparison).",
          },
        },
      },
    },
    handler: async (args) => {
      const status =
        typeof args.status === "string" ? args.status.trim().toLowerCase() : "";
      let entries: AdrEntry[];
      try {
        entries = readAdrIndex(config);
      } catch (err) {
        return errorResult(describeReadError(err, config));
      }
      if (status.length === 0) {
        return ok(JSON.stringify(entries, null, 2));
      }
      const filtered = entries.filter((e) => e.status.state.toLowerCase() === status);
      // Distinguish "no matches" from a typo'd / stale filter token. Returning
      // [] silently would let an agent conclude "no <status> ADRs exist" on a
      // misspelling. Surface what states ARE present so the agent can correct.
      if (filtered.length === 0 && entries.length > 0) {
        // Filter out empty-string states (parseRow accepts empty status cells);
        // an entry with state='' would otherwise produce ", accepted, proposed"
        // with a leading comma, leaking that incomplete rows exist.
        const present = [
          ...new Set(entries.map((e) => e.status.state).filter((s) => s.length > 0)),
        ].sort((a, b) => a.localeCompare(b));
        return errorResult(
          `No ADRs in the registry have status='${status}'. ` +
            `Known states in the current registry: ${present.join(", ")}.`,
        );
      }
      return ok(JSON.stringify(filtered, null, 2));
    },
  };
}

function getAdrTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:get_adr",
      description:
        "Fetch the full markdown body of a specific ADR by number. " +
        "Resolves the link from the registry against the ecosystem root, " +
        "so cross-repo ADRs (those whose content lives in a sibling repo) " +
        "are read from their authoritative source.",
      inputSchema: {
        type: "object",
        properties: {
          number: {
            type: "integer",
            description: "ADR number (e.g. 24 for ADR-024).",
            minimum: 1,
          },
        },
        required: ["number"],
      },
    },
    handler: async (args) => {
      if (typeof args.number !== "number" || !Number.isInteger(args.number)) {
        return errorResult(
          `Invalid input: 'number' must be an integer, got ${typeof args.number}`,
        );
      }
      const number = args.number;
      // inputSchema declares minimum:1 but the MCP framework doesn't always
      // validate it at the boundary — guard at runtime so 0 / negatives can't
      // reach pad() and produce malformed 'ADR-0-1' / 'ADR-000' messages.
      if (number < 1) {
        return errorResult(
          `Invalid input: 'number' must be ≥ 1, got ${number}`,
        );
      }

      let entries: AdrEntry[];
      try {
        entries = readAdrIndex(config);
      } catch (err) {
        return errorResult(describeReadError(err, config));
      }

      const entry = entries.find((e) => e.number === number);
      if (!entry) {
        return errorResult(`ADR-${pad(number)} is not in the registry`);
      }
      if (!entry.link) {
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") has no link in the registry ` +
            `(status: ${entry.status.raw}). The content is not yet authored.`,
        );
      }

      // Empty / whitespace-only target would resolve to docsRoot itself
      // via path.join and emit a misleading EISDIR error echoing the absolute
      // docsRoot path back to the agent.
      const trimmedTarget = entry.link.target.trim();
      if (trimmedTarget.length === 0) {
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") has an empty link target in the registry.`,
        );
      }

      const joined = join(config.docsRoot, trimmedTarget);
      let resolved: string;
      try {
        resolved = resolveInside(config.ecosystemRoot, joined);
      } catch (err) {
        if (err instanceof SandboxEscapeError) {
          // resolved!=null on the SandboxEscapeError means realpath SUCCEEDED
          // and the resolved path lies outside the ecosystem — a real escape
          // (e.g. a symlink to /etc/passwd). resolved===null means realpath
          // failed (file or parent missing), which is the benign
          // "enterprise-private not in checkout" / "stale link" case.
          // Lexical-only check would mask a symlink-based escape — use the
          // error's structured field instead.
          if (err.resolved === null) {
            return errorResult(missingContentMessage(entry, config, joined));
          }
          return errorResult(
            `ADR-${entry.numberPadded} link target escapes the ecosystem sandbox: ` +
              `${entry.link.target}`,
          );
        }
        throw err;
      }

      let body: string;
      try {
        body = readFileSync(resolved, "utf8");
      } catch (err) {
        // err.message embeds the absolute file path (e.g.
        // "EACCES: permission denied, open '/abs/path/file.md'") — redact
        // before composing the user-facing message so the absolute path
        // doesn't appear in the trailing reason after the relativized prefix.
        const reason = redactEcosystemPaths(
          err instanceof Error ? err.message : String(err),
          config,
        );
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") link resolves to ` +
            `${relativizeToEcosystem(config, resolved)}, ` +
            `but the file could not be read: ${reason}.`,
        );
      }

      return ok(body);
    },
  };
}

function readAdrIndex(config: BridgeConfig): AdrEntry[] {
  const indexPath = resolveInside(config.ecosystemRoot, join(config.docsRoot, ADR_INDEX_FILENAME));
  const raw = readFileSync(indexPath, "utf8");
  return parseAdrIndex(raw);
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

/**
 * Render an absolute path relative to ecosystemRoot for user-facing messages.
 * Avoids leaking operator $HOME / install layout. Note: a `..`-prefixed
 * result still reveals the climb depth (e.g. `../../something`) — that's
 * structural information about how deep ecosystemRoot sits in the operator's
 * filesystem. Accepted trade-off: post-sandbox paths shouldn't reach this
 * function with `..` prefixes, so the depth-leak is a degraded-state hint
 * for an unexpected code path, not the primary surface.
 */
function relativizeToEcosystem(config: BridgeConfig, absPath: string): string {
  const rel = relative(config.ecosystemRoot, absPath);
  // Empty rel = absPath IS ecosystemRoot itself — return "." rather than the
  // absolute root path.
  if (rel === "") return ".";
  return rel;
}

/**
 * Strip the ecosystemRoot absolute prefix from a free-form message and
 * substitute `<ecosystem>`. Anchored on a trailing path separator so a
 * non-boundary prefix doesn't over-replace — e.g. ecosystemRoot=/home/u/dev
 * must not substitute inside /home/u/development/foo.
 *
 * SCOPE: this helper only redacts ecosystem-rooted paths. Errors that embed
 * absolute paths from OUTSIDE the ecosystem (currently unreachable in this
 * codebase — every read goes through resolveInside) are not stripped.
 * Defence-in-depth (regex-redact any `/path/to/file.md`) is deliberately
 * not added here; it would have false positives and a wider blast radius.
 */
export function redactEcosystemPaths(message: string, config: BridgeConfig): string {
  const anchor = config.ecosystemRoot + sep;
  return message.split(anchor).join("<ecosystem>" + sep);
}

/**
 * Format the operator-debug stderr line carrying SandboxEscape structured
 * fields. JSON-serialized so control characters in agent-reachable fields
 * (decoded `%0A` newline, `%1B` ESC, `%07` BEL from a poisoned registry
 * link target) can't forge log lines or inject ANSI escapes. The output
 * is a single-line JSON object suitable for log scrapers.
 */
export function formatSandboxStderrLine(err: SandboxEscapeError): string {
  return (
    JSON.stringify({
      level: "error",
      component: "exeris-ai-bridge",
      event: "SandboxEscape",
      root: err.root,
      candidate: err.candidate,
      resolved: err.resolved,
    }) + "\n"
  );
}

/**
 * Compose a user-facing message for a registry-read failure without leaking
 * absolute paths. SandboxEscapeError's .message is intentionally path-free;
 * other errors (ENOENT from readFileSync, parser throws) may carry paths in
 * their message string, so those branches go through redactEcosystemPaths.
 *
 * Side effect: writes a JSON-serialised stderr line carrying the absolute
 * paths for operator debugging. Wire-facing message stays sanitized. This
 * is a placeholder for 0.7.0 observability; until then it gives operators
 * SOMETHING actionable when a sandbox error happens.
 */
function describeReadError(err: unknown, config: BridgeConfig): string {
  if (err instanceof SandboxEscapeError) {
    process.stderr.write(formatSandboxStderrLine(err));
    return err.resolved === null
      ? "Failed to read adr-index.md: file not found in the configured docs root"
      : "Failed to read adr-index.md: resolved path is outside the ecosystem sandbox";
  }
  const raw = err instanceof Error ? err.message : String(err);
  return `Failed to read adr-index.md: ${redactEcosystemPaths(raw, config)}`;
}

function missingContentMessage(entry: AdrEntry, config: BridgeConfig, joined: string): string {
  const hint =
    entry.visibility === "enterprise-private"
      ? "This is an enterprise-private ADR; its content may not be available in this checkout."
      : "Check that the cross-repo sibling is present alongside exeris-docs.";
  return (
    `ADR-${entry.numberPadded} ("${entry.title}") link target ` +
    `${relativizeToEcosystem(config, joined)} could not be resolved on disk. ${hint}`
  );
}
