import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
      const rawStatus = typeof args.status === "string" ? args.status : null;
      const status = rawStatus !== null ? rawStatus.trim().toLowerCase() : null;
      let entries: AdrEntry[];
      try {
        entries = readAdrIndex(config);
      } catch (err) {
        return errorResult(`Failed to read adr-index.md: ${(err as Error).message}`);
      }
      if (status === null || status.length === 0) {
        return ok(JSON.stringify(entries, null, 2));
      }
      const filtered = entries.filter((e) => e.status.state.toLowerCase() === status);
      // Distinguish "no matches" from a typo'd / stale filter token. Returning
      // [] silently would let an agent conclude "no <status> ADRs exist" on a
      // misspelling. Surface what states ARE present so the agent can correct.
      if (filtered.length === 0 && entries.length > 0) {
        const present = [...new Set(entries.map((e) => e.status.state))].sort();
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
        return errorResult(`Failed to read adr-index.md: ${(err as Error).message}`);
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
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") link resolves to ` +
            `${relativizeToEcosystem(config, resolved)}, ` +
            `but the file could not be read: ${(err as Error).message}.`,
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
 * Render an absolute path relative to ecosystemRoot for user-facing
 * messages. Avoids leaking operator $HOME / install layout to the agent.
 * Absolute paths still flow through structured logs (when those land) for
 * operator debugging.
 */
function relativizeToEcosystem(config: BridgeConfig, absPath: string): string {
  const rel = relative(config.ecosystemRoot, absPath);
  if (rel === "" || rel.startsWith("..")) return absPath;
  return rel;
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
