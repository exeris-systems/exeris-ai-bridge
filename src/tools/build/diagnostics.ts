// A decoder for the diagnostics the Exeris build prints — the annotation
// processor's javac messages and the codegen plugin's Maven failures.
//
// WHY THIS IS A CATALOGUE AND NOT A LOOKUP.
//
// There is no diagnostic-code registry upstream. The processor prefixes every
// message with `DIAG_PREFIX = "[Exeris] "` and writes free text; the plugin
// throws Mojo failures carrying a sentence. So there is a channel to key on and
// no stable identifier to key with, and this file matches on message text.
//
// That is a real weakness and it is bounded deliberately:
//
//   1. Anchors are the STABLE SPINE of a message, not the sentence. They are
//      the SDK's own public vocabulary — `@ExerisDomain.tenantScoped`,
//      `DataScope.UNIVERSE`, `@GraphEdge` — or a distinctive verb phrase that
//      would not survive being reworded into something meaning anything else.
//      Prose around them can be rewritten without breaking a match.
//   2. A miss is reported as a miss. Not recognising a diagnostic never becomes
//      "that is not an Exeris problem" — the catalogue's silence is a fact
//      about the catalogue.
//   3. Every match echoes what it matched on, so a caller can see the match was
//      a text hit and judge it.
//
// The `id` on each entry is THIS BRIDGE'S, not upstream's. It exists so an
// agent can refer to an entry twice in one conversation; it is not a code the
// build prints, and quoting it back to the build means nothing. When
// exeris-tooling grows a real code registry, these ids give way to it.

export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticSource =
  | "annotation-processor"
  | "codegen-plugin"
  | "capability-graph"
  | "cap-tier-wall"
  | "runtime-verifier";

export interface DiagnosticEntry {
  /** This bridge's identifier for the entry. Not a code the build emits. */
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  readonly title: string;
  /** What the build is saying. */
  readonly what: string;
  /** The rule underneath it — why the build refuses, or why it warns. */
  readonly why: string;
  /** What to actually do. */
  readonly fix: string;
  readonly reference?: string;
  readonly anchors: readonly (string | RegExp)[];
}

export interface DiagnosticMatch {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly reference: string | null;
  /** The exact text this entry matched on — the evidence for the match. */
  readonly matchedOn: string;
}

/** `ExerisDomainProcessor.DIAG_PREFIX`, on every diagnostic the processor emits. */
export const PROCESSOR_PREFIX = "[Exeris] ";

/** A paste beyond this is a build log, not a diagnostic; scanning it all is waste. */
export const MAX_DIAGNOSTIC_CHARS = 64_000;

