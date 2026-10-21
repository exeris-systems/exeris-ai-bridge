import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BridgeConfig, LspConfig } from "../../config/env.js";
import { encodeMessage, LspMessageDecoder } from "../../transport/lsp-framing.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  LspChannel,
  LspClient,
  LspCloseReason,
} from "../../transport/lsp-client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerLspTools } from "./index.js";

const LSP_SPEC: LspConfig = {
  state: "available",
  command: "lsp-stub",
  args: [],
  source: "source-tree",
  workspaceRoot: "/var/empty",
};

const CONFIG: BridgeConfig = {
  mode: "contributor",
  modeSource: "default",
  ecosystemRoot: "/var/empty",
  docs: { state: "available", source: "checkout", docsRoot: "/var/empty/exeris-docs-stub", ecosystemRoot: "/var/empty" },
  lsp: LSP_SPEC,
  kernel: { state: "available", command: "kernel-stub", args: [], source: "source-tree" },
  project: { state: "available", projectRoot: "/var/empty/project", source: "env" },
};

/** The same config with no launch spec for the LSP — the zero-checkout shape. */
const DARK_CONFIG: BridgeConfig = {
  ...CONFIG,
  lsp: { state: "unavailable", reason: "no launch spec (test)", remedy: "set EXERIS_LSP_COMMAND (test)" },
};

/** Minimal JSON-RPC request shape the FakeChannel scripts against. */
interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

/** Minimal scriptable channel — answers `initialize`, then defers to `onCall`. */
class FakeChannel implements LspChannel {
  private dataHandler: ((c: Buffer) => void) | null = null;
  private readonly decoder = new LspMessageDecoder();
  constructor(private readonly onCall: (msg: RpcRequest) => unknown) {}
  write(chunk: Buffer): void {
    for (const msg of this.decoder.push(chunk) as RpcRequest[]) {
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

function toolsWith(onCall: (msg: RpcRequest) => unknown) {
  const client = new LspClient(LSP_SPEC, { channelFactory: () => new FakeChannel(onCall) });
  return new Map(registerLspTools(CONFIG, client).map((t) => [t.definition.name, t]));
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

test("registerLspTools registers all four lsp-* tools", () => {
  const names = registerLspTools(CONFIG).map((t) => t.definition.name);
  assert.deepEqual(
    names.sort((a, b) => a.localeCompare(b)),
    ["lsp-describe_domain", "lsp-list_actions", "lsp-list_domains", "lsp-preview_mutation"],
  );
});

const DOMAIN_SUMMARY = {
  qualifiedName: "com.acme.Order",
  simpleName: "Order",
  packageName: "com.acme",
  sourcePath: "/ws/com/acme/Order.java",
};

test("lsp-list_domains returns the validated DomainSummary[] as pretty JSON on success", async () => {
  const tools = toolsWith((msg) =>
    msg.method === "exeris/domains"
      ? { jsonrpc: "2.0", id: msg.id, result: [DOMAIN_SUMMARY] }
      : undefined,
  );
  const res = await tools.get("lsp-list_domains")!.handler({});
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(text(res)), [DOMAIN_SUMMARY]);
});

test("lsp-list_domains surfaces a shape mismatch as a clear error, not a crash", async () => {
  const tools = toolsWith((msg) =>
    msg.method === "exeris/domains"
      ? { jsonrpc: "2.0", id: msg.id, result: [{ qualifiedName: "com.acme.Order" }] }
      : undefined,
  );
  const res = await tools.get("lsp-list_domains")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /did not match the expected read-only wire shape/);
  assert.match(text(res), /domains\[0\]\.simpleName must be a string/);
});

test("a method-not-found maps to a clear 'update the LSP server' result, not a crash", async () => {
  const tools = toolsWith((msg) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" },
  }));
  const res = await tools.get("lsp-list_domains")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /does not implement 'exeris\/domains'/);
  assert.match(text(res), /update or rebuild/);
});

test("lsp-list_actions returns the validated ActionSummary[] as pretty JSON on success", async () => {
  const actions = [
    {
      owningDomain: "com.acme.Order",
      name: "submit",
      httpMethod: "POST",
      resultType: "void",
      params: [{ name: "note", type: "String", required: false }],
    },
  ];
  const tools = toolsWith((msg) =>
    msg.method === "exeris/actions" ? { jsonrpc: "2.0", id: msg.id, result: actions } : undefined,
  );
  const res = await tools.get("lsp-list_actions")!.handler({});
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(text(res)), actions);
});

