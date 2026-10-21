import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DIAGNOSTICS,
  EXT_ID_PATTERN,
  extIdsOf,
  looksLikeExerisOutput,
  matchDiagnostics,
  PROCESSOR_PREFIX,
  scanDiagnostics,
} from "./diagnostics.js";

const P = PROCESSOR_PREFIX;

/**
 * One real message per anchored catalogue entry, transcribed from the producer
 * as it printed before identifiers existed — ExerisDomainProcessor,
 * EmptyMetadataException, the codegen Mojos, CapabilityGraph,
 * CapTierWallException, CodegenPipeline.
 *
 * This table is the drift detector for text anchors. Output carrying no
 * identifier can only be matched on its text, so the failure mode is an anchor
 * that silently stops finding its own message. Any anchored entry whose anchor
 * no longer finds its real message fails here.
 */
const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["processor/wrong-element-kind", `${P}@ExerisDomain can only be applied to classes`],
  [
    "processor/processing-failure",
    `${P}Failed to process domain entity: java.lang.IllegalStateException: no such field`,
  ],
  [
    "processor/datascope-contradiction",
    `${P}@ExerisDomain declares dataScope = DataScope.GLOBAL and tenantScoped = true, which contradict each other — tenantScoped = true means DataScope.TENANT. Declare the tier once: drop tenantScoped, which is deprecated for removal in SDK 1.0.0.`,
  ],
  [
    "processor/universe-tier-reserved",
    `${P}@ExerisDomain.dataScope = DataScope.UNIVERSE is reserved and is refused here rather than half-emitted. The kernel carrier (sharedScopeKey, read-widen / write-pin RLS) exists, but the codegen transcription for it does not`,
  ],
  [
    "processor/repeated-graph-edge",
    `${P}@GraphEdge is declared 2 times on field 'depot' (OWNS, SERVES), and the pipeline cannot carry that.`,
  ],
  [
    "processor/tenant-scoped-deprecated",
    `${P}@ExerisDomain.tenantScoped is deprecated for removal in SDK 1.0.0; declare dataScope = DataScope.TENANT instead. Reading the boolean as a fallback for this build (tenantScoped = true → TENANT). See MIGRATION.md in exeris-sdk.`,
  ],
  [
    "processor/validation-attribute-deprecated",
    `${P}@Validation.validateOn is deprecated for removal in SDK 1.0.0; use @Field.inCreate / @Field.inUpdate instead — form-lifecycle scope is a field property, not a validation rule. See MIGRATION.md in exeris-sdk.`,
  ],
  [
    "processor/validate-on-unrecognised",
    `${P}@Validation.validateOn = "PATCH" is not a recognized value (expected "CREATE" or "UPDATE"); no fallback applied — your intent is being silently dropped now`,
  ],
  [
    "processor/inert-attribute",
    `${P}@ExerisDomain.apiVersion is set but no code generator consumes it — nothing reads it. (reported because -Aexeris.strict is enabled)`,
  ],
  [
    "processor/unread-annotation",
    `${P}@EventSourced is set but this processor never reads it, so no generator can consume it and the annotation has no effect on emitted output — nothing reads it. (reported because -Aexeris.strict is enabled)`,
  ],
  [
    "codegen/empty-metadata-refusal",
    "Refusing to wipe the committed generated tree: 0 @ExerisDomain entities were loaded from /p/target/classes/exeris-metadata, but the previous run owns 42 generated file(s) under /p/src/main/generated/java that exeris:generate would now DELETE.",
  ],
  [
    "codegen/detach-conflicts",
    "Detach left 3 conflict(s); resolve them or set exeris.failOnConflict=false",
  ],
  [
    "caps/unsatisfied-requires",
    "module com.example.Billing @Requires service payments version [1.0,2.0) but no provider matches (providers: com.example.Pay=0.9.0)",
  ],
  ["caps/dependency-cycle", "dependency cycle: com.example.A -> com.example.B -> com.example.A"],
  [
    "caps/graph-unresolved",
    "Capability graph could not be resolved:\n  - module com.example.Billing @Requires service payments but no @CapabilityModule provides it",
  ],
  [
    "caps/wall-violated",
    "Cap-tier Wall violated (ADR-024 predicate 4) — 1 forbidden reference(s):\n  - com.example.Cap references org.springframework.context.ApplicationContext",
  ],
  [
    "caps/wall-scanned-nothing",
    "Cap-tier Wall scanned nothing for 2 capability module(s) — no compiled classes under /p/target/classes (check exeris.classesDir); predicate 4 is unverified, not satisfied",
  ],
  [
    "runtime/no-kernel-driver",
    "The generated application has no kernel driver on its runtime classpath.\nMissing a registered provider for 2 of 5 required SPI(s):",
  ],
  ["processor/source-digest-unreadable", `${P}could not read source for ADR-042 digest (Order): java.io.IOException: gone`],
  ["codegen/generation-io-failure", "Code generation failed (metadataDir=/p/target/classes/exeris-metadata)"],
  ["codegen/test-generation-io-failure", "Test generation failed (testOutputDir=/p/src/test/generated/java)"],
  ["codegen/detach-failed", "Detach failed (generatedDir=/p/src/main/generated/java)"],
  ["caps/metadata-unreadable", "Capability verification failed (metadataDir=/p/target/classes/exeris-metadata)"],
  ["caps/wall-scan-failed", "Cap-tier Wall scan failed (classesDir=/p/target/classes)"],
  [
    "caps/wall-disabled",
    "Cap-tier Wall guard DISABLED (exeris.wall.skip=true) — ADR-024 obligation 3 treats this as a registry violation",
  ],
  ["runtime/metadata-unreadable", "Could not read domain metadata (metadataDir=/p/target/classes/exeris-metadata)"],
  [
    "codegen/no-metadata-found",
    "No domain or capability metadata found in /p/target/classes/exeris-metadata — make sure @ExerisDomain / @CapabilityModule-annotated classes are compiled first",
  ],
  [
    "caps/optional-requirement-skipped",
    "capability: module com.example.Billing @Requires service audit but no @CapabilityModule provides it (optional — skipped)",
  ],
  [
    "caps/graph-deferred",
    "Capability graph invalid on possibly-stale metadata — deferring to the post-compile verify-capabilities gate: Capability graph could not be resolved:\n  - dependency cycle: com.example.A -> com.example.B -> com.example.A",
  ],
];

