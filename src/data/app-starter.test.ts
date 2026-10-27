import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  APP_STARTER_FIXTURE_SOURCE,
  fixtureAppStarter,
  starterPomText,
  writeAppStarterBundle,
} from "./__tests__/app-starter-fixture.js";
import { AppStarterFormatError, loadAppStarter, parseAppStarter, parseAppStarterPoms } from "./app-starter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exeris-appstarter-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function poms() {
  return {
    bom: starterPomText("exeris-app-bom"),
    parent: starterPomText("exeris-app-parent"),
    starter: starterPomText("exeris-app-starter"),
  };
}

test("the committed 0.10.0 POMs name the tested triple", () => {
  const starter = parseAppStarterPoms(poms());
  assert.equal(starter.bomVersion, "0.10.0");
  assert.deepEqual(starter.triple, { tooling: "0.10.0", kernel: "0.12.0", sdk: "0.12.0" });
  assert.deepEqual(starter.coordinates.starter, {
    groupId: "eu.exeris",
    artifactId: "exeris-app-starter",
    version: "0.10.0",
  });
  assert.deepEqual(starter, fixtureAppStarter());
});

test("a version that is an expression, not a literal, is refused", () => {
  const bom = poms().bom.replace("<exeris.kernel.version>0.12.0<", "<exeris.kernel.version>${project.version}<");
  assert.throws(() => parseAppStarterPoms({ ...poms(), bom }), /exeris\.kernel\.version.*not a literal/);
});

test("a tooling version that differs from the BOM version is refused", () => {
  const bom = poms().bom.replace("<exeris.tooling.version>0.10.0<", "<exeris.tooling.version>0.9.0<");
  assert.throws(() => parseAppStarterPoms({ ...poms(), bom }), AppStarterFormatError);
});

test("a starter that does not inherit the BOM at its version is refused", () => {
  const starter = poms().starter.replace("<version>0.10.0</version>", "<version>0.9.0</version>");
  assert.throws(() => parseAppStarterPoms({ ...poms(), starter }), /exeris-app-starter does not inherit/);
});

test("an unknown appStarterFormat is refused", () => {
  for (const format of [0, 2, "1", null]) {
    assert.throws(
      () => parseAppStarter(JSON.stringify({ ...fixtureAppStarter(), appStarterFormat: format })),
      AppStarterFormatError,
    );
  }
});

test("loadAppStarter reads the vendored entry and keeps its source artifact", () => {
  const state = loadAppStarter(writeAppStarterBundle(dir), dir);
  assert.equal(state.state, "available");
  if (state.state === "available") {
    assert.equal(state.starter.bomVersion, "0.10.0");
    assert.equal(state.sourceArtifact, APP_STARTER_FIXTURE_SOURCE);
  }
});

test("loadAppStarter reports a bundle without the entry, and a format it does not read", () => {
  const empty = { state: "available" as const, generatedAt: "x", bridgeVersion: "0.0.0", entries: [] };
  const missing = loadAppStarter(empty, dir);
  assert.equal(missing.state, "unavailable");

  const future = writeAppStarterBundle(dir, JSON.stringify({ ...fixtureAppStarter(), appStarterFormat: 2 }));
  const refused = loadAppStarter(future, dir);
  assert.equal(refused.state, "unavailable");
  if (refused.state === "unavailable") assert.match(refused.reason, /appStarterFormat 2/);
});
