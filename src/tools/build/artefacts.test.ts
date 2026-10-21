import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fixtureCatalogue } from "../../data/__tests__/generator-catalogue-fixture.js";
import { explainArtefact, matchesEntity, parseCodegenManifest } from "./artefacts.js";

const PKG = "com/example/fleet";
const catalogue = fixtureCatalogue();

const main = (path: string) => explainArtefact(path, catalogue, "main");
const tests = (path: string) => explainArtefact(path, catalogue, "test");

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

test("a leading ./ is stripped from manifest entries, and only a leading one", () => {
  assert.deepEqual(parseCodegenManifest(`./${PKG}/service/StationService.java\n`), [
    `${PKG}/service/StationService.java`,
  ]);
  assert.deepEqual(parseCodegenManifest(`${PKG}/./service/StationService.java\n`), []);
  assert.equal(main(`./${PKG}/service/StationService.java`).catalogueId, "service");
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

test("every row of the catalogue is reached by the path its own template names", () => {
  // The table lives upstream; this only proves the bridge applies it. Each
  // template is instantiated with plausible names and must land on a row of the
  // same output root — the row itself, or one it lists as ambiguous.
  const fill = (template: string) =>
    template
      .replace("{base}", PKG)
      .replace("{app}", "com/example")
      .replace("{kebab(E)}", "station")
      .replace("{Action}", "Refuel")
      .replace("{Flow}", "RefuelFlow")
      .replace("{E}", "Station")
      .replace("{tier}{nnnnnn}", "2123456")
      .replace("{nnnnnn}", "123456")
      .replace("{table}", "stations")
      .replace("{HttpExchange,Persistence,Flow,RequestBody,EventEngine}", "Persistence");
  for (const row of catalogue.rows) {
    const path = fill(row.pathTemplate);
    const explained = explainArtefact(path, catalogue, row.outputRoot);
    const reached = [explained.catalogueId, ...explained.ambiguousWith.map((a) => a.id)];
    assert.ok(reached.includes(row.id), `${row.id}: ${path} -> ${explained.catalogueId}`);
  }
});

test("an unambiguous path carries its row's generator, scope and cardinality", () => {
  const cases: [string, string, string][] = [
    [`${PKG}/handler/StationHandler.java`, "KernelHandlerGenerator", "handler"],
    [`${PKG}/service/StationService.java`, "KernelServiceGenerator", "service"],
    [`${PKG}/repository/StationRepository.java`, "KernelRepositoryGenerator", "repository"],
    [`${PKG}/event/StationEventPublisher.java`, "KernelEventGenerator", "event-publisher"],
    [`${PKG}/event/StationEventSubscriber.java`, "KernelEventHandlerGenerator", "event-subscriber"],
    [`${PKG}/graph/StationGraphSync.java`, "KernelGraphSyncGenerator", "graph-sync"],
    [`${PKG}/client/StationClient.java`, "KernelClientGenerator", "client"],
    [`${PKG}/saga/RefuelFlow.java`, "KernelSagaGenerator", "saga-flow"],
  ];
  for (const [path, generator, id] of cases) {
    const explained = main(path);
    assert.equal(explained.generator, generator, path);
    assert.equal(explained.catalogueId, id, path);
    assert.equal(explained.scope, "entity", path);
    assert.deepEqual(explained.ambiguousWith, [], path);
  }
  assert.match(main(`${PKG}/event/StationEventPublisher.java`).driver, /DomainEvent/);
  assert.equal(main(`${PKG}/handler/StationHandler.java`).cardinality, "one");
});

test("the list route's query and page records are explained, not unrecognised", () => {
  const query = main(`${PKG}/repository/StationListQuery.java`);
  assert.equal(query.catalogueId, "list-query");
  assert.equal(query.generator, "KernelListQueryGenerator");
  assert.equal(query.adr, "ADR-096");

  const page = main(`${PKG}/repository/StationPage.java`);
  assert.equal(page.catalogueId, "page");
  assert.equal(page.generator, "KernelListQueryGenerator");
});

test("the domain errors of one package are told apart by their own rows", () => {
  const cases: [string, string][] = [
    ["StationVersionConflictException", "version-conflict-exception"],
    ["StationTenantMismatchException", "tenant-mismatch-exception"],
    ["StationSharedScopeMismatchException", "shared-scope-mismatch-exception"],
    ["StationStillReferencedException", "still-referenced-exception"],
  ];
  for (const [stem, id] of cases) {
    const explained = main(`${PKG}/repository/${stem}.java`);
    assert.equal(explained.catalogueId, id, stem);
    assert.equal(explained.generator, "KernelErrorGenerator", stem);
    assert.deepEqual(explained.ambiguousWith, [], stem);
  }
  assert.match(main(`${PKG}/repository/StationTenantMismatchException.java`).artefact, /another tenant/);
  assert.equal(main(`${PKG}/repository/StationTenantMismatchException.java`).adr, "ADR-090");
});

test("a reference-not-found exception is not labelled the 404 not-found exception", () => {
  const reference = main(`${PKG}/repository/StationReferenceNotFoundException.java`);
  assert.equal(reference.catalogueId, "reference-not-found-exception");
  assert.match(reference.artefact, /422/);
  assert.doesNotMatch(reference.artefact, /404/);
  // The shapes overlap, so the other row is reported rather than dropped.
  assert.deepEqual(
    reference.ambiguousWith.map((a) => a.id),
    ["not-found-exception"],
  );

  const plain = main(`${PKG}/repository/StationNotFoundException.java`);
  assert.equal(plain.catalogueId, "not-found-exception");
  assert.match(plain.artefact, /404/);
});

test("a spectate stream handler is its own row, ahead of the stream handlers", () => {
  const explained = main(`${PKG}/handler/StationSpectateStreamHandler.java`);
  assert.equal(explained.catalogueId, "spectate-stream-handler");
  assert.match(explained.generator ?? "", /^KernelSpectateStreamHandlerGenerator/);
  assert.match(explained.driver, /realTimeApi/);
  // Every later stream pattern also fits the name, so those are reported too.
  assert.deepEqual(
    explained.ambiguousWith.map((a) => a.id),
    ["stream-handler", "action-stream-handler", "handler"],
  );
});

test("a stream-handler shape reports every candidate instead of guessing", () => {
  // `StationRefuelStreamHandler` is a per-action handler of Station or the
  // entity-level handler of an entity named StationRefuel; the path cannot say.
  const explained = main(`${PKG}/handler/StationRefuelStreamHandler.java`);
  assert.equal(explained.catalogueId, "stream-handler");
  assert.deepEqual(
    explained.ambiguousWith.map((a) => a.id),
    ["action-stream-handler", "handler"],
  );
  assert.equal(
    explained.generator,
    "KernelStreamHandlerGenerator or KernelActionStreamHandlerGenerator or KernelHandlerGenerator",
  );
  assert.match(explained.driver, /AMBIGUOUS/);
  assert.match(explained.driver, /action-stream-handler/);
});

test("a plain handler does not claim candidates whose pattern cannot match it", () => {
  assert.deepEqual(main(`${PKG}/handler/StationHandler.java`).ambiguousWith, []);
});

test("project-wide artefacts are marked project-wide, with the route policy among them", () => {
  const cases: [string, string][] = [
    ["com/example/Application.java", "application"],
    ["com/example/RuntimeComponents.java", "runtime-components"],
    ["com/example/RuntimeLifecycle.java", "runtime-lifecycle"],
    ["com/example/GeneratedRoutePolicy.java", "generated-route-policy"],
    ["db/migration/V3000000__foreign_keys.sql", "foreign-key-migration"],
    ["cap-manifest.json", "cap-manifest"],
  ];
  for (const [path, id] of cases) {
    const explained = main(path);
    assert.equal(explained.catalogueId, id, path);
    assert.equal(explained.scope, "project", path);
  }
  assert.equal(main("com/example/GeneratedRoutePolicy.java").generator, "KernelApplicationGenerator");
  assert.equal(main("com/example/GeneratedRoutePolicy.java").adr, "ADR-105");
});

test("migrations are told apart by the shape of their name", () => {
  const create = main("db/migration/V2123456__create_stations.sql");
  assert.equal(create.catalogueId, "create-table-migration");
  assert.equal(create.generator, "KernelFlywayGenerator");
  assert.equal(create.scope, "entity");

  const shared = main("db/migration/V4123456__shared_scope_stations.sql");
  assert.equal(shared.catalogueId, "shared-scope-migration");
  assert.equal(shared.generator, "KernelSharedScopeMigrationGenerator");
  assert.equal(shared.adr, "ADR-059");

  assert.equal(main("openapi/station-api.yaml").generator, "KernelOpenApiGenerator");
});

test("the output root decides which rows can match", () => {
  // The test generators reuse the main packages. A handler test is a row of the
  // test root; the same shape in the main root is nothing.
  const generated = tests(`${PKG}/handler/StationHandlerTest.java`);
  assert.equal(generated.catalogueId, "handler-test");
  assert.equal(generated.generator, "KernelHandlerTestGenerator");

  assert.equal(main(`${PKG}/handler/StationHandlerTest.java`).catalogueId, null);
  assert.equal(tests(`${PKG}/handler/StationHandler.java`).generator, null);
});

test("test-support doubles are project-scoped, in the test root only", () => {
  const explained = tests("com/example/testsupport/RecordingPersistence.java");
  assert.equal(explained.catalogueId, "test-support");
  assert.equal(explained.scope, "project");
  assert.equal(explained.generator, "KernelTestSupportGenerator");
  assert.equal(explained.cardinality, "fixed-set");

  assert.equal(main("com/example/testsupport/RecordingPersistence.java").generator, null);
});

test("the test root is described without claiming a system property is required", () => {
  const explained = tests(`${PKG}/service/StationServiceTest.java`);
  assert.doesNotMatch(explained.driver, /exeris\.tests/);
});

test("an unrecognised path is still reported as pipeline-owned, as a catalogue gap", () => {
  // The manifest listing it is the load-bearing fact; not recognising its shape
  // must not downgrade that into "probably yours to edit".
  const explained = main(`${PKG}/mystery/Whatever.java`);
  assert.equal(explained.generator, null);
  assert.equal(explained.catalogueId, null);
  assert.match(explained.driver, /pipeline owns it/);
  assert.match(explained.driver, /gap in the catalogue/);
  assert.match(explained.driver, /do not hand-edit/i);
});

test("with no catalogue every path is listed as pipeline-owned and unexplained", () => {
  const explained = explainArtefact(`${PKG}/handler/StationHandler.java`, null, "main");
  assert.equal(explained.generator, null);
  assert.match(explained.driver, /no generator catalogue/);
  assert.match(explained.driver, /do not hand-edit/i);
});

test("entity match survives the casing the generators actually emit", () => {
  assert.ok(matchesEntity("db/migration/V2123456__create_backup_stations.sql", "BackupStation"));
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
