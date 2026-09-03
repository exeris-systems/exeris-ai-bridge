import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DIAGNOSTICS,
  looksLikeExerisOutput,
  matchDiagnostics,
  PROCESSOR_PREFIX,
} from "./diagnostics.js";

const P = PROCESSOR_PREFIX;

/**
 * One real message per catalogue entry, transcribed from the producer —
 * ExerisDomainProcessor, EmptyMetadataException, DetachMojo, CapabilityGraph,
 * CapTierWallException, VerifyCapabilitiesMojo, VerifyRuntimeMojo.
 *
 * This table is the drift detector. The catalogue matches on message text
 * because the build emits no diagnostic codes, so the failure mode is a
 * reworded message that silently stops matching. Any entry whose anchor no
 * longer finds its own real message fails here.
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
];

test("every catalogue entry still matches a real message from the producer", () => {
  for (const [id, message] of SAMPLES) {
    const ids = matchDiagnostics(message).map((m) => m.id);
    assert.ok(ids.includes(id), `${id} no longer matches its own message: ${message.slice(0, 80)}…`);
  }
});

test("every catalogue entry has a sample, and every sample a catalogue entry", () => {
  // Without this, adding an entry without a sample would leave it untested
  // while the suite above still passed.
  const catalogue = DIAGNOSTICS.map((d) => d.id).sort();
  const sampled = [...new Set(SAMPLES.map(([id]) => id))].sort();
  assert.deepEqual(sampled, catalogue);
});

test("catalogue entries are well-formed and uniquely identified", () => {
  const ids = new Set<string>();
  for (const entry of DIAGNOSTICS) {
    assert.match(entry.id, /^[a-z]+\/[a-z0-9-]+$/, entry.id);
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.anchors.length > 0, entry.id);
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

// The catalogue's silence is a fact about the catalogue. This flag only chooses
// which kind of "no entry" sentence to give; it never becomes a verdict.
test("Exeris output is recognised as such even when nothing matches", () => {
  assert.equal(looksLikeExerisOutput(`${P}some diagnostic added after this catalogue`), true);
  assert.equal(looksLikeExerisOutput("could not resolve eu.exeris:exeris-sdk-annotations:jar"), true);
  assert.equal(looksLikeExerisOutput("Failed to execute goal exeris:generate on project app"), true);
  assert.equal(looksLikeExerisOutput("error: cannot find symbol\n  symbol: class Foo"), false);
});
