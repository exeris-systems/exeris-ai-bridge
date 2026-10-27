import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_STARTER_ENTRY, type AppStarter } from "../app-starter.js";
import type { BundleState } from "../bundle.js";

// The three starter POMs as exeris-tooling publishes them, committed under the
// fixture Maven repository so the suite and the zero-checkout smoke run need no
// network and no real ~/.m2.

const M2 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "m2", "eu", "exeris");

export const APP_STARTER_FIXTURE_SOURCE = "eu.exeris:exeris-app-bom:0.10.0";

export function starterPomText(artifactId: string): string {
  return readFileSync(join(M2, artifactId, "0.10.0", `${artifactId}-0.10.0.pom`), "utf8");
}

/** The starter a fixture bundle vendors; `triple` replaces the committed versions when given. */
export function fixtureAppStarter(triple = { tooling: "0.10.0", kernel: "0.12.0", sdk: "0.12.0" }): AppStarter {
  const at = (artifactId: string) => ({ groupId: "eu.exeris", artifactId, version: triple.tooling });
  return {
    appStarterFormat: 1,
    bomVersion: triple.tooling,
    triple,
    coordinates: {
      bom: at("exeris-app-bom"),
      parent: at("exeris-app-parent"),
      starter: at("exeris-app-starter"),
    },
  };
}

/** Write `text` (default: the fixture starter) into `dir` as the bundle's app-starter entry. */
export function writeAppStarterBundle(
  dir: string,
  text: string = JSON.stringify(fixtureAppStarter()),
  sourceArtifact: string = APP_STARTER_FIXTURE_SOURCE,
): BundleState {
  const file = `${APP_STARTER_ENTRY}.json`;
  writeFileSync(join(dir, file), text, "utf8");
  return {
    state: "available",
    generatedAt: "2026-01-01T00:00:00.000Z",
    bridgeVersion: "0.0.0",
    entries: [
      {
        id: APP_STARTER_ENTRY,
        path: file,
        sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
        bytes: Buffer.byteLength(text),
        sourceArtifact,
      },
    ],
  };
}
