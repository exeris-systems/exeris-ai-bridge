import { strict as assert } from "node:assert";
import { test } from "node:test";

import { registerDocsTools } from "./tools/docs/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import { registerLspTools } from "./tools/lsp/index.js";

test("docs registry exposes at least one tool", () => {
  assert.ok(registerDocsTools().length > 0);
});

test("lsp registry exposes at least one tool", () => {
  assert.ok(registerLspTools().length > 0);
});

test("kernel registry exposes at least one tool", () => {
  assert.ok(registerKernelTools().length > 0);
});

test("tool names are unique across all three families", () => {
  const names = [
    ...registerDocsTools(),
    ...registerLspTools(),
    ...registerKernelTools(),
  ].map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
});

test("every tool name is prefixed with its family", () => {
  for (const t of registerDocsTools()) {
    assert.match(t.definition.name, /^docs:/);
  }
  for (const t of registerLspTools()) {
    assert.match(t.definition.name, /^lsp:/);
  }
  for (const t of registerKernelTools()) {
    assert.match(t.definition.name, /^kernel:/);
  }
});