/**
 * Every identifier `DiagnosticId` registers at exeris-tooling v0.10.0 —
 * exeris-diagnostics/src/main/java/eu/exeris/tooling/diagnostics/DiagnosticId.java
 * at the v0.10.0 tag. Hard-coded rather than read from anywhere, so that a
 * tooling release adding identifiers is a deliberate edit here, made together
 * with the catalogue entries that explain them.
 */
const V0_10_0_IDS: readonly string[] = [
  "EXT-PROC-1001", "EXT-PROC-1002", "EXT-PROC-1003", "EXT-PROC-1004", "EXT-PROC-1005",
  "EXT-PROC-1006", "EXT-PROC-1007", "EXT-PROC-1008", "EXT-PROC-1009", "EXT-PROC-1010",
  "EXT-PROC-1011", "EXT-PROC-1012", "EXT-PROC-1013", "EXT-PROC-1014", "EXT-PROC-1015",
  "EXT-PROC-1016", "EXT-PROC-1017", "EXT-PROC-1018", "EXT-PROC-1019",
  "EXT-PROC-1101", "EXT-PROC-1102", "EXT-PROC-1103", "EXT-PROC-1105", "EXT-PROC-1106",
  "EXT-PROC-1201", "EXT-PROC-1202", "EXT-PROC-1203",
  "EXT-PROC-1901", "EXT-PROC-1902",
  "EXT-PLUG-2001", "EXT-PLUG-2002", "EXT-PLUG-2003", "EXT-PLUG-2004",
  "EXT-PLUG-2101", "EXT-PLUG-2102",
  "EXT-PLUG-2201", "EXT-PLUG-2202", "EXT-PLUG-2203", "EXT-PLUG-2204", "EXT-PLUG-2205", "EXT-PLUG-2206",
  "EXT-PLUG-2301", "EXT-PLUG-2302",
  "EXT-GEN-3001", "EXT-GEN-3002", "EXT-GEN-3003", "EXT-GEN-3004",
  "EXT-GEN-3101", "EXT-GEN-3102", "EXT-GEN-3103", "EXT-GEN-3104",
  "EXT-INIT-5001", "EXT-INIT-5002", "EXT-INIT-5003",
];

