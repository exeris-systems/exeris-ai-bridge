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
} from "./shapes.js";

// lsp:* — bridges agent queries to a child exeris-platform-lsp process over
// JSON-RPC (see ../../transport/lsp-client.ts). Exposes @ExerisDomain types,
// their source-model descriptions, and @Action signatures.
//
// Phase 3a (ROADMAP 0.3.0) shipped the transport, discovery, and resilient
// error model. The companion read-only `exeris/*` slice now exists in
// exeris-platform-lsp (the three requests below); each result is validated
// against its wire shape (./shapes.ts) before being returned. A server that
// predates the slice answers "method not found", which we translate into a
// clear "update the LSP server" result rather than a crash. The bridge
// surface — tool names and input schemas — is final and read-only; the
// write-back method (`exeris/applyMutation`) is deliberately NOT consumed
// (ADR-025 §"no mutation of kernel state" generalises to no mutation, period).

const METHOD_LIST_DOMAINS = "exeris/domains";
const METHOD_DESCRIBE_DOMAIN = "exeris/domainDescribe";
const METHOD_LIST_ACTIONS = "exeris/actions";

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
  return [listDomainsTool(handle), describeDomainTool(handle), listActionsTool(handle)];
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
        "Return the source-model description of an @ExerisDomain type: fields, actions, generated artefacts.",
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
