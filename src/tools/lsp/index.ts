import type { BridgeConfig, Unavailable } from "../../config/env.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  LspClient,
  LspRequestError,
  LspTransportError,
} from "../../transport/lsp-client.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import {
  LspShapeError,
  parseActionSummaries,
  parseDomainDescription,
  parseDomainSummaries,
  parseMutationPreview,
} from "./shapes.js";

// lsp:* — bridges agent queries to a child exeris-platform-lsp process over
// JSON-RPC (see ../../transport/lsp-client.ts). Exposes @ExerisDomain types,
// their source-model descriptions, @Action signatures, and in-memory mutation
// previews. Results are validated against wire shapes (./shapes.ts). The bridge
// surface is read-only; mutation preview computes diffs in-memory without disk writes.

const METHOD_LIST_DOMAINS = "exeris/domains";
const METHOD_DESCRIBE_DOMAIN = "exeris/domainDescribe";
const METHOD_LIST_ACTIONS = "exeris/actions";
const METHOD_PREVIEW_MUTATION = "exeris/previewMutation";

/**
 * The lsp:* family handle: a client bound to a launch spec, or the structured
 * reason the family is dark. Every tool definition below is built either way —
 * only the handlers are gated (see ../unavailable.ts).
 */
type LspFamily = { readonly state: "available"; readonly client: LspClient } | Unavailable;

export function registerLspTools(config: BridgeConfig, clientOverride?: LspClient): RegisteredTool[] {
  // One client per server process, shared across the family. Construction is
  // cheap and does NOT spawn — the child starts lazily on the first request.
  // An injected client IS a transport, so it overrides config-time
  // unavailability: the test seam must not depend on the environment.
  const handle = resolveLspFamily(config, clientOverride);
  return [
    listDomainsTool(handle),
    describeDomainTool(handle),
    listActionsTool(handle),
    previewMutationTool(handle),
  ];
}

function resolveLspFamily(config: BridgeConfig, clientOverride?: LspClient): LspFamily {
  if (clientOverride !== undefined) {
    return { state: "available", client: clientOverride };
  }
  if (config.lsp.state === "unavailable") {
    return config.lsp;
  }
  return { state: "available", client: new LspClient(config.lsp) };
}

function listDomainsTool(handle: LspFamily): RegisteredTool {
  return {
    definition: {
      name: "lsp-list_domains",
      description: "List all @ExerisDomain types known to the active LSP session.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("lsp", handle, async ({ client }) =>
      callLsp(client, METHOD_LIST_DOMAINS, undefined, parseDomainSummaries),
    ),
  };
}

function describeDomainTool(handle: LspFamily): RegisteredTool {
  return {
    definition: {
      name: "lsp-describe_domain",
      description:
        "Return the source-model description of an @ExerisDomain type: fields, actions, relationships, generated artefacts, and the `sourceDigest` that `lsp-preview_mutation` takes as its concurrency token.",
      inputSchema: {
        type: "object",
        properties: {
          qualifiedName: { type: "string", description: "Fully-qualified Java class name." },
        },
        required: ["qualifiedName"],
      },
    },
    handler: guard("lsp", handle, async ({ client }, args) => {
      const qualifiedName = args.qualifiedName;
      if (typeof qualifiedName !== "string" || qualifiedName.trim().length === 0) {
        return errorResult("Invalid input: 'qualifiedName' must be a non-empty string");
      }
      return callLsp(client, METHOD_DESCRIBE_DOMAIN, { qualifiedName }, parseDomainDescription);
    }),
  };
}

function listActionsTool(handle: LspFamily): RegisteredTool {
  return {
    definition: {
      name: "lsp-list_actions",
      description: "List all @Action methods across the workspace, with their owning @ExerisDomain.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("lsp", handle, async ({ client }) =>
      callLsp(client, METHOD_LIST_ACTIONS, undefined, parseActionSummaries),
    ),
  };
}