export const DIAGNOSTICS: readonly DiagnosticEntry[] = [
  {
    id: "processor/wrong-element-kind",
    severity: "error",
    source: "annotation-processor",
    title: "An Exeris annotation is on an element it cannot apply to",
    what: "The processor found an SDK annotation on a member, package or annotation type instead of the class or type it declares.",
    why: "@ExerisDomain, @Saga, @CapabilityModule and @View each describe a whole type. There is no metadata shape for a partial declaration, so the processor refuses rather than emitting one.",
    fix: "Move the annotation onto the class or interface declaration itself.",
    anchors: [/@(\w+) can only be applied to (?:a )?(?:class|classes|type)/],
  },
  {
    id: "processor/processing-failure",
    severity: "error",
    source: "annotation-processor",
    title: "The processor threw while reading a declaration",
    what: "An exception escaped while the processor was building metadata for one enum, capability module, view, entity or saga. The message carries the exception's class and text.",
    why: "This is a processor-side failure, not a rule the source broke — which is why the exception is reported verbatim rather than translated into advice.",
    fix: "Re-run with -Aexeris.verbose=true to get the stack trace alongside the message. If the trace is inside the processor rather than in your own code, it belongs in an exeris-tooling issue with the declaration that triggered it.",
    anchors: [/Failed to process (?:enum|capability module|view|domain entity|saga)/],
  },
  {
    id: "processor/datascope-contradiction",
    severity: "error",
    source: "annotation-processor",
    title: "dataScope and tenantScoped say two different things",
    what: "One @ExerisDomain declares both a dataScope tier and a tenantScoped boolean, and they disagree.",
    why: "ADR-059 makes this a build error rather than resolving it by precedence: whichever side lost would be a silent tenancy decision on an entity whose author has already said two contradictory things about it.",
    fix: "Declare the tier once. Drop tenantScoped — it is deprecated for removal in SDK 1.0.0 — and keep dataScope.",
    reference: "ADR-059",
    anchors: [/dataScope = DataScope\.\w+ and tenantScoped =/],
  },
  {
    id: "processor/universe-tier-reserved",
    severity: "error",
    source: "annotation-processor",
    title: "DataScope.UNIVERSE is reserved and refused",
    what: "An entity declares dataScope = DataScope.UNIVERSE, which the build refuses rather than half-emitting.",
    why: "The kernel carrier exists (sharedScopeKey, read-widen / write-pin RLS) but the codegen transcription for it does not. Emitting anyway would produce the TENANT shape — an owner column, an owner-pinned policy, a repository binding getTenantId() — against a shared-world row that has no tenant property, so the build would fail with 'cannot find symbol' inside generated code you are told not to edit.",
    fix: "Declare dataScope = TENANT if the entity really is partitioned by an owner, and give it a tenant property. There is no way to obtain cross-tenant read-widening from this build yet.",
    reference: "ADR-059",
    anchors: ["DataScope.UNIVERSE is reserved"],
  },
  {
    id: "processor/repeated-graph-edge",
    severity: "error",
    source: "annotation-processor",
    title: "Two @GraphEdge declarations on one field",
    what: "A field carries more than one @GraphEdge, and the pipeline cannot carry that.",
    why: "GraphEdgeMetadata identifies an edge by the field it is declared on, and the graph-sync generator derives the entity getter from the same value — so two edges on one field would need one name to be both.",
    fix: "Declare each edge on its own field. If the model genuinely needs two edges from one value, that is an SDK change giving GraphEdgeMetadata a separate identity component.",
    anchors: [/@GraphEdge is declared \d+ times on field/],
  },
  {
    id: "processor/tenant-scoped-deprecated",
    severity: "warning",
    source: "annotation-processor",
    title: "@ExerisDomain.tenantScoped is deprecated for removal",
    what: "The boolean is still read as a fallback for this build, and the message names the tier it mapped to.",
    why: "The attribute goes away at SDK 1.0.0. It warns rather than silently accepting, because a silent equivalence would let the whole deprecation window pass without anyone noticing.",
    fix: "Replace tenantScoped with the dataScope tier the warning names. See MIGRATION.md in exeris-sdk.",
    anchors: ["@ExerisDomain.tenantScoped is deprecated"],
  },
  {
    id: "processor/validation-attribute-deprecated",
    severity: "warning",
    source: "annotation-processor",
    title: "A deprecated @Validation attribute is being read as a fallback",
    what: "The attribute still works in this build and the message names its canonical replacement.",
    why: "This is the @Field vs @Validation split: @Field carries shape and lifecycle, @Validation carries constraints. The attributes that crossed that line are deprecated for removal at SDK 1.0.0, with a warn-and-read window until then.",
    fix: "Move to the replacement the warning names — code that compiles with this warning today stops compiling at SDK 1.0.0. See MIGRATION.md in exeris-sdk.",
    anchors: [/@Validation\.\w+ is deprecated for removal/],
  },
  {
    id: "processor/validate-on-unrecognised",
    severity: "warning",
    source: "annotation-processor",
    title: "@Validation.validateOn has an unrecognised value",
    what: "The value is neither \"CREATE\" nor \"UPDATE\", so NO fallback was applied.",
    why: "This one differs from the other deprecation warnings in the way that matters: they degrade to a working equivalent, and this one does not. The intent is being dropped now, and will keep being dropped after SDK 1.0.0 removes the attribute.",
    fix: "Migrate to @Field.inCreate / @Field.inUpdate, which is where form-lifecycle scope belongs.",
    anchors: [/@Validation\.validateOn = ".*" is not a/],
  },
  {
    id: "processor/inert-attribute",
    severity: "warning",
    source: "annotation-processor",
    title: "An attribute is set but no generator consumes it",
    what: "Part of the -Aexeris.strict audit: the attribute is read by the processor but nothing downstream acts on it, so it has no effect on emitted output.",
    why: "Strict mode exists to surface exactly this — an annotation that looks load-bearing and is not. Without it, the attribute reads as configured behaviour that silently never happens.",
    fix: "Remove the attribute, or keep it and accept it is inert for now. It is reported only under -Aexeris.strict, so it never fails a default build.",
    anchors: ["is set but no code generator consumes it"],
  },
  {
    id: "processor/unread-annotation",
    severity: "warning",
    source: "annotation-processor",
    title: "An annotation the processor never reads",
    what: "Part of the -Aexeris.strict audit, and stronger than the inert-attribute case: the processor does not read this annotation at all, so no generator could consume it even in principle.",
    why: "The audit iterates the element's own mirrors rather than a registry, which is what makes it complete — an annotation nobody has classified still shows up, with a generic reason.",
    fix: "Remove it, or confirm from the SDK docs that it is design-time only. Reported only under -Aexeris.strict.",
    anchors: ["is set but this processor never reads it"],
  },
  {
    id: "codegen/empty-metadata-refusal",
    severity: "error",
    source: "codegen-plugin",
    title: "Codegen refused to wipe the committed generated tree",
    what: "Zero @ExerisDomain entities were loaded, while the previous run owns generated files that exeris:generate would now DELETE.",
    why: "Empty metadata is almost always a masked compile failure — the annotation processor did not run — rather than an intentional teardown. The refusal is what stops a broken compile from silently deleting a committed tree.",
    fix: "Verify the project compiles first. The safe recipe is a metadata-only pass: `mvn compile -Dexeris.codegen.skip=true`, then re-run exeris:generate. Only if you genuinely removed every @ExerisDomain type, re-run with -Dexeris.codegen.allowEmpty=true.",
    anchors: ["Refusing to wipe the committed generated tree"],
  },
  {
    id: "codegen/detach-conflicts",
    severity: "error",
    source: "codegen-plugin",
    title: "Detach left conflicts",
    what: "exeris:detach found files already present at the target and left them in place rather than overwriting them.",
    why: "Detach never overwrites a file you own. A conflict means that path exists in both the generated tree and src/main/java, so promoting it would destroy one of the two.",
    fix: "Reconcile each conflicting path by hand — decide which copy is the one you want — then re-run. Setting exeris.failOnConflict=false downgrades the failure to a warning but does not promote the conflicting files.",
    anchors: [/Detach left \d+ conflict/],
  },
  {
    id: "caps/unsatisfied-requires",
    severity: "error",
    source: "capability-graph",
    title: "A @Requires has no matching @Provides",
    what: "A capability module requires a service that either nothing provides, or that no provider matches at the required version range. The message lists the candidate providers and their versions when there are any.",
    why: "The graph is resolved at build time, so an unsatisfiable composition fails the build rather than the boot. A version mismatch reads differently from a missing provider — 'no provider matches (providers: …)' means the service exists at the wrong version.",
    fix: "Add the module that provides the service, or widen the version range on the @Requires. Call caps-list_capabilities to see what this project actually composes.",
    reference: "ADR-024",
    anchors: ["but no @CapabilityModule provides it", "but no provider matches (providers:"],
  },
  {
    id: "caps/dependency-cycle",
    severity: "error",
    source: "capability-graph",
    title: "A cycle in the capability dependency graph",
    what: "Modules depend on each other in a loop, so no initialisation order exists. The message prints the cycle.",
    why: "initOrder is a topological sort, and a cycle has none. Self-provision is not a cycle and is not reported as one.",
    fix: "Break the loop: move the shared piece into a third module both can require, or drop the @Requires that closes the cycle.",
    reference: "ADR-024",
    anchors: ["dependency cycle:"],
  },
  {
    id: "caps/graph-unresolved",
    severity: "error",
    source: "capability-graph",
    title: "The capability graph could not be resolved",
    what: "The umbrella failure. The lines under it are the individual problems — unsatisfied requirements, version mismatches, cycles.",
    why: "Every problem is collected and reported together rather than failing at the first, so one build tells you the whole story.",
    fix: "Read the indented lines: each is its own diagnostic and can be pasted back here on its own.",
    reference: "ADR-024",
    anchors: ["Capability graph could not be resolved"],
  },
  {
    id: "caps/wall-violated",
    severity: "error",
    source: "cap-tier-wall",
    title: "The cap-tier Wall was breached",
    what: "A capability module references something the tier boundary forbids. The message lists each forbidden reference.",
    why: "ADR-024 predicate 4 makes the ADR-023 detachment guarantee mechanical: a detached capability must carry no hidden classpath. The guard checks that rather than asserting it.",
    fix: "Remove the forbidden reference, or move the code that needs it out of the capability module.",
    reference: "ADR-024 predicate 4",
    anchors: ["Cap-tier Wall violated"],
  },
  {
    id: "caps/wall-scanned-nothing",
    severity: "warning",
    source: "cap-tier-wall",
    title: "The Wall guard scanned nothing",
    what: "This build IS a capability — the graph gate saw modules — yet the Wall found no compiled classes to scan.",
    why: "Predicate 4 is then unverified, not satisfied. The warning exists so that a clean-looking build does not read as a passing Wall check.",
    fix: "Check exeris.classesDir, and that compilation ran before verification.",
    reference: "ADR-024 predicate 4",
    anchors: ["Cap-tier Wall scanned nothing"],
  },
  {
    id: "runtime/no-kernel-driver",
    severity: "error",
    source: "runtime-verifier",
    title: "No kernel driver on the runtime classpath",
    what: "The generated application requires SPIs that no registered provider on this module's runtime classpath satisfies. The message lists which.",
    why: "Without the check, Application.main() would fail at boot naming a subsystem rather than a missing dependency — a much harder failure to read.",
    fix: "Add a runtime driver to this module's dependencies; the message suggests one. If this module only generates code for another module to run, set -Dexeris.verifyRuntime.skip=true.",
    anchors: ["has no kernel driver on its runtime classpath"],
  },
];

