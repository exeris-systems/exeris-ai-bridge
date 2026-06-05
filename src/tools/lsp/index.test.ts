import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BridgeConfig } from "../../config/env.js";
import { encodeMessage, LspMessageDecoder } from "../../transport/lsp-framing.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  LspChannel,
  LspClient,
  LspCloseReason,
} from "../../transport/lsp-client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerLspTools } from "./index.js";

const CONFIG: BridgeConfig = {
  docsRoot: "/var/empty/exeris-docs-stub",
  ecosystemRoot: "/var/empty",
  lsp: { command: "lsp-stub", args: [], source: "default" },
};

/** Minimal scriptable channel — answers `initialize`, then defers to `onCall`. */
class FakeChannel implements LspChannel {
  private dataHandler: ((c: Buffer) => void) | null = null;
  private readonly decoder = new LspMessageDecoder();
  constructor(private readonly onCall: (msg: any) => unknown | undefined) {}
  write(chunk: Buffer): void {
    for (const msg of this.decoder.push(chunk) as any[]) {
      const response =
        msg.method === "initialize"
          ? { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }
          : this.onCall(msg);
      if (response !== undefined) this.dataHandler?.(encodeMessage(response));
    }
  }
  onData(handler: (c: Buffer) => void): void {
    this.dataHandler = handler;
  }
  onClose(_handler: (r: LspCloseReason) => void): void {}
  close(): void {}
}

function toolsWith(onCall: (msg: any) => unknown | undefined) {
  const client = new LspClient(CONFIG.lsp, { channelFactory: () => new FakeChannel(onCall) });
  return new Map(registerLspTools(CONFIG, client).map((t) => [t.definition.name, t]));
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

test("registerLspTools registers all three lsp:* tools", () => {
  const names = registerLspTools(CONFIG).map((t) => t.definition.name);
  assert.deepEqual(names.sort(), ["lsp:describe_domain", "lsp:list_actions", "lsp:list_domains"]);
});

test("lsp:list_domains returns the server result as pretty JSON on success", async () => {
  const tools = toolsWith((msg) =>
    msg.method === "workspace/exerisDomains"
      ? { jsonrpc: "2.0", id: msg.id, result: [{ qualifiedName: "com.acme.Order" }] }
      : undefined,
  );
  const res = await tools.get("lsp:list_domains")!.handler({});
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(text(res)), [{ qualifiedName: "com.acme.Order" }]);
});

test("a method-not-found maps to a clear 'not yet supported' result, not a crash", async () => {
  const tools = toolsWith((msg) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" },
  }));
  const res = await tools.get("lsp:list_domains")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /does not implement 'workspace\/exerisDomains' yet/);
  assert.match(text(res), /companion PR in exeris-platform-lsp/);
});

test("a non-method-not-found JSON-RPC error surfaces code and message", async () => {
  const tools = toolsWith((msg) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32602, message: "Invalid params" },
  }));
  const res = await tools.get("lsp:list_actions")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /code -32602/);
  assert.match(text(res), /Invalid params/);
});

test("a transport failure maps to an actionable EXERIS_LSP_COMMAND hint", async () => {
  const client = new LspClient(CONFIG.lsp, {
    channelFactory: () => {
      throw new Error("ENOENT");
    },
  });
  const tools = new Map(registerLspTools(CONFIG, client).map((t) => [t.definition.name, t]));
  const res = await tools.get("lsp:list_domains")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /Set EXERIS_LSP_COMMAND/);
});

test("lsp:describe_domain rejects a missing/blank qualifiedName before any LSP call", async () => {
  let called = false;
  const tools = toolsWith(() => {
    called = true;
    return undefined;
  });
  const res = await tools.get("lsp:describe_domain")!.handler({ qualifiedName: "   " });
  assert.equal(res.isError, true);
  assert.match(text(res), /'qualifiedName' must be a non-empty string/);
  assert.equal(called, false);
});

test("lsp:describe_domain forwards qualifiedName as the request params", async () => {
  let seenParams: unknown;
  const tools = toolsWith((msg) => {
    if (msg.method === "workspace/exerisDomainDescribe") {
      seenParams = msg.params;
      return { jsonrpc: "2.0", id: msg.id, result: { fields: [] } };
    }
    return undefined;
  });
  const res = await tools.get("lsp:describe_domain")!.handler({ qualifiedName: "com.acme.Order" });
  assert.ok(!res.isError);
  assert.deepEqual(seenParams, { qualifiedName: "com.acme.Order" });
});
