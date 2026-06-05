import type { BridgeConfig } from "../../config/env.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  LspClient,
  LspRequestError,
  LspTransportError,
} from "../../transport/lsp-client.js";
import type { RegisteredTool } from "../types.js";

// lsp:* — bridges agent queries to a child exeris-platform-lsp process over
// JSON-RPC (see ../../transport/lsp-client.ts). Exposes @ExerisDomain types,
// their source-model descriptions, and @Action signatures.
//
// Phase 3a (ROADMAP 0.3.0) ships the transport, discovery, and resilient
// error model. The three custom requests below do NOT yet exist in
// exeris-platform-lsp (that module is currently a skeleton); a companion PR
// adds them. Until then, a live call reaches the server and comes back as a
// JSON-RPC "method not found", which we translate into a clear "not yet
// supported" tool result rather than a crash. The bridge surface — tool
// names and input schemas — is final, so agents and tests can wire against
// it today.

const METHOD_LIST_DOMAINS = "workspace/exerisDomains";
const METHOD_DESCRIBE_DOMAIN = "workspace/exerisDomainDescribe";
const METHOD_LIST_ACTIONS = "workspace/exerisActions";

export function registerLspTools(config: BridgeConfig, clientOverride?: LspClient): RegisteredTool[] {
  // One client per server process, shared across the family. Construction is
  // cheap and does NOT spawn — the child starts lazily on the first request.
  const client = clientOverride ?? new LspClient(config.lsp);
  return [listDomainsTool(client), describeDomainTool(client), listActionsTool(client)];
}

function listDomainsTool(client: LspClient): RegisteredTool {
  return {
    definition: {
      name: "lsp:list_domains",
      description: "List all @ExerisDomain types known to the active LSP session.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => callLsp(client, METHOD_LIST_DOMAINS),
  };
}

function describeDomainTool(client: LspClient): RegisteredTool {
  return {
    definition: {
      name: "lsp:describe_domain",
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
    handler: async (args) => {
      const qualifiedName = args.qualifiedName;
      if (typeof qualifiedName !== "string" || qualifiedName.trim().length === 0) {
        return errorResult("Invalid input: 'qualifiedName' must be a non-empty string");
      }
      return callLsp(client, METHOD_DESCRIBE_DOMAIN, { qualifiedName });
    },
  };
}

function listActionsTool(client: LspClient): RegisteredTool {
  return {
    definition: {
      name: "lsp:list_actions",
      description: "List all @Action methods across the workspace, with their owning @ExerisDomain.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => callLsp(client, METHOD_LIST_ACTIONS),
  };
}

/**
 * Run a single LSP request and render it as a tool result, mapping the
 * transport's typed failures onto actionable agent-facing messages.
 */
async function callLsp(client: LspClient, method: string, params?: unknown) {
  try {
    const result = await client.request(method, params);
    return ok(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof LspRequestError && err.code === JSONRPC_METHOD_NOT_FOUND) {
      return errorResult(
        `The configured exeris-platform-lsp does not implement '${method}' yet. ` +
          `The bridge transport is ready (Phase 3a); this request lands with the ` +
          `ROADMAP 0.3.0 companion PR in exeris-platform-lsp.`,
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
