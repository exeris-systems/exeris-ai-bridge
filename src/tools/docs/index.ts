import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
              "(case-insensitive).",
          },
        },
      },
    },
    handler: async (args) => {
      const status = typeof args.status === "string" ? args.status.toLowerCase() : null;
      let entries: AdrEntry[];
      try {
        entries = readAdrIndex(config);
      } catch (err) {
        return errorResult(`Failed to read adr-index.md: ${(err as Error).message}`);
      }
      const filtered = status
        ? entries.filter((e) => e.status.state.toLowerCase() === status)
        : entries;
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      };
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
        return errorResult(`Invalid input: 'number' must be an integer, got ${typeof args.number}`);
      }
      const number = args.number;

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

      const joined = join(config.docsRoot, entry.link.target);
      let resolved: string;
      try {
        resolved = resolveInside(config.ecosystemRoot, joined);
      } catch (err) {
        if (err instanceof SandboxEscapeError) {
          // Distinguish a real escape from "lexically inside the sandbox but
          // the file/parent isn't on disk" — the latter is the common case
          // for enterprise-private content or a missing sibling checkout.
          if (isLexicallyInside(config.ecosystemRoot, joined)) {
            return errorResult(missingContentMessage(entry, joined));
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
          `ADR-${entry.numberPadded} ("${entry.title}") link resolves to ${resolved}, ` +
            `but the file could not be read: ${(err as Error).message}.`,
        );
      }

      return {
        content: [{ type: "text", text: body }],
      };
    },
  };
}

function readAdrIndex(config: BridgeConfig): AdrEntry[] {
  const indexPath = resolveInside(config.ecosystemRoot, join(config.docsRoot, ADR_INDEX_FILENAME));
  const raw = readFileSync(indexPath, "utf8");
  return parseAdrIndex(raw);
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

function isLexicallyInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function missingContentMessage(entry: AdrEntry, joined: string): string {
  const hint =
    entry.visibility === "enterprise-private"
      ? "This is an enterprise-private ADR; its content may not be available in this checkout."
      : "Check that the cross-repo sibling is present alongside exeris-docs.";
  return (
    `ADR-${entry.numberPadded} ("${entry.title}") link target ${joined} ` +
    `could not be resolved on disk. ${hint}`
  );
}
