import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BridgeConfig } from "./config/env.js";
import { registerBridgeTools } from "./tools/bridge/index.js";
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
    ...registerBridgeTools(config),
  ];
}

/** bridge:* is the self-diagnostic family; it is never environment-gated. */
function isGated(name: string): boolean {
  return !name.startsWith("bridge-");
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
    assert.match(t.definition.name, /^docs-/);
  }
  for (const t of registerLspTools(stubConfig)) {
    assert.match(t.definition.name, /^lsp-/);
  }
  for (const t of registerKernelTools(stubConfig)) {
    assert.match(t.definition.name, /^kernel-/);
  }
  for (const t of registerBridgeTools(stubConfig)) {
    assert.match(t.definition.name, /^bridge-/);
  }
});

// The reason the surface is `family-tool` and not `family:tool`: MCP clients do
// not reliably resolve a `:` inside a tool name, and the failure is silent — the
// server registers, `tools/list` looks right, and every call misses. A colon is
// therefore not a style question here, so this pins the whole surface to the
// conservative charset rather than trusting the per-family prefix tests above to
// notice one creeping back in.
test("every tool name is one family, one hyphen, then snake_case", () => {
  for (const name of registerAll(stubConfig).map((t) => t.definition.name)) {
    assert.match(name, /^[a-z]+-[a-z_]+$/, name);
    // Split-on-first-hyphen is how the tests and the smoke test recover the
    // family key; a second hyphen would still match a laxer pattern and then
    // silently recover the wrong half.
    assert.equal(name.split("-").length, 2, `${name} has more than one hyphen`);
  }
});

// A description is agent-facing text served by tools/list, so a tool name inside
// one is a live pointer, not prose. The 0.5.1 rename reached every registered
// `name` and missed several descriptions, which left the exact failure the
// rename fixes — a name that resolves to nothing — relocated one field over.
// Both halves matter: a colon form is dead on arrival, and a hyphen form is only
// as good as the tool still existing.
test("tool descriptions point only at tools that exist", () => {
  const tools = registerAll(stubConfig).map((t) => t.definition);
  const registered = new Set(tools.map((t) => t.name));

  for (const { name, description } of tools) {
    assert.ok(description, `${name} has no description`);
    const colon = description.match(/\b(?:docs|lsp|kernel|bridge|sdk|build|caps):[a-z_]+/g) ?? [];
    assert.deepEqual(colon, [], `${name} description uses the pre-0.5.1 colon form: ${colon.join(", ")}`);

    // Backtick-delimited, because that is how this codebase writes a tool name
    // and because bare prose is not a reference: "docs-root-relative path" is
    // English, not a pointer at a `docs-root` tool.
    for (const [, ref] of description.matchAll(/`((?:docs|lsp|kernel|bridge)-[a-z_]+)`/g)) {
      assert.ok(registered.has(ref), `${name} description points at ${ref}, which is not registered`);
    }
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
  for (const tool of registerAll(zeroCheckoutConfig).filter((t) => isGated(t.definition.name))) {
    const name = tool.definition.name;
    const family = name.split("-")[0];
    const res = await tool.handler({});
    assert.equal(res.isError, true, name);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    assert.equal(payload.error, "family_unavailable", name);
    assert.equal(payload.family, family, name);
    assert.equal(payload.reason, `${family} reason`, name);
    assert.equal(payload.remedy, `${family} remedy`, name);
  }
});

test("bridge:* stays live when every environment-dependent family is dark", async () => {
  // The surface that explains the others must not be gated by the same thing
  // it explains. If bridge:* ever starts answering family_unavailable, the
  // diagnostic path has gone dark exactly when it is needed.
  const bridge = registerAll(zeroCheckoutConfig).filter((t) => !isGated(t.definition.name));
  assert.equal(bridge.length, 2);
  for (const tool of bridge) {
    const res = await tool.handler({});
    assert.ok(!res.isError, tool.definition.name);
  }
});