/**
 * Identifiers exeris-tooling 0.9.0 printed and 0.10.0 retired — the "Retired
 * identifiers" section of docs/diagnostics.md at v0.10.0. A developer still on
 * 0.9.0 prints them, and a retired number is never reallocated, so their
 * entries stay.
 */
const RETIRED_IDS: readonly string[] = ["EXT-PROC-1104", "EXT-PROC-1107"];

/** The one identifier ADR-095 maps to several entries, told apart by their text. */
const SHARED_IDS: ReadonlySet<string> = new Set(["EXT-PLUG-2201"]);

test("every catalogue entry still matches a real message from the producer", () => {
  for (const [id, message] of SAMPLES) {
    const ids = matchDiagnostics(message).map((m) => m.id);
    assert.ok(ids.includes(id), `${id} no longer matches its own message: ${message.slice(0, 80)}…`);
  }
});

test("every anchored entry has a sample, and every sample an anchored entry", () => {
  // Without this, adding an anchor without a sample would leave it untested
  // while the suite above still passed.
  const anchored = DIAGNOSTICS.filter((d) => d.anchors.length > 0).map((d) => d.id).sort();
  const sampled = [...new Set(SAMPLES.map(([id]) => id))].sort();
  assert.deepEqual(sampled, anchored);
});

test("every v0.10.0 and retired identifier resolves to a catalogue entry", () => {
  assert.equal(V0_10_0_IDS.length, 54);
  assert.equal(new Set(V0_10_0_IDS).size, V0_10_0_IDS.length, "fixture lists an identifier twice");
  for (const code of [...V0_10_0_IDS, ...RETIRED_IDS]) {
    const entries = DIAGNOSTICS.filter((d) => extIdsOf(d).includes(code));
    assert.ok(entries.length > 0, `${code} has no catalogue entry`);
    if (!SHARED_IDS.has(code)) {
      assert.equal(entries.length, 1, `${code} maps to ${entries.map((e) => e.id).join(", ")}`);
    }
    const scan = scanDiagnostics(`[Exeris] ${code}: reworded in some later release`);
    assert.deepEqual(scan.unrecognisedIds, [], code);
    assert.equal(scan.matches.length, 1, code);
    assert.equal(scan.matches[0].extId, code);
    assert.equal(scan.matches[0].matchedBy, "identifier");
  }
});

test("the catalogue names no identifier upstream does not register", () => {
  const known = new Set([...V0_10_0_IDS, ...RETIRED_IDS]);
  for (const entry of DIAGNOSTICS) {
    for (const code of extIdsOf(entry)) {
      assert.ok(known.has(code), `${entry.id} names ${code}, which v0.10.0 neither registers nor retired`);
    }
  }
});

test("catalogue entries are well-formed and uniquely identified", () => {
  const ids = new Set<string>();
  for (const entry of DIAGNOSTICS) {
    assert.match(entry.id, /^[a-z]+\/[a-z0-9-]+$/, entry.id);
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
    // An entry is reachable by identifier, by text, or both — never by neither.
    assert.ok(entry.anchors.length > 0 || extIdsOf(entry).length > 0, entry.id);
    for (const field of [entry.title, entry.what, entry.why, entry.fix]) {
      assert.ok(field.trim().length > 0, `${entry.id} has an empty field`);
    }
  }
});

// A pasted build log carries several diagnostics, and answering only the first
// would drop the ones underneath it — which are often the actionable ones.
test("a log carrying several diagnostics returns all of them, in printed order", () => {
  const log = [
    `${P}@ExerisDomain.tenantScoped is deprecated for removal in SDK 1.0.0; declare dataScope = DataScope.TENANT instead.`,
    "Capability graph could not be resolved:",
    "  - dependency cycle: com.example.A -> com.example.B -> com.example.A",
  ].join("\n");
  assert.deepEqual(matchDiagnostics(log).map((m) => m.id), [
    "processor/tenant-scoped-deprecated",
    "caps/graph-unresolved",
    "caps/dependency-cycle",
  ]);
});

