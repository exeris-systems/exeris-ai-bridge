import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BridgeConfig } from "../../config/env.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerCapsTools } from "./index.js";

const MANIFEST_REL = "src/main/generated/java/cap-manifest.json";

const MANIFEST = {
  schemaVersion: 2,
  stamp: { validated: true, compositionVersion: "1.4.0", contentBinding: "sha256:2b9c0f1e" },
  modules: [
    {
      qualifiedName: "eu.exeris.caps.vault.VaultModule",
      module: { provides: [{ service: "eu.exeris.caps.vault.Vault", version: "1.0.0" }], lifecycleOwner: null },
    },
  ],
  initOrder: ["eu.exeris.caps.vault.VaultModule"],
};

const roots: string[] = [];

function projectWith(manifest?: string): string {
  const root = mkdtempSync(join(tmpdir(), "exeris-caps-"));
  roots.push(root);
  if (manifest !== undefined) {
    const file = join(root, MANIFEST_REL);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, manifest);
  }
  return root;
}

process.on("exit", () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function configFor(root: string | null): BridgeConfig {
  return {
    mode: "app",
    modeSource: "probe",
    ecosystemRoot: null,
    docs: { state: "unavailable", reason: "not under test", remedy: "not under test" },
    lsp: { state: "unavailable", reason: "not under test", remedy: "not under test" },
    kernel: { state: "unavailable", reason: "not under test", remedy: "not under test" },
    project:
      root === null
        ? { state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" }
        : { state: "available", projectRoot: root, source: "env" },
  };
}

function toolsFor(root: string | null) {
  return new Map(registerCapsTools(configFor(root)).map((t) => [t.definition.name, t]));
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

test("registerCapsTools registers exactly the two caps-* tools", () => {
  const names = registerCapsTools(configFor(null))
    .map((t) => t.definition.name)
    .sort();
  assert.deepEqual(names, ["caps-describe_composition", "caps-list_capabilities"]);
});

test("caps-list_capabilities returns the modules and the stamped initOrder", async () => {
  const tools = toolsFor(projectWith(JSON.stringify(MANIFEST)));
  const res = await tools.get("caps-list_capabilities")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.schemaVersion, 2);
  assert.deepEqual(payload.initOrder, MANIFEST.initOrder);
  assert.equal(payload.modules[0].module.provides[0].service, "eu.exeris.caps.vault.Vault");
});

test("caps-describe_composition reports the stamp and the module count", async () => {
  const tools = toolsFor(projectWith(JSON.stringify(MANIFEST)));
  const res = await tools.get("caps-describe_composition")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.present, true);
  assert.equal(payload.stamp.validated, true);
  assert.equal(payload.stamp.contentBinding, "sha256:2b9c0f1e");
  assert.equal(payload.moduleCount, 1);
});

// The common case in a user's own project, and the one the ROADMAP calls out:
// most applications compose no capabilities. An agent must be able to tell that
// apart from a failure, which it cannot do from an error string.
test("a project with no manifest is a clean answer, not an error", async () => {
  const tools = toolsFor(projectWith());
  for (const name of ["caps-list_capabilities", "caps-describe_composition"]) {
    const res = await tools.get(name)!.handler({});
    assert.ok(!res.isError, `${name} treated a cap-less project as a failure`);
    const payload = JSON.parse(text(res));
    assert.equal(payload.present, false, name);
    assert.deepEqual(payload.modules, [], name);
  }
});

test("a malformed manifest is a clear shape error naming the field", async () => {
  const tools = toolsFor(projectWith(JSON.stringify({ ...MANIFEST, modules: "nope" })));
  const res = await tools.get("caps-list_capabilities")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /did not match the expected cap-manifest wire shape/);
  assert.match(text(res), /capManifest\.modules must be an array/);
});

test("unparseable JSON is reported as such, not as an absent manifest", async () => {
  const tools = toolsFor(projectWith("{ this is not json"));
  const res = await tools.get("caps-list_capabilities")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /is not valid JSON/);
});

// The path is built by the bridge, not supplied by the agent — but a generated
// tree can carry a symlink, and "we built the string" is not containment.
test("a manifest symlinked outside the project root is refused", async () => {
  const outside = mkdtempSync(join(tmpdir(), "exeris-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "cap-manifest.json"), JSON.stringify(MANIFEST));

  const root = projectWith();
  const link = join(root, MANIFEST_REL);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(outside, "cap-manifest.json"), link);

  const res = await toolsFor(root).get("caps-list_capabilities")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /sandbox escape/);
});

test("caps-* is dark when no project root resolved, with reason and remedy", async () => {
  const tools = toolsFor(null);
  for (const name of ["caps-list_capabilities", "caps-describe_composition"]) {
    const res = await tools.get(name)!.handler({});
    assert.equal(res.isError, true, name);
    const payload = JSON.parse(text(res));
    assert.equal(payload.error, "family_unavailable");
    assert.equal(payload.family, "caps");
    assert.ok(payload.remedy.length > 0);
  }
});