test("a non-method-not-found JSON-RPC error surfaces code and message", async () => {
  const tools = toolsWith((msg) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32602, message: "Invalid params" },
  }));
  const res = await tools.get("lsp-list_actions")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /code -32602/);
  assert.match(text(res), /Invalid params/);
});

test("a transport failure maps to an actionable EXERIS_LSP_COMMAND hint", async () => {
  const client = new LspClient(LSP_SPEC, {
    channelFactory: () => {
      throw new Error("ENOENT");
    },
  });
  const tools = new Map(registerLspTools(CONFIG, client).map((t) => [t.definition.name, t]));
  const res = await tools.get("lsp-list_domains")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /Set EXERIS_LSP_COMMAND/);
});

test("lsp-describe_domain rejects a missing/blank qualifiedName before any LSP call", async () => {
  let called = false;
  const tools = toolsWith(() => {
    called = true;
    return undefined;
  });
  const res = await tools.get("lsp-describe_domain")!.handler({ qualifiedName: "   " });
  assert.equal(res.isError, true);
  assert.match(text(res), /'qualifiedName' must be a non-empty string/);
  assert.equal(called, false);
});

test("lsp-describe_domain forwards qualifiedName and validates the DomainDescription", async () => {
  let seenParams: unknown;
  const description = {
    ...DOMAIN_SUMMARY,
    fields: [{ name: "total", type: "BigDecimal", required: true }],
    actions: [
      {
        name: "submit",
        httpMethod: "POST",
        resultType: "void",
        params: [{ name: "note", type: "String", required: false }],
      },
    ],
    artefacts: ["rest", "events"],
  };
  const tools = toolsWith((msg) => {
    if (msg.method === "exeris/domainDescribe") {
      seenParams = msg.params;
      return { jsonrpc: "2.0", id: msg.id, result: description };
    }
    return undefined;
  });
  const res = await tools.get("lsp-describe_domain")!.handler({ qualifiedName: "com.acme.Order" });
  assert.ok(!res.isError);
  assert.deepEqual(seenParams, { qualifiedName: "com.acme.Order" });
  assert.deepEqual(JSON.parse(text(res)), description);
});

test("lsp-describe_domain forwards relationships and sourceDigest facets", async () => {
  const descriptionWithFacets = {
    ...DOMAIN_SUMMARY,
    fields: [{ name: "total", type: "BigDecimal", required: true }],
    actions: [],
    artefacts: [],
    relationships: [
      { name: "items", targetEntity: "OrderItem", type: "ONE_TO_MANY" },
      { name: "customer", targetEntity: "Customer", type: null },
    ],
    sourceDigest: "sha256:1234567890abcdef",
  };
  const tools = toolsWith((msg) => {
    if (msg.method === "exeris/domainDescribe") {
      return { jsonrpc: "2.0", id: msg.id, result: descriptionWithFacets };
    }
    return undefined;
  });
  const res = await tools.get("lsp-describe_domain")!.handler({ qualifiedName: "com.acme.Order" });
  assert.ok(!res.isError);
  const parsed = JSON.parse(text(res));
  assert.deepEqual(parsed.relationships, [
    { name: "items", targetEntity: "OrderItem", type: "ONE_TO_MANY" },
    { name: "customer", targetEntity: "Customer", type: null },
  ]);
  assert.equal(parsed.sourceDigest, "sha256:1234567890abcdef");
});

test("lsp-describe_domain preserves absent vs empty relationships invariant", async () => {
  // Empty relationships array
  const toolsEmpty = toolsWith((msg) => {
    if (msg.method === "exeris/domainDescribe") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          ...DOMAIN_SUMMARY,
          fields: [],
          actions: [],
          artefacts: [],
          relationships: [],
        },
      };
    }
    return undefined;
  });
  const resEmpty = await toolsEmpty.get("lsp-describe_domain")!.handler({ qualifiedName: "com.acme.Order" });
  assert.ok(!resEmpty.isError);
  assert.deepEqual(JSON.parse(text(resEmpty)).relationships, []);

  // Absent relationships (omitted)
  const toolsAbsent = toolsWith((msg) => {
    if (msg.method === "exeris/domainDescribe") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          ...DOMAIN_SUMMARY,
          fields: [],
          actions: [],
          artefacts: [],
        },
      };
    }
    return undefined;
  });
  const resAbsent = await toolsAbsent.get("lsp-describe_domain")!.handler({ qualifiedName: "com.acme.Order" });
  assert.ok(!resAbsent.isError);
  const parsedAbsent = JSON.parse(text(resAbsent));
  assert.equal(parsedAbsent.relationships, undefined);
  assert.equal("relationships" in parsedAbsent, false);
});


