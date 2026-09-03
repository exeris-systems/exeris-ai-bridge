import { strict as assert } from "node:assert";
import { test } from "node:test";

import { explainArtefact, matchesEntity, parseCodegenManifest } from "./artefacts.js";

const PKG = "com/example/fleet";

test("parseCodegenManifest reads the format OutputWriter writes", () => {
  const raw = [
    "# Exeris Tooling generated-output manifest - DO NOT EDIT MANUALLY",
    `${PKG}/handler/StationHandler.java`,
    "",
    `${PKG}/service/StationService.java`,
    "",
  ].join("\n");
  assert.deepEqual(parseCodegenManifest(raw), [
    `${PKG}/handler/StationHandler.java`,
    `${PKG}/service/StationService.java`,
  ]);
});

test("manifest entries that could climb out of the tree are dropped, not echoed", () => {
  // The manifest is a file in the USER'S project. An escaping entry would be
  // reported to the agent as "an artefact of your build", which is a false
  // statement about a path this server never even opened.
  const raw = [
    "../../../etc/passwd",
    "/etc/shadow",
    "a/../../b.java",
    "C:\\Windows\\system32",
    "..",
    `${PKG}/handler/StationHandler.java`,
  ].join("\n");
  assert.deepEqual(parseCodegenManifest(raw), [`${PKG}/handler/StationHandler.java`]);
});

test("the package, not the class-name suffix, identifies the generator", () => {
  const cases: [string, string, string][] = [
    [`${PKG}/handler/StationHandler.java`, "HTTP handler", "KernelHandlerGenerator"],
    [`${PKG}/service/StationService.java`, "Domain service", "KernelServiceGenerator"],
    [`${PKG}/repository/StationRepository.java`, "Repository", "KernelRepositoryGenerator"],
    [`${PKG}/event/StationEventPublisher.java`, "Domain-event publisher", "KernelEventGenerator"],
    [`${PKG}/event/StationEventSubscriber.java`, "Domain-event subscriber", "KernelEventHandlerGenerator"],
    [`${PKG}/graph/StationGraphSync.java`, "Graph-sync projection", "KernelGraphSyncGenerator"],
    [`${PKG}/client/StationClient.java`, "Service-to-service HTTP client", "KernelClientGenerator"],
    [`${PKG}/saga/RefuelFlow.java`, "Saga skeleton", "KernelSagaGenerator"],
  ];
  for (const [path, artefact, generator] of cases) {
    const explained = explainArtefact(path);
    assert.equal(explained.artefact, artefact, path);
    assert.equal(explained.generator, generator, path);
    assert.equal(explained.scope, "entity", path);
  }
});

test("the two domain errors share a package and are told apart by suffix", () => {
  const notFound = explainArtefact(`${PKG}/repository/StationNotFoundException.java`);
  assert.equal(notFound.artefact, "Domain error — not found");
  assert.match(notFound.driver, /every entity/);

  const conflict = explainArtefact(`${PKG}/repository/StationVersionConflictException.java`);
  assert.equal(conflict.artefact, "Domain error — version conflict");
  assert.match(conflict.driver, /versioned = true/);
});

test("an entity-level stream handler is separated from a per-action one by the entity list", () => {
  const entityLevel = explainArtefact(`${PKG}/handler/StationStreamHandler.java`, ["Station"]);
  assert.equal(entityLevel.generator, "KernelStreamHandlerGenerator");
  assert.match(entityLevel.driver, /realTimeApi/);

  const perAction = explainArtefact(`${PKG}/handler/StationRefuelStreamHandler.java`, ["Station"]);
  assert.equal(perAction.generator, "KernelActionStreamHandlerGenerator");
  assert.match(perAction.driver, /@Action\(streaming/);
});

test("with no entity list the two stream handlers stay merged and say so", () => {
  // Guessing one of the two would be wrong half the time, and the agent has no
  // way to tell it was a guess.
  const explained = explainArtefact(`${PKG}/handler/StationStreamHandler.java`);
  assert.equal(
    explained.generator,
    "KernelStreamHandlerGenerator or KernelActionStreamHandlerGenerator",
  );
  assert.match(explained.driver, /build the project/);
});

test("non-Java artefacts are classified by extension", () => {
  const sql = explainArtefact("db/migration/V3__create_stations.sql");
  assert.equal(sql.generator, "KernelFlywayGenerator");
  assert.equal(sql.scope, "entity");
  assert.match(sql.driver, /snake_case/);

  const yaml = explainArtefact("openapi/station-api.yaml");
  assert.equal(yaml.generator, "KernelOpenApiGenerator");
});

test("project-wide artefacts are marked project-wide", () => {
  for (const path of [
    "com/example/Application.java",
    "com/example/RuntimeComponents.java",
    "com/example/RuntimeLifecycle.java",
    "db/migration/V3000000__foreign_keys.sql",
    "cap-manifest.json",
  ]) {
    assert.equal(explainArtefact(path).scope, "project", path);
  }
});

test("an unrecognised path is still reported as pipeline-owned", () => {
  // The manifest listing it is the load-bearing fact; not recognising its shape
  // must not downgrade that into "probably yours to edit".
  const explained = explainArtefact(`${PKG}/mystery/Whatever.java`);
  assert.equal(explained.generator, null);
  assert.match(explained.driver, /pipeline owns it/);
  assert.match(explained.driver, /do not hand-edit/i);
});

test("entity match survives the casing the generators actually emit", () => {
  assert.ok(matchesEntity("db/migration/V3__create_backup_stations.sql", "BackupStation"));
  assert.ok(matchesEntity("openapi/backup-station-api.yaml", "BackupStation"));
  assert.ok(matchesEntity(`${PKG}/handler/BackupStationHandler.java`, "BackupStation"));
  assert.ok(!matchesEntity(`${PKG}/handler/DepotHandler.java`, "BackupStation"));
});

test("the entity match reads the filename only, never the package path", () => {
  // Otherwise an entity named after any package segment — here 'Fleet', which
  // is a directory on every one of these paths — would match the whole project.
  assert.ok(!matchesEntity(`${PKG}/handler/DepotHandler.java`, "Fleet"));
  assert.ok(!matchesEntity(`${PKG}/service/DepotService.java`, "Fleet"));
});

// The bias is deliberate: an over-match hands the agent a file it can see is
// not the one it asked for, while an under-match hides the generated migration,
// which is the failure the tool exists to prevent.
test("the entity match errs towards including too much", () => {
  assert.ok(matchesEntity(`${PKG}/handler/BackupStationHandler.java`, "Station"));
});

test("a path from the test root is a generated test whatever its package says", () => {
  // The test generators reuse the main packages, so the package dispatch would
  // call this an HTTP handler. The output root is the fact that settles it.
  const explained = explainArtefact(`${PKG}/handler/StationHandlerTest.java`, ["Station"], true);
  assert.equal(explained.artefact, "Generated test");
  assert.match(explained.driver, /exeris.tests=true/);
});
