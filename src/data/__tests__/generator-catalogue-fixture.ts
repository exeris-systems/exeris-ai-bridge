import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleState } from "../bundle.js";
import { GENERATOR_CATALOGUE_ENTRY, parseGeneratorCatalogue } from "../generator-catalogue.js";

// The generator catalogue as exeris-codegen-java publishes it, committed as a
// test fixture so the suite and the zero-checkout smoke run need no network and
// no Maven repository. It is byte-identical to the resource in the fixture
// jar under test/fixtures/m2, which is what the pack step vendors from.

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "generator-catalogue.json",
);

export const CATALOGUE_FIXTURE_SOURCE = "eu.exeris:exeris-codegen-java:0.10.0";

export function catalogueFixtureText(): string {
  return readFileSync(FIXTURE, "utf8");
}

export function fixtureCatalogue() {
  return parseGeneratorCatalogue(catalogueFixtureText());
}

/** Write `text` (default: the fixture) into `dir` as the bundle's catalogue entry. */
export function writeCatalogueBundle(dir: string, text: string = catalogueFixtureText()): BundleState {
  const file = `${GENERATOR_CATALOGUE_ENTRY}.json`;
  writeFileSync(join(dir, file), text, "utf8");
  return {
    state: "available",
    generatedAt: "2026-01-01T00:00:00.000Z",
    bridgeVersion: "0.0.0",
    entries: [
      {
        id: GENERATOR_CATALOGUE_ENTRY,
        path: file,
        sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
        bytes: Buffer.byteLength(text),
        sourceArtifact: CATALOGUE_FIXTURE_SOURCE,
      },
    ],
  };
}
