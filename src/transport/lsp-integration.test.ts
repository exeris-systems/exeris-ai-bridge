import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig, LspConfig } from "../config/env.js";
import { registerLspTools } from "../tools/lsp/index.js";
import { LspClient } from "./lsp-client.js";

// The transports are injected below, so config-time availability is moot —
// every family is left dark to make that explicit: an injected client/adapter
// IS the transport and overrides what config resolution found (or didn't).
const NOT_UNDER_TEST = {
  state: "unavailable" as const,
  reason: "not under test",
  remedy: "not under test",
};

const DARK_CONFIG: BridgeConfig = {
  mode: "app",
  modeSource: "probe",
  ecosystemRoot: null,
  docs: NOT_UNDER_TEST,
  lsp: NOT_UNDER_TEST,
  kernel: NOT_UNDER_TEST,
};

// End-to-end integration test for the lsp:* family against a REAL
// exeris-platform-lsp server — the one open item closing ROADMAP 0.3.0. It
// spawns the server over the same stdio JSON-RPC path production uses, points
// it at a throwaway workspace holding a single @ExerisDomain source, and
// asserts all three tools return the validated wire shapes.
//
// Opt-in: the bridge's own CI does not carry a JVM toolchain, so this is gated
// on EXERIS_LSP_IT=1 AND EXERIS_LSP_COMMAND pointing at a runnable server, e.g.
//
//   EXERIS_LSP_IT=1 \
//   EXERIS_LSP_COMMAND="mvn -q -f /abs/exeris-platform/exeris-platform-lsp/pom.xml exec:java" \
//   npm run build && (cd dist && node --test transport/lsp-integration.test.js)
//
// It also empirically confirms (or retires) the `exec:java`-shares-stdout
// caveat: if Maven leaked logging onto the JSON-RPC stdout, the handshake would
// fail with an LspFramingError instead of returning data.

const command = process.env.EXERIS_LSP_COMMAND?.trim();
const skip = !process.env.EXERIS_LSP_IT
  ? "set EXERIS_LSP_IT=1 (and EXERIS_LSP_COMMAND) to run the live LSP integration test"
  : !command
    ? "EXERIS_LSP_COMMAND must point at a runnable exeris-platform-lsp"
    : false;

// JVM + Maven cold start is slow; give the first (lazy-spawn) request plenty of room.
const REQUEST_TIMEOUT_MS = 90_000;

const ORDER_SOURCE = `package com.example.shop;

import eu.exeris.sdk.annotations.Action;
import eu.exeris.sdk.annotations.ActionParam;
import eu.exeris.sdk.annotations.ExerisDomain;
import eu.exeris.sdk.annotations.Field;

@ExerisDomain(name = "Order", restApi = true, graphqlApi = true)
public class Order {

    @Field(required = true)
    private String code;

    private double total;

    @Action(httpMethod = "POST")
    public void submit(@ActionParam(required = true) String reason) {
    }
}
`;

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

// Returns `any` so assertions can index the decoded payload directly (test-only).
function parseJson(res: CallToolResult): any {
  const raw = text(res);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`tool returned non-JSON (isError=${res.isError}): ${raw}`);
  }
}

test(
  "lsp:* tools return validated data from a real exeris-platform-lsp over stdio",
  { skip, timeout: REQUEST_TIMEOUT_MS + 30_000 },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "exeris-lsp-it-"));
    mkdirSync(join(workspace, "com", "example", "shop"), { recursive: true });
    writeFileSync(join(workspace, "com", "example", "shop", "Order.java"), ORDER_SOURCE);

    const tokens = command!.split(/\s+/);
    const config: LspConfig = {
      state: "available",
      command: tokens[0],
      args: tokens.slice(1),
      source: "env-command",
      workspaceRoot: workspace,
    };
    // Own the client so we can dispose() the child JVM in the finally block.
    const client = new LspClient(config, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const tools = new Map(
      registerLspTools(DARK_CONFIG, client).map((t) => [
        t.definition.name,
        t,
      ]),
    );

    try {
      const domains = parseJson(await tools.get("lsp:list_domains")!.handler({}));
      assert.deepEqual(domains, [
        {
          qualifiedName: "com.example.shop.Order",
          simpleName: "Order",
          packageName: "com.example.shop",
          // Dynamic absolute temp path — echoed here so deepEqual ignores it;
          // its value is validated by the assert.match on the tail just below.
          sourcePath: domains[0]?.sourcePath,
        },
      ]);
      assert.match(domains[0].sourcePath, /Order\.java$/);

      const description = parseJson(
        await tools.get("lsp:describe_domain")!.handler({ qualifiedName: "com.example.shop.Order" }),
      );
      assert.equal(description.qualifiedName, "com.example.shop.Order");
      const fieldNames = description.fields.map((f: { name: string }) => f.name);
      assert.ok(fieldNames.includes("code") && fieldNames.includes("total"));
      assert.equal(
        description.fields.find((f: { name: string }) => f.name === "code").required,
        true,
      );
      assert.deepEqual(
        description.actions.map((a: { name: string }) => a.name),
        ["submit"],
      );
      assert.ok(description.artefacts.includes("rest") && description.artefacts.includes("graphql"));

      const actions = parseJson(await tools.get("lsp:list_actions")!.handler({}));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].owningDomain, "com.example.shop.Order");
      assert.equal(actions[0].name, "submit");
      assert.equal(actions[0].httpMethod, "POST");
      assert.equal(actions[0].resultType, null); // submit returns void → null result type
      assert.deepEqual(actions[0].params, [{ name: "reason", type: "String", required: true }]);
    } finally {
      client.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