test("lsp-* is dark when config resolved no launch spec", async () => {
  const tools = new Map(registerLspTools(DARK_CONFIG).map((t) => [t.definition.name, t]));
  for (const [name, tool] of tools) {
    const res = await tool.handler({});
    assert.equal(res.isError, true, name);
    const payload = JSON.parse(text(res));
    assert.equal(payload.error, "family_unavailable", name);
    assert.equal(payload.family, "lsp", name);
    assert.equal(payload.reason, "no launch spec (test)", name);
  }
});

test("an injected client overrides config-time unavailability", async () => {
  // The test seam must not depend on the environment: a caller that hands in a
  // transport has, by definition, supplied what config resolution could not.
  const client = new LspClient(LSP_SPEC, {
    channelFactory: () =>
      new FakeChannel((msg) =>
        msg.method === "exeris/domains" ? { jsonrpc: "2.0", id: msg.id, result: [] } : undefined,
      ),
  });
  const tools = new Map(registerLspTools(DARK_CONFIG, client).map((t) => [t.definition.name, t]));
  const res = await tools.get("lsp-list_domains")!.handler({});
  assert.ok(!res.isError, text(res));
});

test("lsp-preview_mutation rejects missing/blank qualifiedName before any LSP call", async () => {
  let called = false;
  const tools = toolsWith(() => {
    called = true;
    return undefined;
  });
  const res = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "   ",
    op: { op: "removeField", path: "/entities/Order/fields/code" },
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /'qualifiedName' must be a non-empty string/);
  assert.equal(called, false);
});

test("lsp-preview_mutation rejects missing/non-object op before any LSP call", async () => {
  let called = false;
  const tools = toolsWith(() => {
    called = true;
    return undefined;
  });
  const resNull = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op: null,
  });
  assert.equal(resNull.isError, true);
  assert.match(text(resNull), /'op' must be an object/);

  const resString = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op: "removeField",
  });
  assert.equal(resString.isError, true);
  assert.match(text(resString), /'op' must be an object/);
  assert.equal(called, false);
});

test("lsp-preview_mutation rejects non-string baselineJson or concurrencyToken", async () => {
  const tools = toolsWith(() => undefined);
  const resBase = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op: { op: "removeField", path: "/entities/Order/fields/code" },
    baselineJson: 1234,
  });
  assert.equal(resBase.isError, true);
  assert.match(text(resBase), /'baselineJson' must be a string/);

  const resTok = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op: { op: "removeField", path: "/entities/Order/fields/code" },
    concurrencyToken: {},
  });
  assert.equal(resTok.isError, true);
  assert.match(text(resTok), /'concurrencyToken' must be a string/);
});

test("lsp-preview_mutation forwards all parameters and returns parsed MutationPreview", async () => {
  let seenParams: unknown;
  const previewResult = {
    result: { outcome: "SUCCESS", path: "/entities/Order/fields/note" },
    sourcePath: "file:///workspace/src/main/java/com/acme/Order.java",
    diff: "--- a/Order.java\n+++ b/Order.java\n@@ -1 +1,2 @@\n+private String note;",
  };
  const tools = toolsWith((msg) => {
    if (msg.method === "exeris/previewMutation") {
      seenParams = msg.params;
      return { jsonrpc: "2.0", id: msg.id, result: previewResult };
    }
    return undefined;
  });

  const res = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op: { op: "addField", path: "/entities/Order/fields/note", field: { name: "note", type: "String" } },
    baselineJson: '{"entity":"Order"}',
    concurrencyToken: "sha256:abcd",
  });

  assert.ok(!res.isError);
  assert.deepEqual(seenParams, {
    qualifiedName: "com.acme.Order",
    op: { op: "addField", path: "/entities/Order/fields/note", field: { name: "note", type: "String" } },
    baselineJson: '{"entity":"Order"}',
    concurrencyToken: "sha256:abcd",
  });
  assert.deepEqual(JSON.parse(text(res)), previewResult);
});