test("a match carries the fragment it keyed on, so the match can be judged", () => {
  const [match] = matchDiagnostics(`${P}DataScope.UNIVERSE is reserved and is refused here`);
  assert.equal(match?.matchedOn, "DataScope.UNIVERSE is reserved");
});

// The version-mismatch and no-provider cases print differently and both have to
// reach the same entry — a developer sees one or the other, never both.
test("both shapes of an unsatisfied @Requires reach the same entry", () => {
  for (const message of [
    "module com.example.Billing @Requires service payments but no @CapabilityModule provides it",
    "module com.example.Billing @Requires service payments version [1.0,2.0) but no provider matches (providers: com.example.Pay=0.9.0)",
  ]) {
    assert.deepEqual(matchDiagnostics(message).map((m) => m.id), ["caps/unsatisfied-requires"]);
  }
});

test("the four wrong-element-kind messages share one entry", () => {
  for (const annotation of ["ExerisDomain", "Saga", "CapabilityModule", "View"]) {
    const suffix = annotation === "ExerisDomain" || annotation === "Saga" ? "classes" : "a type";
    const ids = matchDiagnostics(`${P}@${annotation} can only be applied to ${suffix}`).map((m) => m.id);
    assert.deepEqual(ids, ["processor/wrong-element-kind"], annotation);
  }
});

test("unrelated text matches nothing", () => {
  assert.deepEqual(matchDiagnostics("BUILD SUCCESS"), []);
});

test("Exeris output is recognised as such even when nothing matches", () => {
  assert.equal(looksLikeExerisOutput(`${P}some diagnostic added after this catalogue`), true);
  assert.equal(looksLikeExerisOutput("could not resolve eu.exeris:exeris-sdk-annotations:jar"), true);
  assert.equal(looksLikeExerisOutput("Failed to execute goal exeris:generate on project app"), true);
  assert.equal(looksLikeExerisOutput("[Exeris] EXT-PROC-9999: unknown code"), true);
  assert.equal(looksLikeExerisOutput("error: cannot find symbol\n  symbol: class Foo"), false);
});

test("matches catalogue entries directly by EXT- identifier (ADR-095)", () => {
  const line = "[Exeris] EXT-PROC-1001: @ExerisDomain can only be applied to classes";
  const matches = matchDiagnostics(line);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "processor/wrong-element-kind");
  assert.equal(matches[0].extId, "EXT-PROC-1001");
  assert.equal(matches[0].matchedOn, "EXT-PROC-1001");
});

test("matches by EXT- identifier even when message text is reworded", () => {
  const line = "[Exeris] EXT-PROC-1101: completely reworded warning message in future tooling";
  const matches = matchDiagnostics(line);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "processor/tenant-scoped-deprecated");
  assert.equal(matches[0].extId, "EXT-PROC-1101");
  assert.equal(matches[0].matchedOn, "EXT-PROC-1101");
});

test("matches multiple EXT- codes in a build log in printed order", () => {
  const log = [
    "[Exeris] EXT-PROC-1101: tenantScoped warning",
    "[ERROR] Failed to execute goal ...: [Exeris] EXT-PLUG-2001: Refusing to wipe",
    "[Exeris] EXT-PLUG-2302: No kernel driver",
  ].join("\n");

  const matches = matchDiagnostics(log);
  assert.deepEqual(
    matches.map((m) => m.id),
    ["processor/tenant-scoped-deprecated", "codegen/empty-metadata-refusal", "runtime/no-kernel-driver"],
  );
  assert.deepEqual(
    matches.map((m) => m.extId),
    ["EXT-PROC-1101", "EXT-PLUG-2001", "EXT-PLUG-2302"],
  );
});

test("disambiguates shared EXT-PLUG-2201 using anchors when available", () => {
  const cycleLog = "[Exeris] EXT-PLUG-2201: dependency cycle: com.example.A -> com.example.B -> com.example.A";
  const cycleMatches = matchDiagnostics(cycleLog);
  assert.equal(cycleMatches.length, 1);
  assert.equal(cycleMatches[0].id, "caps/dependency-cycle");
  assert.equal(cycleMatches[0].extId, "EXT-PLUG-2201");

  const requiresLog =
    "[Exeris] EXT-PLUG-2201: module com.example.Billing @Requires service payments but no @CapabilityModule provides it";
  const requiresMatches = matchDiagnostics(requiresLog);
  assert.equal(requiresMatches.length, 1);
  assert.equal(requiresMatches[0].id, "caps/unsatisfied-requires");
  assert.equal(requiresMatches[0].extId, "EXT-PLUG-2201");
});