/**
 * Find every catalogue entry the pasted text matches.
 *
 * All matches are returned, deduplicated by id: a pasted build log genuinely
 * carries several diagnostics, and picking one would drop the rest. Order is
 * by position in the text, so the answer reads in the order the build printed.
 */
export function matchDiagnostics(text: string): DiagnosticMatch[] {
  const found: { at: number; match: DiagnosticMatch }[] = [];
  for (const entry of DIAGNOSTICS) {
    const hit = firstAnchorHit(text, entry.anchors);
    if (hit === null) continue;
    found.push({
      at: hit.at,
      match: {
        id: entry.id,
        severity: entry.severity,
        source: entry.source,
        title: entry.title,
        what: entry.what,
        why: entry.why,
        fix: entry.fix,
        reference: entry.reference ?? null,
        matchedOn: hit.text,
      },
    });
  }
  found.sort((a, b) => a.at - b.at || a.match.id.localeCompare(b.match.id));
  return found.map((f) => f.match);
}

function firstAnchorHit(
  text: string,
  anchors: readonly (string | RegExp)[],
): { at: number; text: string } | null {
  let best: { at: number; text: string } | null = null;
  for (const anchor of anchors) {
    if (typeof anchor === "string") {
      const at = text.indexOf(anchor);
      if (at !== -1 && (best === null || at < best.at)) best = { at, text: anchor };
    } else {
      const m = anchor.exec(text);
      if (m && (best === null || m.index < best.at)) best = { at: m.index, text: m[0] };
    }
  }
  return best;
}

/**
 * Does this text look like it came from an Exeris build at all?
 *
 * Used only to decide which kind of "no catalogue entry" answer to give. It is
 * never used to tell a caller their problem is not an Exeris problem — this
 * server cannot know that, and the honest failure is "not in the catalogue".
 */
export function looksLikeExerisOutput(text: string): boolean {
  return (
    text.includes(PROCESSOR_PREFIX) ||
    text.includes("eu.exeris") ||
    text.includes("@ExerisDomain") ||
    /\bexeris:(generate|detach|verify-capabilities|verify-runtime)\b/.test(text)
  );
}