test("lsp-preview_mutation asserts idempotence: identical op returns identical diff", async () => {
  const op = { op: "addField", path: "/entities/Order/fields/status", field: { name: "status", type: "String" } };
  const previewResult = {
    result: { outcome: "SUCCESS", path: "/entities/Order/fields/note" },
    sourcePath: "file:///workspace/src/main/java/com/acme/Order.java",
    diff: "--- a/Order.java\n+++ b/Order.java\n@@ -2 +2,2 @@\n+private String status;",
  };

  const tools = toolsWith((msg) => {
    if (msg.method === "exeris/previewMutation") {
      return { jsonrpc: "2.0", id: msg.id, result: previewResult };
    }
    return undefined;
  });

  const res1 = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op,
    concurrencyToken: "sha256:1111",
  });
  const res2 = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op,
    concurrencyToken: "sha256:1111",
  });

  assert.ok(!res1.isError);
  assert.ok(!res2.isError);
  assert.deepEqual(JSON.parse(text(res1)), JSON.parse(text(res2)));
  assert.equal(JSON.parse(text(res1)).diff, previewResult.diff);
});

test("lsp-preview_mutation asserts idempotence: already-applied op returns empty diff", async () => {
  const op = { op: "addField", path: "/entities/Order/fields/status", field: { name: "status", type: "String" } };
  const noopResult = {
    result: { outcome: "SUCCESS", path: "/entities/Order/fields/status" },
    sourcePath: "file:///workspace/src/main/java/com/acme/Order.java",
    diff: "",
  };

  const tools = toolsWith((msg) => {
    if (msg.method === "exeris/previewMutation") {
      return { jsonrpc: "2.0", id: msg.id, result: noopResult };
    }
    return undefined;
  });

  const res = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op,
    concurrencyToken: "sha256:2222",
  });

  assert.ok(!res.isError);
  const parsed = JSON.parse(text(res));
  assert.equal(parsed.result.outcome, "SUCCESS");
  assert.equal(parsed.diff, "");
});

// One result per non-SUCCESS MutationResult variant, in the SDK's wire shape.
const NON_SUCCESS_RESULTS = [
  {
    outcome: "CONFLICT",
    path: "/entities/Order/fields/total",
    baselineValue: "BigDecimal",
    currentValue: "Long",
    intendedValue: "String",
  },
  { outcome: "VALIDATION_ERROR", path: "/entities/Order/fields/missing", message: "no such field" },
  { outcome: "NO_BASELINE", cause: "MISSING_BASELINE", detail: "no exeris-metadata/Order.json" },
  { outcome: "NO_BASELINE", cause: "STALE_DIGEST", detail: "sourceDigest does not match" },
];

test("lsp-preview_mutation surfaces non-SUCCESS outcomes without collapsing NO_BASELINE", async () => {
  for (const result of NON_SUCCESS_RESULTS) {
    const outcome = result.outcome;
    const errorOutcomeResult = {
      result,
      sourcePath: null,
      diff: "",
    };

    const tools = toolsWith((msg) => {
      if (msg.method === "exeris/previewMutation") {
        return { jsonrpc: "2.0", id: msg.id, result: errorOutcomeResult };
      }
      return undefined;
    });

    const res = await tools.get("lsp-preview_mutation")!.handler({
      qualifiedName: "com.acme.Order",
      op: { op: "removeField", path: "/entities/Order/fields/missing" },
    });

    assert.ok(!res.isError);
    const parsed = JSON.parse(text(res));
    assert.equal(parsed.result.outcome, outcome);
    assert.deepEqual(parsed.result, result);
    assert.equal(parsed.diff, "");
    assert.equal(parsed.sourcePath, null);
  }
});

test("lsp-preview_mutation surfaces method not found when server does not implement previewMutation", async () => {
  const tools = toolsWith((msg) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" },
  }));

  const res = await tools.get("lsp-preview_mutation")!.handler({
    qualifiedName: "com.acme.Order",
    op: { op: "removeField", path: "/entities/Order/fields/code" },
  });

  assert.equal(res.isError, true);
  assert.match(text(res), /does not implement 'exeris\/previewMutation'/);
  assert.match(text(res), /update or rebuild the LSP server/);
});

