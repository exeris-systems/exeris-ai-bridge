import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BridgeConfig } from "./config/env.js";
import { buildInstructions } from "./instructions.js";
import { registerBridgeTools } from "./tools/bridge/index.js";
import { registerDocsTools } from "./tools/docs/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import { registerLspTools } from "./tools/lsp/index.js";

const LIT: BridgeConfig = {
  mode: "contributor",
  modeSource: "probe",
  ecosystemRoot: "/var/empty",
  docs: { state: "available", docsRoot: "/var/empty/exeris-docs", ecosystemRoot: "/var/empty" },
  lsp: { state: "available", command: "lsp-stub", args: [], source: "source-tree", workspaceRoot: "/var/empty" },
  kernel: { state: "available", command: "kernel-stub", args: [], source: "source-tree" },
  project: { state: "available", projectRoot: "/var/empty/project", source: "env" },
};

const DARK: BridgeConfig = {
  mode: "app",
  modeSource: "probe",
  ecosystemRoot: null,
  docs: { state: "unavailable", reason: "no exeris-docs (test)", remedy: "set EXERIS_DOCS_ROOT (test)" },
  lsp: { state: "unavailable", reason: "no launch spec (test)", remedy: "set EXERIS_LSP_COMMAND (test)" },
  kernel: { state: "unavailable", reason: "no launch spec (test)", remedy: "set EXERIS_KERNEL_COMMAND (test)" },
  project: { state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" },
};

test("the instructions report the resolved state of every family", () => {
  assert.match(buildInstructions(LIT), /docs=available lsp=available kernel=available/);
  assert.match(buildInstructions(DARK), /docs=unavailable lsp=unavailable kernel=unavailable/);
});

// The reason this string exists at all: an agent whose priors are Spring will
// design a Spring application here unless corrected before it calls anything.
// If this assertion is ever deleted, the instructions have lost their purpose
// and are just a tool listing the client already has.
test("the instructions correct the Spring default before any tool is called", () => {
  const text = buildInstructions(LIT);
  assert.match(text, /Exeris is not Spring/);
  assert.match(text, /@ExerisDomain/);
});

// Zero-checkout is the P2 default, and a dark family is an answer rather than a
// fault. An agent told only "docs=unavailable" would reasonably read it as a
// broken server and stop.
test("the instructions explain that a dark family still answers", () => {
  assert.match(buildInstructions(DARK), /family_unavailable/);
  assert.match(buildInstructions(DARK), /bridge-health/);
});

// The instructions name families by their wire prefix. Anything that renames a
// family — or the separator — has to move this string too, or the client is
// handed a map to a surface that no longer exists.
test("every family named in the instructions matches a registered tool prefix", () => {
  const text = buildInstructions(LIT);
  const registered = [
    ...registerDocsTools(LIT),
    ...registerLspTools(LIT),
    ...registerKernelTools(LIT),
    ...registerBridgeTools(LIT),
  ].map((t) => t.definition.name);

  for (const family of ["docs", "lsp", "kernel", "bridge"]) {
    assert.ok(text.includes(`${family}-*`), `instructions do not name ${family}-*`);
    assert.ok(
      registered.some((n) => n.startsWith(`${family}-`)),
      `instructions name ${family}-* but nothing registers under it`,
    );
  }
});

// Named tools are a promise the surface has to keep; a stale one sends the
// agent to a tool that is not there.
test("every tool the instructions name by full name is actually registered", () => {
  const text = buildInstructions(LIT);
  const registered = new Set(
    [
      ...registerDocsTools(LIT),
      ...registerLspTools(LIT),
      ...registerKernelTools(LIT),
      ...registerBridgeTools(LIT),
    ].map((t) => t.definition.name),
  );
  const named = text.match(/\b(?:docs|lsp|kernel|bridge)-[a-z_]+\b/g) ?? [];
  assert.ok(named.length > 0, "the instructions name no tool at all");
  for (const name of new Set(named)) {
    assert.ok(registered.has(name), `instructions name ${name}, which is not registered`);
  }
});