function previewMutationTool(handle: LspFamily): RegisteredTool {
  return {
    definition: {
      name: "lsp-preview_mutation",
      description:
        "Preview how the SDK's canonical writer would change an @ExerisDomain source file for one mutation, applied in memory. Returns `{ result, sourcePath, diff }`: a unified diff and the SDK outcome in `result.outcome` — SUCCESS, CONFLICT (the source drifted from the baseline; the result carries baseline, current and intended values), VALIDATION_ERROR, or NO_BASELINE. Nothing is written: apply the diff with your own file tools. For a stale-free preview, pass the entity's last-emitted metadata as `baselineJson` and the `sourceDigest` from `lsp-describe_domain` as `concurrencyToken`.",
      inputSchema: {
        type: "object",
        properties: {
          qualifiedName: {
            type: "string",
            description: "Fully-qualified Java class name of the target domain.",
          },
          op: {
            type: "object",
            description:
              'One SDK MutationOp, discriminated by `op`: addField, removeField, renameField, changeFieldType, addRelationship, removeRelationship, changeRelationshipCardinality, addAction, removeAction. Every op carries a `path`, e.g. {"op":"renameField","path":"/entities/Order/fields/total","newName":"amount"}.',
          },
          baselineJson: {
            type: "string",
            description:
              "The entity's last-emitted `target/classes/exeris-metadata/<entity>.json` (see `build-get_domain_metadata`), as a string. The base of the three-way drift check.",
          },
          concurrencyToken: {
            type: "string",
            description: "The `sourceDigest` returned by `lsp-describe_domain` for this domain.",
          },
        },
        required: ["qualifiedName", "op"],
      },
    },
    handler: guard("lsp", handle, async ({ client }, args) => {
      const qualifiedName = args.qualifiedName;
      if (typeof qualifiedName !== "string" || qualifiedName.trim().length === 0) {
        return errorResult("Invalid input: 'qualifiedName' must be a non-empty string");
      }
      const op = args.op;
      if (typeof op !== "object" || op === null || Array.isArray(op)) {
        return errorResult("Invalid input: 'op' must be an object");
      }
      const params: Record<string, unknown> = {
        qualifiedName,
        op,
      };
      if (args.baselineJson !== undefined) {
        if (typeof args.baselineJson !== "string") {
          return errorResult("Invalid input: 'baselineJson' must be a string");
        }
        params.baselineJson = args.baselineJson;
      }
      if (args.concurrencyToken !== undefined) {
        if (typeof args.concurrencyToken !== "string") {
          return errorResult("Invalid input: 'concurrencyToken' must be a string");
        }
        params.concurrencyToken = args.concurrencyToken;
      }
      return callLsp(client, METHOD_PREVIEW_MUTATION, params, parseMutationPreview);
    }),
  };
}

/**
 * Run a single LSP request, validate the result against its wire shape, and
 * render it as a tool result — mapping the transport's typed failures and any
 * shape mismatch onto actionable agent-facing messages.
 */
async function callLsp<T>(
  client: LspClient,
  method: string,
  params: unknown,
  parse: (result: unknown) => T,
) {
  let result: unknown;
  try {
    result = await client.request(method, params);
  } catch (err) {
    if (err instanceof LspRequestError && err.code === JSONRPC_METHOD_NOT_FOUND) {
      return errorResult(
        `The configured exeris-platform-lsp does not implement '${method}'. ` +
          `The read-only 'exeris/*' slice ships in exeris-platform — update or rebuild ` +
          `the LSP server (EXERIS_LSP_COMMAND) to a build that includes it.`,
      );
    }
    if (err instanceof LspRequestError) {
      return errorResult(`LSP request '${method}' failed (code ${err.code}): ${err.message}`);
    }
    if (err instanceof LspTransportError) {
      return errorResult(
        `${err.message}. Set EXERIS_LSP_COMMAND to point at a runnable exeris-platform-lsp, ` +
          `or start it manually; see README.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected LSP error on '${method}': ${message}`);
  }
  try {
    return ok(JSON.stringify(parse(result), null, 2));
  } catch (err) {
    if (err instanceof LspShapeError) {
      return errorResult(
        `The exeris-platform-lsp response to '${method}' did not match the expected ` +
          `read-only wire shape: ${err.message}. The bridge and the LSP server may be on ` +
          `mismatched versions of the 'exeris/*' contract.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to parse the '${method}' response: ${message}`);
  }
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
