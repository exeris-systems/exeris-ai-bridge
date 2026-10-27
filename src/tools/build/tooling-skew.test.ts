import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ToolingPin } from "../../config/tooling-pin.js";
import type { CatalogueState } from "../../data/generator-catalogue.js";
import { fixtureCatalogue } from "../../data/__tests__/generator-catalogue-fixture.js";
import { bundledToolingVersion, computeToolingSkew, versionOfSourceArtifact } from "./tooling-skew.js";

const catalogueFrom = (sourceArtifact: string): CatalogueState => ({
  state: "available",
  catalogue: fixtureCatalogue(),
  sourceArtifact,
});

const BUNDLED = catalogueFrom("eu.exeris:exeris-codegen-java:0.10.0");

const pinned = (version: string, source: "app-parent" | "codegen-plugin" | "node-modules"): ToolingPin => ({
  kind: "pinned",
  version,
  source,
});

test("the bundled version is the third segment of the catalogue's source artifact", () => {
  assert.equal(versionOfSourceArtifact("eu.exeris:exeris-codegen-java:0.10.0"), "0.10.0");
  assert.equal(bundledToolingVersion(BUNDLED), "0.10.0");
});

test("a source artifact without a version names no bundled version", () => {
  for (const bad of ["", "eu.exeris:exeris-codegen-java", "eu.exeris:exeris-codegen-java:", "a:b:c:d"]) {
    assert.equal(versionOfSourceArtifact(bad), null, bad);
  }
});

test("a project on the bundled release is aligned, with where the pin came from", () => {
  assert.deepEqual(computeToolingSkew(BUNDLED, pinned("0.10.0", "app-parent")), {
    status: "aligned",
    bundledToolingVersion: "0.10.0",
    projectToolingVersion: "0.10.0",
    source: "app-parent",
  });
});

test("a project on another release is skew_detected, with a warning naming both", () => {
  const report = computeToolingSkew(BUNDLED, pinned("0.9.1", "codegen-plugin"));
  assert.equal(report.status, "skew_detected");
  assert.equal(report.bundledToolingVersion, "0.10.0");
  assert.equal(report.projectToolingVersion, "0.9.1");
  assert.equal(report.source, "codegen-plugin");
  assert.match(report.warning ?? "", /0\.9\.1.*0\.10\.0/);
});

test("the installed TypeScript generator is reported with its own source", () => {
  assert.equal(computeToolingSkew(BUNDLED, pinned("0.10.0", "node-modules")).source, "node-modules");
});

test("a project with no pin is unknown, with the reason and no project version", () => {
  const report = computeToolingSkew(BUNDLED, { kind: "none", reason: "no pin (test)" });
  assert.deepEqual(report, { status: "unknown", bundledToolingVersion: "0.10.0", reason: "no pin (test)" });
});

test("a bundle with no catalogue is unknown, and still reports the project's pin", () => {
  const absent: CatalogueState = { state: "unavailable", reason: "no catalogue (test)", remedy: "pack (test)" };
  assert.deepEqual(computeToolingSkew(absent, pinned("0.10.0", "app-parent")), {
    status: "unknown",
    bundledToolingVersion: "unknown",
    projectToolingVersion: "0.10.0",
    source: "app-parent",
  });
});

test("a catalogue whose source names no version is unknown, never aligned", () => {
  const report = computeToolingSkew(catalogueFrom("eu.exeris:exeris-codegen-java"), pinned("0.10.0", "app-parent"));
  assert.equal(report.status, "unknown");
  assert.equal(report.bundledToolingVersion, "unknown");
});
