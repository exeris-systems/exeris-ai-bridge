import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BridgeConfig } from "./config/env.js";
import { registerDocsTools } from "./tools/docs/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import { registerLspTools } from "./tools/lsp/index.js";

// Composition tests (counts, names, prefixes). Handlers are not invoked against
// the live config, so paths need only be syntactically valid — `/var/empty`
// avoids Sonar's S5443 publicly-writable-directory flag on /tmp.
const stubConfig: BridgeConfig = {
  mode: "contributor",
  modeSource: "probe",
  ecosystemRoot: "/var/empty",
  docs: { state: "available", docsRoot: "/var/empty/exeris-docs-stub", ecosystemRoot: "/var/empty" },
  lsp: { state: "available", command: "true", args: [], source: "source-tree", workspaceRoot: "/var/empty" },
  kernel: { state: "available", command: "true", args: [], source: "source-tree" },
};

/** What a bare application project resolves to: no roots, no launch specs. */
const zeroCheckoutConfig: BridgeConfig = {
  mode: "app",
  modeSource: "probe",
  ecosystemRoot: null,
  docs: { state: "unavailable", reason: "docs reason", remedy: "docs remedy" },
  lsp: { state: "unavailable", reason: "lsp reason", remedy: "lsp remedy" },
  kernel: { state: "unavailable", reason: "kernel reason", remedy: "kernel remedy" },
};

function registerAll(config: BridgeConfig) {
  return [
    ...registerDocsTools(config),
    ...registerLspTools(config),
    ...registerKernelTools(config),
  ];
}

test("docs registry exposes at least one tool", () => {
  assert.ok(registerDocsTools(stubConfig).length > 0);
});

test("lsp registry exposes at least one tool", () => {
  assert.ok(registerLspTools(stubConfig).length > 0);
});

test("kernel registry exposes at least one tool", () => {
  assert.ok(registerKernelTools(stubConfig).length > 0);
});

test("tool names are unique across all three families", () => {
  const names = registerAll(stubConfig).map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
});

test("every tool name is prefixed with its family", () => {
  for (const t of registerDocsTools(stubConfig)) {
    assert.match(t.definition.name, /^docs:/);
  }
  for (const t of registerLspTools(stubConfig)) {
    assert.match(t.definition.name, /^lsp:/);
  }
  for (const t of registerKernelTools(stubConfig)) {
    assert.match(t.definition.name, /^kernel:/);
  }
});

// ---------------------------------------------------------------------------
// zero-checkout composition (ADR-025 two-personas amendment)

test("the tool surface is identical with every family dark", () => {
  // 1.0 freezes tools/list under semver and MCP clients cache it at connect
  // time, so the surface cannot vary with the environment. If this fails, some
  // registry started returning a different set of tools when its dependency is
  // missing — that is the regression, not this assertion.
  const live = registerAll(stubConfig).map((t) => JSON.stringify(t.definition));
  const dark = registerAll(zeroCheckoutConfig).map((t) => JSON.stringify(t.definition));
  assert.deepEqual(dark, live);
});

test("every tool in a dark family returns the structured reason and remedy", async () => {
  // The anti-drift guard for the masking in tools/unavailable.ts: a handler
  // added without guard() would reach its transport (or its filesystem read)
  // here and fail some other way.
  for (const tool of registerAll(zeroCheckoutConfig)) {
    const name = tool.definition.name;
    const family = name.split(":")[0];
    const res = await tool.handler({});
    assert.equal(res.isError, true, name);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    assert.equal(payload.error, "family_unavailable", name);
    assert.equal(payload.family, family, name);
    assert.equal(payload.reason, `${family} reason`, name);
    assert.equal(payload.remedy, `${family} remedy`, name);
  }
});