test("all defined extId entries in DIAGNOSTICS conform to the EXT- naming convention", () => {
  for (const entry of DIAGNOSTICS) {
    if (entry.extId !== undefined) {
      const ids = Array.isArray(entry.extId) ? entry.extId : [entry.extId];
      for (const id of ids) {
        assert.match(id, /^EXT-[A-Z]+-\d{4}$/, `${entry.id} invalid extId ${id}`);
      }
    }
  }
});

test("matches both EXT- diagnostic and un-coded pre-0.9.0 diagnostic in a mixed build log", () => {
  const mixedLog = [
    "[Exeris] EXT-PROC-1001: @ExerisDomain can only be applied to classes",
    "[Exeris] @ExerisDomain.dataScope = DataScope.UNIVERSE is reserved and is refused here rather than half-emitted.",
  ].join("\n");

  const matches = matchDiagnostics(mixedLog);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].id, "processor/wrong-element-kind");
  assert.equal(matches[0].extId, "EXT-PROC-1001");
  assert.equal(matches[1].id, "processor/universe-tier-reserved");
  assert.equal(matches[1].extId, null);
  assert.equal(matches[1].matchedOn, "DataScope.UNIVERSE is reserved");
});

// The umbrella answers when the text under a shared identifier names none of
// the specific problems: it is the one entry that is true of every 2201.
test("a shared identifier whose text no anchor recognises falls back to the umbrella entry", () => {
  const unknown2201 = "[Exeris] EXT-PLUG-2201: some brand new capability composition error with no known anchor";
  const matches = matchDiagnostics(unknown2201);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "caps/graph-unresolved");
  assert.equal(matches[0].extId, "EXT-PLUG-2201");
  assert.equal(matches[0].matchedOn, "EXT-PLUG-2201");
});

test("disambiguates multiple EXT-PLUG-2201 diagnostics in the same log at their correct positions", () => {
  const multi2201 = [
    "[Exeris] EXT-PLUG-2201: dependency cycle: com.example.A -> com.example.B -> com.example.A",
    "[Exeris] EXT-PLUG-2201: module com.example.Billing @Requires service payments but no @CapabilityModule provides it",
  ].join("\n");

  const matches = matchDiagnostics(multi2201);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].id, "caps/dependency-cycle");
  assert.equal(matches[0].extId, "EXT-PLUG-2201");
  assert.equal(matches[1].id, "caps/unsatisfied-requires");
  assert.equal(matches[1].extId, "EXT-PLUG-2201");
});



test("an identifier and its own message text in one paste give one match, by identifier", () => {
  const line = `warning: ${P}EXT-PROC-1101: @ExerisDomain.tenantScoped is deprecated for removal in SDK 1.0.0; declare dataScope = DataScope.TENANT instead.`;
  const matches = matchDiagnostics(line);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "processor/tenant-scoped-deprecated");
  assert.equal(matches[0].matchedBy, "identifier");
  assert.equal(matches[0].matchedOn, "EXT-PROC-1101");
  assert.deepEqual(matches[0].extIds, ["EXT-PROC-1101"]);
});

test("a text match carries no printed identifier but names the ones its entry explains", () => {
  const [match] = matchDiagnostics(`${P}@ExerisDomain.apiVersion is set but no code generator consumes it`);
  assert.equal(match?.id, "processor/inert-attribute");
  assert.equal(match?.matchedBy, "text");
  assert.equal(match?.extId, null);
  assert.deepEqual(match?.extIds, ["EXT-PROC-1201", "EXT-PROC-1202"]);
});

