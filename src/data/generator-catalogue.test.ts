import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  catalogueFixtureText,
  CATALOGUE_FIXTURE_SOURCE,
  writeCatalogueBundle,
} from "./__tests__/generator-catalogue-fixture.js";
import type { BundleState } from "./bundle.js";
import {
  CatalogueFormatError,
  loadGeneratorCatalogue,
  patternViolation,
  parseGeneratorCatalogue,
} from "./generator-catalogue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exeris-gencat-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the committed 0.10.0 catalogue parses, in catalogue order", () => {
  const catalogue = parseGeneratorCatalogue(catalogueFixtureText());
  assert.equal(catalogue.catalogueFormat, 1);
  assert.equal(catalogue.rows.length, 33);
  assert.equal(catalogue.rows[0]?.id, "spectate-stream-handler");
  const ids = catalogue.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("an unknown catalogueFormat is refused", () => {
  for (const format of [0, 2, "1", null]) {
    assert.throws(
      () => parseGeneratorCatalogue(JSON.stringify({ catalogueFormat: format, rows: [] })),
      CatalogueFormatError,
    );
  }
  assert.throws(() => parseGeneratorCatalogue(JSON.stringify({ rows: [] })), /catalogueFormat/);
});

test("unknown keys are ignored and rows for other trees are skipped", () => {
  const parsed = JSON.parse(catalogueFixtureText());
  parsed.futureKey = { anything: true };
  parsed.rows[0].futureColumn = 7;
  parsed.rows.push({ ...parsed.rows[0], id: "ts-thing", outputRoot: "ts" });
  const catalogue = parseGeneratorCatalogue(JSON.stringify(parsed));
  assert.equal(catalogue.rows.length, 33);
});

test("a row missing a format-1 key, or with a bad pattern, is refused", () => {
  const broken = JSON.parse(catalogueFixtureText());
  delete broken.rows[3].generator;
  assert.throws(() => parseGeneratorCatalogue(JSON.stringify(broken)), /row 'handler'/);

  const badPattern = JSON.parse(catalogueFixtureText());
  badPattern.rows[3].pathPattern = "^a**$";
  assert.throws(() => parseGeneratorCatalogue(JSON.stringify(badPattern)), /regular expression/);

  assert.throws(() => parseGeneratorCatalogue("not json"), CatalogueFormatError);
});

test("loadGeneratorCatalogue reads the vendored entry and names its source", () => {
  const state = loadGeneratorCatalogue(writeCatalogueBundle(dir), dir);
  assert.equal(state.state, "available");
  if (state.state === "available") {
    assert.equal(state.sourceArtifact, CATALOGUE_FIXTURE_SOURCE);
    assert.equal(state.catalogue.rows.length, 33);
  }
});

test("loadGeneratorCatalogue never throws: each failure is a state with a remedy", () => {
  const noBundle: BundleState = { state: "unavailable", reason: "none", remedy: "pack" };
  assert.equal(loadGeneratorCatalogue(noBundle).state, "unavailable");

  const noEntry: BundleState = { state: "available", generatedAt: "x", bridgeVersion: "x", entries: [] };
  const missing = loadGeneratorCatalogue(noEntry, dir);
  assert.equal(missing.state, "unavailable");
  if (missing.state === "unavailable") assert.match(missing.reason, /no generator catalogue/);

  const future = loadGeneratorCatalogue(
    writeCatalogueBundle(dir, JSON.stringify({ catalogueFormat: 2, rows: [] })),
    dir,
  );
  assert.equal(future.state, "unavailable");
  if (future.state === "unavailable") assert.match(future.reason, /catalogueFormat 2/);

  const tampered = writeCatalogueBundle(dir);
  writeFileSync(join(dir, "generator-catalogue.json"), "{}");
  const corrupt = loadGeneratorCatalogue(tampered, dir);
  assert.equal(corrupt.state, "unavailable");
  if (corrupt.state === "unavailable") assert.match(corrupt.reason, /integrity check/);
});

test("every pattern of the committed catalogue is inside the portable subset", () => {
  for (const row of JSON.parse(catalogueFixtureText()).rows) {
    assert.equal(patternViolation(row.pathPattern), null, row.id);
  }
});

test("a pattern outside the ADR-097 subset is refused", () => {
  const refused: string[] = [
    "handler/[^/]+\\.java",
    "^handler/[^/]+\\.java",
    "^(?=a)b$",
    "^(?!a)b$",
    "^(?<=a)b$",
    "^(?<n>a)\\k<n>$",
    "^(a)\\1$",
    "^(a)$",
    "^(?i)a$",
    "^\\w+$",
    "^\\d+$",
    "^\\p{L}+$",
    "^a{1,2}$",
    "^a{,2}$",
    "^[a[b]]$",
    "^[abc$",
  ];
  for (const pattern of refused) {
    assert.notEqual(patternViolation(pattern), null, pattern);
  }
  assert.equal(patternViolation("^(?:[^/]+/)*handler/[^/]+Handler\\.java$"), null);
  assert.equal(patternViolation("^db/migration/V[12][0-9]{6}__create_[^/]+\\.sql$"), null);

  const broken = JSON.parse(catalogueFixtureText());
  broken.rows[3].pathPattern = "^[^/]+\\w$";
  assert.throws(() => parseGeneratorCatalogue(JSON.stringify(broken)), /portable subset/);
});