// A well-formed identifier is upstream's closed registry speaking. With no
// entry for it, the honest answer names it as a gap — and it must not fall
// through to a text anchor that would explain a different diagnostic.
test("an unknown well-formed identifier is reported as unrecognised, not matched on its text", () => {
  const line = `${P}EXT-PROC-1999: Cap-tier Wall violated in a way no release has printed yet`;
  const scan = scanDiagnostics(line);
  assert.deepEqual(scan.matches, []);
  assert.deepEqual(scan.unrecognisedIds, ["EXT-PROC-1999"]);
});

test("an identifier from an area this catalogue has never seen is still detected", () => {
  const scan = scanDiagnostics(`${P}EXT-TS-4001: emitted by a future TypeScript emitter`);
  assert.deepEqual(scan.unrecognisedIds, ["EXT-TS-4001"]);
  assert.equal(looksLikeExerisOutput("EXT-TS-4001"), true);
});

test("EXT-INIT identifiers from exeris-initializr are detected and resolved", () => {
  const out = [
    `${P}EXT-INIT-5002: /work/shop is not empty; nothing was written. Pass --force to write over it.`,
    `${P}EXT-INIT-5001: unknown switch --topolgy`,
  ].join("\n");
  const matches = matchDiagnostics(out);
  assert.deepEqual(matches.map((m) => m.id), ["initializr/target-not-empty", "initializr/arguments-invalid"]);
  assert.deepEqual(matches.map((m) => m.source), ["initializr", "initializr"]);
  assert.ok(EXT_ID_PATTERN.test("EXT-INIT-5003"));
});

test("a bare identifier, pasted alone, resolves", () => {
  assert.deepEqual(matchDiagnostics("EXT-GEN-3003").map((m) => m.id), ["codegen/field-type-not-persistable"]);
});

test("a kernel EX- code is not mistaken for a tooling identifier", () => {
  const scan = scanDiagnostics("EX-MEM-0001: arena exhausted");
  assert.deepEqual(scan.matches, []);
  assert.deepEqual(scan.unrecognisedIds, []);
});

// An optional requirement prints the same sentence as an unsatisfied one. The
// identifier says which it is, and the text inside it must not add the error.
test("an optional-requirement warning does not also read as an unsatisfied @Requires", () => {
  const coded =
    "WARNING: [Exeris] EXT-GEN-3102: capability: module com.example.Billing @Requires service audit but no @CapabilityModule provides it (optional — skipped)";
  assert.deepEqual(matchDiagnostics(coded).map((m) => m.id), ["caps/optional-requirement-skipped"]);

  const uncoded =
    "capability: module com.example.Billing @Requires service audit version [1.0,2.0) but no provider matches (providers: com.example.Audit=0.9.0) (optional — skipped)";
  assert.deepEqual(matchDiagnostics(uncoded).map((m) => m.id), ["caps/optional-requirement-skipped"]);
});

// Maven prefixes every line of a goal failure with its level tag, so the
// indented problem lines under EXT-PLUG-2201 arrive as "[ERROR]   - …".
test("a Maven-tagged multi-line 2201 resolves its problem lines under the identifier", () => {
  const log = [
    "[ERROR] Failed to execute goal eu.exeris:exeris-codegen-maven-plugin:0.10.0:verify-capabilities (default) on project shop: [Exeris] EXT-PLUG-2201: Capability graph could not be resolved:",
    "[ERROR]   - module com.example.Billing @Requires service payments but no @CapabilityModule provides it",
    "[ERROR]   - dependency cycle: com.example.A -> com.example.B -> com.example.A",
    "[ERROR] -> [Help 1]",
  ].join("\n");
  const matches = matchDiagnostics(log);
  assert.deepEqual(matches.map((m) => m.id), [
    "caps/graph-unresolved",
    "caps/unsatisfied-requires",
    "caps/dependency-cycle",
  ]);
  for (const m of matches) {
    assert.equal(m.extId, "EXT-PLUG-2201");
    assert.equal(m.matchedBy, "identifier");
  }
});

test("known and unknown identifiers in one log are both reported", () => {
  const log = [`${P}EXT-PLUG-2302: The generated application has no kernel driver`, `${P}EXT-PLUG-2999: new`].join("\n");
  const scan = scanDiagnostics(log);
  assert.deepEqual(scan.matches.map((m) => m.id), ["runtime/no-kernel-driver"]);
  assert.deepEqual(scan.unrecognisedIds, ["EXT-PLUG-2999"]);
});
