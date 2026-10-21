// A decoder for the diagnostics exeris-tooling prints — the annotation
// processor's javac messages, the codegen Maven plugin's goal failures and
// warnings, the code-generation pipeline's log lines and its `CodegenMain`
// command line, and the `exeris-initializr` command line.
//
// WHY ENTRIES ARE KEYED ON IDENTIFIERS, WITH TEXT ANCHORS BEHIND THEM.
//
// Every diagnostic exeris-tooling prints carries a stable identifier in a fixed
// position, `[Exeris] EXT-<AREA>-<NNNN>: <message>` (ADR-095), allocated from
// one closed registry, `eu.exeris.tooling.diagnostics.DiagnosticId`. An
// identifier names one meaning for as long as it exists and is never reused;
// the text after it is written for a person and may be reworded in any
// release. So the identifier is the key: an entry's `extId` is what a paste is
// looked up by, and a rewording upstream cannot break the lookup. Because the
// registry is closed, coverage is checkable rather than sampled —
// diagnostics.test.ts carries the released registry's full list and fails when
// an identifier has no entry here.
//
// Text anchors remain for output that carries no identifier, which is what
// exeris-tooling releases before 0.9.0 print. A text match is a real weakness,
// and it is bounded deliberately:
//
//   1. Anchors are the STABLE SPINE of a message, not the sentence. They are
//      the SDK's own public vocabulary — `@ExerisDomain.tenantScoped`,
//      `DataScope.UNIVERSE`, `@GraphEdge` — or a distinctive phrase that
//      would not survive being reworded into something meaning anything else.
//   2. An anchor reads only text no identifier has claimed. A line carrying an
//      identifier IS that diagnostic; inside it, an anchor may only choose
//      between entries that share the identifier (see diagnostics.ts).
//   3. Every match echoes what it matched on and whether it matched by
//      identifier or by text, so a caller can judge a text hit as one.
//
// An entry whose message was never printed without its identifier carries no
// anchors: there is no identifier-less output for them to recognise.
//
// A miss is reported as a miss. Not recognising a diagnostic never becomes
// "that is not an Exeris problem" — the catalogue's silence is a fact about
// the catalogue. A well-formed identifier with no entry is named back to the
// caller as a gap here, with exeris-tooling's own table as the place to look.
//
// Retired identifiers keep their entries. Retiring one stops it being printed
// by later releases, not by the release a developer is still running, and its
// number is never reallocated, so the entry cannot come to mean something else.
//
// The `id` on each entry is THIS BRIDGE'S, not upstream's. It exists so an
// agent can refer to an entry twice in one conversation, and so that one
// upstream identifier can map to several entries where the build prints
// distinguishable messages under it (the capability-graph failure,
// EXT-PLUG-2201, names an unsatisfied @Requires and a cycle differently). It is
// not a code the build prints, and quoting it back to the build means nothing.

export type DiagnosticSeverity = "error" | "warning" | "note";

export type DiagnosticSource =
  | "annotation-processor"
  | "codegen-plugin"
  | "codegen-pipeline"
  | "capability-graph"
  | "cap-tier-wall"
  | "runtime-verifier"
  | "initializr";

export interface DiagnosticEntry {
  /** This bridge's identifier for the entry. Not a code the build emits. */
  readonly id: string;
  /**
   * The exeris-tooling identifier(s) this entry explains (ADR-095). Absent only
   * for a diagnostic that tooling stopped printing before identifiers existed.
   */
  readonly extId?: string | readonly string[];
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
  /**
   * Message fragments that recognise output carrying no identifier, and that
   * choose between entries sharing one identifier. Empty for a diagnostic that
   * was never printed without its identifier.
   */
  readonly anchors: readonly (string | RegExp)[];
}

/** The identifiers an entry explains, as a list. */
export function extIdsOf(entry: DiagnosticEntry): readonly string[] {
  if (entry.extId === undefined) return [];
  return typeof entry.extId === "string" ? [entry.extId] : entry.extId;
}

export const DIAGNOSTICS: readonly DiagnosticEntry[] = [
  // -------------------------------------------------------------------------
  // EXT-PROC-10xx — the annotation processor refuses a declaration (javac error)
  // -------------------------------------------------------------------------
  {
    id: "processor/wrong-element-kind",
    extId: "EXT-PROC-1001",
    severity: "error",
    source: "annotation-processor",
    title: "An Exeris annotation is on an element it cannot apply to",
    what: "The processor found @ExerisDomain or @Saga on something that is not a class, or @CapabilityModule or @View on something that is not a type.",
    why: "@ExerisDomain, @Saga, @CapabilityModule and @View each describe a whole type. There is no metadata shape for a partial declaration, so the processor refuses rather than emitting one.",
    fix: "Move @ExerisDomain or @Saga onto a class declaration — an interface, enum or record is not accepted for these two — and @CapabilityModule or @View onto a type declaration.",
    anchors: [/@(\w+) can only be applied to (?:a )?(?:class|classes|type)/],
  },
  {
    id: "processor/processing-failure",
    extId: "EXT-PROC-1002",
    severity: "error",
    source: "annotation-processor",
    title: "The processor threw while reading a declaration",
    what: "An exception escaped while the processor was building metadata for one enum, capability module, view, entity or saga, and no metadata was written for it. The message carries the exception's class and text.",
    why: "This is a processor-side failure, not a rule the source broke — which is why the exception is reported verbatim rather than translated into advice.",
    fix: "Re-run with -Aexeris.verbose=true to get the stack trace alongside the message. If your source is valid and the trace is inside the processor, it belongs in an exeris-tooling issue with the declaration that triggered it.",
    anchors: [/Failed to process (?:enum|capability module|view|domain entity|saga)/],
  },
  {
    id: "processor/datascope-contradiction",
    extId: "EXT-PROC-1003",
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
    id: "processor/public-route-with-permissions",
    extId: "EXT-PROC-1004",
    severity: "error",
    source: "annotation-processor",
    title: "@RouteAccess(PUBLIC) on a route that declares permissions",
    what: "@RouteAccess(PUBLIC) is on an entity that declares @ExerisDomain.permissions, or on an action method that declares @Action.permissions.",
    why: "A public route runs its handler with no principal bound, so a permission on it can never be satisfied — the pair is a contradiction, not a redundancy. @RouteAccess resolves nearest declaration first (a method-level one overrides the type-level one), and the check runs against the level each route actually gets. Only the refusal is implemented: the access level itself reaches no generated route yet, which -Aexeris.strict reports as inert.",
    fix: "Drop the permissions, or declare @RouteAccess(AUTHENTICATED).",
    anchors: [],
  },
  {
    id: "processor/action-permissions-on-public-route",
    extId: "EXT-PROC-1005",
    severity: "error",
    source: "annotation-processor",
    title: "An action declares permissions but inherits a public route",
    what: "An action method declares @Action.permissions and no @RouteAccess of its own, so it inherits @RouteAccess(PUBLIC) from its type and its route is public.",
    why: "Same contradiction as a public route with permissions, reached by inheritance: with no method-level @RouteAccess the type's level applies, and a public route runs with no principal bound, so the permission can never be satisfied.",
    fix: "Drop the method's permissions, or declare @RouteAccess(AUTHENTICATED) on the method itself.",
    anchors: [],
  },
  {
    id: "processor/universe-without-owner",
    extId: "EXT-PROC-1006",
    severity: "error",
    source: "annotation-processor",
    title: "A DataScope.UNIVERSE entity has no owning tenant field",
    what: "The entity declares dataScope = DataScope.UNIVERSE but has no owner field — 'tenantId', or the field its @TenantId marker or tenantIdField override names.",
    why: "A UNIVERSE row is owned by a tenant and readable across its shared scope: reads widen, writes stay pinned to the owner. A shared-scope key requires an isolation key (kernel ADR-012 §4b.2), so the tier cannot exist without one.",
    fix: "Declare `private UUID tenantId;`, or mark the field that plays the role with @TenantId, beside the @SharedScope field.",
    reference: "ADR-059",
    anchors: [],
  },
  {
    id: "processor/universe-without-shared-scope",
    extId: "EXT-PROC-1007",
    severity: "error",
    source: "annotation-processor",
    title: "A DataScope.UNIVERSE entity has no @SharedScope field",
    what: "The entity declares dataScope = DataScope.UNIVERSE and no field is marked @SharedScope.",
    why: "@SharedScope marks the column the generated policy compares against the shared scope the kernel publishes. Without one nothing widens, and the tier would silently behave as TENANT.",
    fix: "Mark the UUID or String field that holds the row's shared-scope key with @SharedScope, or declare dataScope = TENANT if the rows are not shared.",
    reference: "ADR-059",
    anchors: [],
  },
  {
    id: "processor/shared-scope-wrong-type",
    extId: "EXT-PROC-1008",
    severity: "error",
    source: "annotation-processor",
    title: "The @SharedScope field is neither UUID nor String",
    what: "The field marked @SharedScope has some other type; the message names it.",
    why: "The shared-scope key is compared with the session setting the kernel publishes, which is a UUID or a string. A column of any other type has nothing to be compared with.",
    fix: "Declare the field as java.util.UUID or java.lang.String.",
    anchors: [],
  },
  {
    id: "processor/shared-scope-on-owner-field",
    extId: "EXT-PROC-1009",
    severity: "error",
    source: "annotation-processor",
    title: "@SharedScope is on the owning tenant field",
    what: "The field marked @SharedScope is also the entity's owning tenant field.",
    why: "They are two predicates over two columns: the owner pins writes, the shared scope widens reads. One field cannot be both.",
    fix: "Put @SharedScope on a separate field.",
    anchors: [],
  },
  {
    id: "processor/shared-scope-required",
    extId: "EXT-PROC-1010",
    severity: "error",
    source: "annotation-processor",
    title: "The @SharedScope field is declared required",
    what: "The field marked @SharedScope carries required = true.",
    why: "The generated repository fills an absent shared scope from the bound StorageContext, but a required field is refused with 400 by the generated handler and made NOT NULL by the migration — both before that stamp can run.",
    fix: "Drop required = true. A row with no shared scope is simply owner-private.",
    anchors: [],
  },
  {
    id: "processor/system-field-role-repeated",
    extId: "EXT-PROC-1011",
    severity: "error",
    source: "annotation-processor",
    title: "A system-field role marker is on more than one field",
    what: "One role marker — @TenantId, @Version, a @SoftDelete… or an @Audit… marker, or @SharedScope — is declared on several fields. The message names all of them.",
    why: "SystemFieldsMetadata carries one field name per role, so the pipeline cannot express more than one. The diagnostic lists the whole set rather than one error per extra field, because choosing which field survives needs the whole set.",
    fix: "Keep the marker on exactly one field.",
    anchors: [],
  },
  {
    id: "processor/system-field-role-conflicts-with-override",
    extId: "EXT-PROC-1012",
    severity: "error",
    source: "annotation-processor",
    title: "A role marker and the @ExerisDomain override name different fields",
    what: "A system-field role marker is on one field while the matching @ExerisDomain override attribute names another; the message gives both.",
    why: "One role resolves to one field. With two declarations naming different fields, either choice would silently overrule the other.",
    fix: "Remove whichever of the two is wrong — the marker, or the @ExerisDomain override attribute the message names.",
    anchors: [],
  },
  {
    id: "processor/repeated-graph-edge",
    extId: "EXT-PROC-1013",
    severity: "error",
    source: "annotation-processor",
    title: "Two @GraphEdge declarations on one field",
    what: "A field carries more than one @GraphEdge, and the pipeline cannot carry that.",
    why: "GraphEdgeMetadata identifies an edge by the field it is declared on, and the graph-sync generator derives the entity getter from the same value — so two edges on one field would need one name to be both.",
    fix: "Declare each edge on its own field. If the model genuinely needs two edges from one value, that is an SDK change giving GraphEdgeMetadata a separate identity component.",
    anchors: [/@GraphEdge is declared \d+ times on field/],
  },
  {
    id: "processor/realtime-api-on-tenant-data",
    extId: "EXT-PROC-1014",
    severity: "error",
    source: "annotation-processor",
    title: "realTimeApi on a tenant-partitioned entity",
    what: "@ExerisDomain(realTimeApi = true) is on a TENANT or UNIVERSE entity.",
    why: "The generated live view forwards every event of the entity on the bus to every subscriber, and kernel events carry no tenant to filter on, so each tenant would receive every other tenant's events. An entity with no @DomainEvent is refused too: declaring an event later would start the feed with no further diagnostic.",
    fix: "Declare dataScope = DataScope.GLOBAL if the rows are not tenant-owned; otherwise drop realTimeApi until stream events carry an isolation key.",
    anchors: [],
  },
  {
    id: "processor/missing-primary-key",
    extId: "EXT-PROC-1015",
    severity: "error",
    source: "annotation-processor",
    title: "The entity declares no primary key field",
    what: "No field, declared or inherited, has the primary key's name — the field primaryKeyField names, else `id`.",
    why: "Every generated artefact identifies a row by the primary key: the migration's key column, the repository's identity clause and its save, the accessors the handler, service and graph sync call, the foreign keys that reference the entity, and the Angular model. A superclass field counts, because the generated code reaches it through inherited accessors.",
    fix: "Declare the key — `private UUID id;`, or the field primaryKeyField names — with its getter and setter, or point primaryKeyField at an existing UUID field.",
    reference: "ADR-104",
    anchors: [],
  },
  {
    id: "processor/reserved-event-name",
    extId: "EXT-PROC-1016",
    severity: "error",
    source: "annotation-processor",
    title: "A @DomainEvent is named after a reserved stream frame",
    what: "The event's name is one the generated streams reserve: stream-error (a failure after the response head), keep-alive (the heartbeat), or an event type a browser EventSource dispatches itself — message, open or error.",
    why: "Every generated stream forwards an event as a frame named by the event, so the client would read this event as the reserved frame.",
    fix: "Rename the event.",
    reference: "ADR-044",
    anchors: [],
  },
  {
    id: "processor/stream-frame-name-collision",
    extId: "EXT-PROC-1017",
    severity: "error",
    source: "annotation-processor",
    title: "A streaming action's result frame has a name already in use",
    what: "The result-frame name of a streaming action — @Action.streamEventType, or the action name when that is blank — is a reserved frame name (stream-error, keep-alive, message, open, error) or the name of a @DomainEvent the action triggers.",
    why: "The stream would carry two kinds of frame under one name, and the client could not tell the result frame from the other.",
    fix: "Set streamEventType to a name no reserved frame and no event of the action uses.",
    reference: "ADR-044",
    anchors: [],
  },
  {
    id: "processor/primary-key-not-uuid",
    extId: "EXT-PROC-1018",
    severity: "error",
    source: "annotation-processor",
    title: "The primary key is not a UUID",
    what: "The entity's primary key field has a type other than java.util.UUID; the message names it.",
    why: "The kernel identifies an entity's event stream and graph node by a UUID, and the generated repository fills a new row's key with UUID.randomUUID().",
    fix: "Declare the key as UUID. Keep any other identifier, such as an order number, as an ordinary unique field.",
    reference: "ADR-104",
    anchors: [],
  },
  {
    id: "processor/primary-key-renamed-beside-id",
    extId: "EXT-PROC-1019",
    severity: "error",
    source: "annotation-processor",
    title: "primaryKeyField renames the key while a field `id` exists",
    what: "The entity names its primary key with primaryKeyField and also declares a field `id`, inherited or its own.",
    why: "Moving the key off the `id` column changes the entity's CREATE TABLE migration, which then fails Flyway's checksum on every database that applied it.",
    fix: "Drop primaryKeyField to keep `id` as the key. If no database has applied the entity's migration, rename or remove the field `id` instead.",
    reference: "ADR-104",
    anchors: [],
  },
  {
    id: "processor/universe-tier-reserved",
    severity: "error",
    source: "annotation-processor",
    title: "DataScope.UNIVERSE is reserved and refused",
    what: "An entity declares dataScope = DataScope.UNIVERSE, which this tooling release refuses rather than half-emitting. Only exeris-tooling releases before 0.9.0 print this; from 0.9.0 the tier is generated, and its declaration rules are EXT-PROC-1006 to EXT-PROC-1010.",
    why: "In those releases the kernel carrier exists (sharedScopeKey, read-widen / write-pin RLS) but the codegen transcription for it does not. Emitting anyway would produce the TENANT shape — an owner column, an owner-pinned policy, a repository binding getTenantId() — against a shared-world row that has no tenant property, so the build would fail with 'cannot find symbol' inside generated code you are told not to edit.",
    fix: "Upgrade exeris-tooling to 0.9.0 or later to use the tier. On the older release, declare dataScope = TENANT if the entity really is partitioned by an owner, and give it a tenant property.",
    reference: "ADR-059",
    anchors: ["DataScope.UNIVERSE is reserved"],
  },

  // -------------------------------------------------------------------------
  // EXT-PROC-11xx — the annotation processor warns on an ordinary build
  // -------------------------------------------------------------------------
  {
    id: "processor/tenant-scoped-deprecated",
    extId: "EXT-PROC-1101",
    severity: "warning",
    source: "annotation-processor",
    title: "@ExerisDomain.tenantScoped is deprecated for removal",
    what: "The boolean is still read as a fallback for this build, and the message names the tier it mapped to.",
    why: "The attribute goes away at SDK 1.0.0. It warns rather than silently accepting, because a silent equivalence would let the whole deprecation window pass without anyone noticing.",
    fix: "Replace tenantScoped with the dataScope tier the warning names. See MIGRATION.md in exeris-sdk.",
    reference: "ADR-059",
    anchors: ["@ExerisDomain.tenantScoped is deprecated"],
  },
  {
    id: "processor/validation-attribute-deprecated",
    extId: "EXT-PROC-1102",
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
    extId: "EXT-PROC-1103",
    severity: "warning",
    source: "annotation-processor",
    title: "@Validation.validateOn has an unrecognised value",
    what: "The value is neither \"CREATE\" nor \"UPDATE\", so NO fallback was applied.",
    why: "This one differs from the other deprecation warnings in the way that matters: they degrade to a working equivalent, and this one does not. The intent is being dropped now, and will keep being dropped after SDK 1.0.0 removes the attribute.",
    fix: "Migrate to @Field.inCreate / @Field.inUpdate, which is where form-lifecycle scope belongs.",
    anchors: [/@Validation\.validateOn = ".*" is not a/],
  },
  {
    id: "processor/default-table-name-changed",
    extId: "EXT-PROC-1104",
    severity: "warning",
    source: "annotation-processor",
    title: "The entity's default table name changed",
    what: "Printed by exeris-tooling 0.9.0 only (the identifier is retired from 0.10.0): the entity's derived default table name differs from the plain plural of its class name, and the message names both.",
    why: "From 0.9.0 the default table name follows the SDK's plural rather than the plain plural, so an entity whose two plurals differ moves to a new table unless it names one.",
    fix: "To keep the existing table and migration, set @ExerisDomain(tableName = …) to the name the message gives; otherwise migrate to the new name. Either way, setting tableName decides it explicitly.",
    anchors: [],
  },
  {
    id: "processor/shared-scope-outside-universe",
    extId: "EXT-PROC-1105",
    severity: "warning",
    source: "annotation-processor",
    title: "@SharedScope on an entity that is not DataScope.UNIVERSE",
    what: "A field is marked @SharedScope on a GLOBAL or TENANT entity. The marker has no effect and is not recorded in the metadata.",
    why: "The marker names the column a DataScope.UNIVERSE policy widens reads on, and no other tier emits such a policy. UNIVERSE is reachable only through an explicit dataScope — the deprecated tenantScoped boolean cannot say it — so the declared tier is the whole test.",
    fix: "Declare dataScope = DataScope.UNIVERSE (the entity also needs its owning tenant field), or remove the marker.",
    anchors: [],
  },
  {
    id: "processor/bind-attributes-ignored",
    extId: "EXT-PROC-1106",
    severity: "warning",
    source: "annotation-processor",
    title: "@Bind with source STATIC or NONE carries ignored attributes",
    what: "@Bind(source = STATIC) or @Bind(source = NONE) sets attributes that select or shape bound data; the message lists them. They are ignored, and the node renders no bound value.",
    why: "STATIC and NONE draw from nothing, so there is no bound value for those attributes to act on.",
    fix: "Put authored content in @Block(props), or bind data with source = ENTITY, PROJECTION or ACTION.",
    anchors: [],
  },
  {
    id: "processor/streaming-action-not-invoked",
    extId: "EXT-PROC-1107",
    severity: "warning",
    source: "annotation-processor",
    title: "A streaming action's generated route does not run the action",
    what: "Printed by exeris-tooling 0.9.0 only (the identifier is retired from 0.10.0): for @Action(streaming = true), the generated stream route keeps the connection open with keep-alives but does not run the action, so calling it changes nothing.",
    why: "In 0.9.0 the per-action stream driver did not exist yet. From 0.10.0 the per-action stream handler runs the action and streams the events it triggers.",
    fix: "Upgrade exeris-tooling to 0.10.0 or later. On 0.9.0, expect keep-alives only on that route.",
    reference: "ADR-044",
    anchors: [],
  },

  // -------------------------------------------------------------------------
  // EXT-PROC-12xx — the -Aexeris.strict audit (javac warning, opt-in)
  // -------------------------------------------------------------------------
  {
    id: "processor/inert-attribute",
    extId: ["EXT-PROC-1201", "EXT-PROC-1202"],
    severity: "warning",
    source: "annotation-processor",
    title: "An attribute or annotation is set but no generator consumes it",
    what: "Part of the -Aexeris.strict audit: the processor reads the attribute (EXT-PROC-1201) or the whole annotation (EXT-PROC-1202), but nothing downstream acts on it, so it has no effect on emitted output. The message says why it is inert.",
    why: "Strict mode exists to surface exactly this — an annotation that looks load-bearing and is not. Without it, the attribute reads as configured behaviour that silently never happens.",
    fix: "Remove the attribute or annotation, or keep it and accept it changes no emitted output for now. It is reported only under -Aexeris.strict, so it never fails a default build.",
    anchors: ["is set but no code generator consumes it"],
  },
  {
    id: "processor/unread-annotation",
    extId: "EXT-PROC-1203",
    severity: "warning",
    source: "annotation-processor",
    title: "An annotation the processor never reads",
    what: "Part of the -Aexeris.strict audit, and stronger than the inert case: the processor does not read this annotation at all, so no generator could consume it even in principle.",
    why: "The audit iterates the element's own mirrors rather than a registry, which is what makes it complete — an annotation nobody has classified still shows up, with a generic reason.",
    fix: "Remove it, or confirm from the SDK docs that it is design-time only. Reported only under -Aexeris.strict.",
    anchors: ["is set but this processor never reads it"],
  },

  // -------------------------------------------------------------------------
  // EXT-PROC-19xx — the -Aexeris.verbose trail (javac note, opt-in)
  // -------------------------------------------------------------------------
  {
    id: "processor/verbose-progress",
    extId: "EXT-PROC-1901",
    severity: "note",
    source: "annotation-processor",
    title: "Processor progress trace",
    what: "An element is being processed, or its metadata was written.",
    why: "Printed only under -Aexeris.verbose=true, as a trail of what the processor visited. It reports nothing wrong.",
    fix: "Nothing; it is informational. Drop -Aexeris.verbose to silence it.",
    anchors: [],
  },
  {
    id: "processor/source-digest-unreadable",
    extId: "EXT-PROC-1902",
    severity: "note",
    source: "annotation-processor",
    title: "An element's source could not be read for its digest",
    what: "The processor could not read the element's source to compute its ADR-042 digest, so that entity's metadata JSON is written without its sourceDigest field. The message ends with the cause.",
    why: "Generation does not depend on the digest, so an unreadable source omits it rather than failing the build. The note appears only under -Aexeris.verbose=true.",
    fix: "Nothing for the build. A consumer that compares source digests has none for this entity until its source can be read.",
    reference: "ADR-042",
    anchors: ["could not read source for ADR-042 digest"],
  },

  // -------------------------------------------------------------------------
  // EXT-PLUG-20xx — exeris:generate
  // -------------------------------------------------------------------------
  {
    id: "codegen/empty-metadata-refusal",
    extId: "EXT-PLUG-2001",
    severity: "error",
    source: "codegen-plugin",
    title: "Codegen refused to wipe the committed generated tree",
    what: "Zero @ExerisDomain entities were loaded, while the previous run owns generated files that exeris:generate would now DELETE. The CodegenMain command line prints the same refusal under the same identifier.",
    why: "Empty metadata is almost always a masked compile failure — the annotation processor did not run — rather than an intentional teardown. The refusal is what stops a broken compile from silently deleting a committed tree.",
    fix: "Verify the project compiles first. The safe recipe is a metadata-only pass: `mvn compile -Dexeris.codegen.skip=true`, then re-run exeris:generate. Only if you genuinely removed every @ExerisDomain type, re-run with -Dexeris.codegen.allowEmpty=true (--allow-empty on the CodegenMain command line).",
    anchors: ["Refusing to wipe the committed generated tree"],
  },
  {
    id: "codegen/generation-io-failure",
    extId: "EXT-PLUG-2002",
    severity: "error",
    source: "codegen-plugin",
    title: "exeris:generate failed reading metadata or writing the generated tree",
    what: "Source generation hit an I/O failure. The message names the metadata directory and ends with the cause.",
    why: "This is an environment failure, not a rule your source broke. The cause is printed after the identifier so it is visible without mvn -e.",
    fix: "Read the cause for the path; check permissions and disk space on the metadata and output directories.",
    anchors: ["Code generation failed (metadataDir="],
  },
  {
    id: "codegen/test-generation-io-failure",
    extId: "EXT-PLUG-2003",
    severity: "error",
    source: "codegen-plugin",
    title: "exeris:generate failed writing the generated tests",
    what: "Generated-test emission hit an I/O failure. The message names the test output directory and ends with the cause.",
    why: "As for source generation: an environment failure, reported with its cause so it is visible without mvn -e.",
    fix: "Read the cause for the path; check permissions and disk space on the generated-test output directory.",
    reference: "ADR-058",
    anchors: ["Test generation failed (testOutputDir="],
  },
  {
    id: "codegen/import-not-on-classpath",
    extId: "EXT-PLUG-2004",
    severity: "warning",
    source: "codegen-plugin",
    title: "Generated code imports an artefact the compile classpath lacks",
    what: "The generated code imports artefacts that are not on the classpath it is compiled against; the message lists each groupId:artifactId. It is printed once for the main sources and once for the generated tests.",
    why: "javac fails next, on a missing package, and that error names the package rather than the jar. This line names the jar. Main sources count compile, provided and system scope; a dependency at runtime scope does not reach the compile classpath, even through a driver that depends on it.",
    fix: "Add each listed artefact: the main-source ones at compile scope, or depend on eu.exeris:exeris-app-starter (type pom), which declares all of them; the test ones (JUnit 5, AssertJ) at test scope.",
    anchors: [],
  },

  // -------------------------------------------------------------------------
  // EXT-PLUG-21xx — exeris:detach
  // -------------------------------------------------------------------------
  {
    id: "codegen/detach-failed",
    extId: "EXT-PLUG-2101",
    severity: "error",
    source: "codegen-plugin",
    title: "exeris:detach failed moving files or editing the ignore file",
    what: "Detach hit an I/O failure while moving the generated sources or updating .gitignore. The message ends with the cause.",
    why: "The failure can come part-way through the move, so the source tree may be left partly moved.",
    fix: "Read the cause, then check `git status` before re-running, to see what was already promoted.",
    anchors: ["Detach failed (generatedDir="],
  },
  {
    id: "codegen/detach-conflicts",
    extId: "EXT-PLUG-2102",
    severity: "warning",
    source: "codegen-plugin",
    title: "Detach left conflicts",
    what: "exeris:detach found files already present at the target and left them in place rather than overwriting them; each conflicting path is listed. It is a warning by default, and fails the goal when exeris.failOnConflict=true.",
    why: "Detach never overwrites a file you own. A conflict means that path exists in both the generated tree and src/main/java, so promoting it would destroy one of the two.",
    fix: "Reconcile each conflicting path by hand — decide which copy is the one you want — then re-run. exeris.failOnConflict only decides whether conflicts fail the build; with either value the conflicting files are not promoted.",
    anchors: [/Detach left \d+ conflict/],
  },

  // -------------------------------------------------------------------------
  // EXT-PLUG-22xx — exeris:verify-capabilities (and generate's capability pass).
  // The umbrella entry for EXT-PLUG-2201 comes first: it is the answer when the
  // text under that identifier names none of the specific problems.
  // -------------------------------------------------------------------------
  {
    id: "caps/graph-unresolved",
    extId: "EXT-PLUG-2201",
    severity: "error",
    source: "capability-graph",
    title: "The capability graph could not be resolved",
    what: "The umbrella failure. The lines under it are the individual problems — unsatisfied requirements, version mismatches, cycles. exeris:verify-capabilities raises it, as does exeris:generate when no later verify-capabilities execution is bound and the CodegenMain command line, which always validates fail-fast.",
    why: "Every problem is collected and reported together rather than failing at the first, so one build tells you the whole story.",
    fix: "Read the indented lines: each is its own diagnostic and can be pasted back here on its own.",
    reference: "ADR-024",
    anchors: ["Capability graph could not be resolved"],
  },
  {
    id: "caps/unsatisfied-requires",
    extId: "EXT-PLUG-2201",
    severity: "error",
    source: "capability-graph",
    title: "A @Requires has no matching @Provides",
    what: "A capability module requires a service that either nothing provides, or that no provider matches at the required version range. The message lists the candidate providers and their versions when there are any.",
    why: "The graph is resolved at build time, so an unsatisfiable composition fails the build rather than the boot. A version mismatch reads differently from a missing provider — 'no provider matches (providers: …)' means the service exists at the wrong version.",
    fix: "Add the module that provides the service, or widen the version range on the @Requires. Call caps-list_capabilities to see what this project actually composes.",
    reference: "ADR-024",
    // An optional requirement prints the same sentence with "(optional — skipped)"
    // after it; that is EXT-GEN-3102, a warning, and must not read as this error.
    anchors: [
      /but no @CapabilityModule provides it(?! \(optional)/,
      /but no provider matches \(providers: [^)\n]*\)(?! \(optional)/,
    ],
  },
  {
    id: "caps/dependency-cycle",
    extId: "EXT-PLUG-2201",
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
    id: "caps/metadata-unreadable",
    extId: "EXT-PLUG-2202",
    severity: "error",
    source: "capability-graph",
    title: "Capability metadata could not be read",
    what: "exeris:verify-capabilities hit an I/O failure reading the capability metadata. The message names the metadata directory and ends with the cause.",
    why: "An environment failure rather than a verdict on the graph: the graph was never evaluated.",
    fix: "Read the cause; rebuild so the processor rewrites target/classes/exeris-metadata/.",
    reference: "ADR-024",
    anchors: ["Capability verification failed (metadataDir="],
  },
  {
    id: "caps/wall-violated",
    extId: "EXT-PLUG-2203",
    severity: "error",
    source: "cap-tier-wall",
    title: "The cap-tier Wall was breached",
    what: "A capability module's compiled classes reference something the tier boundary forbids. The message lists each forbidden reference.",
    why: "ADR-024 predicate 4 makes the ADR-023 detachment guarantee mechanical: a detached capability must carry no hidden classpath. The guard checks that rather than asserting it.",
    fix: "Remove the forbidden reference, or move the code that needs it out of the capability module.",
    reference: "ADR-024 predicate 4, ADR-055",
    anchors: ["Cap-tier Wall violated"],
  },
  {
    id: "caps/wall-scan-failed",
    extId: "EXT-PLUG-2204",
    severity: "error",
    source: "cap-tier-wall",
    title: "The cap-tier Wall scan could not read a class",
    what: "The Wall scan failed reading a compiled class. The message names the classes directory and ends with the cause.",
    why: "An unreadable or corrupt class file is an environment problem, not a Wall verdict — which is why it is reported apart from a violation.",
    fix: "Read the cause; a clean rebuild usually replaces a corrupt class file.",
    reference: "ADR-024 predicate 4",
    anchors: ["Cap-tier Wall scan failed"],
  },
  {
    id: "caps/wall-disabled",
    extId: "EXT-PLUG-2205",
    severity: "warning",
    source: "cap-tier-wall",
    title: "The cap-tier Wall guard is switched off",
    what: "exeris:verify-capabilities skipped the Wall because exeris.wall.skip=true.",
    why: "ADR-024 obligation 3 treats a disabled guard as a registry violation, so the build says so rather than passing quietly.",
    fix: "Remove exeris.wall.skip=true unless the exemption is intended.",
    reference: "ADR-024",
    anchors: ["Cap-tier Wall guard DISABLED"],
  },
  {
    id: "caps/wall-scanned-nothing",
    extId: "EXT-PLUG-2206",
    severity: "warning",
    source: "cap-tier-wall",
    title: "The Wall guard scanned nothing",
    what: "This build IS a capability — the graph gate saw modules — yet the Wall found no compiled classes to scan. exeris:verify-capabilities and the pipeline it calls both report it, under the one identifier.",
    why: "Predicate 4 is then unverified, not satisfied. The warning exists so that a clean-looking build does not read as a passing Wall check.",
    fix: "Point exeris.classesDir at the compiled classes, and check that compilation ran before verification.",
    reference: "ADR-024 predicate 4",
    anchors: ["Cap-tier Wall scanned nothing"],
  },

  // -------------------------------------------------------------------------
  // EXT-PLUG-23xx — exeris:verify-runtime
  // -------------------------------------------------------------------------
  {
    id: "runtime/metadata-unreadable",
    extId: "EXT-PLUG-2301",
    severity: "error",
    source: "runtime-verifier",
    title: "Domain metadata could not be read while checking runtime drivers",
    what: "exeris:verify-runtime hit an I/O failure reading the domain metadata. The message names the metadata directory and ends with the cause.",
    why: "An environment failure: the driver check never ran, so this says nothing about whether a driver is present.",
    fix: "Read the cause; rebuild so the processor rewrites the metadata.",
    anchors: ["Could not read domain metadata (metadataDir="],
  },
  {
    id: "runtime/no-kernel-driver",
    extId: "EXT-PLUG-2302",
    severity: "error",
    source: "runtime-verifier",
    title: "No kernel driver on the runtime classpath",
    what: "The generated application requires SPIs that no registered provider on this module's runtime classpath satisfies. The message lists which. With -Dexeris.verifyRuntime.skip=true the same text is logged as a warning instead.",
    why: "Without the check, Application.main() would fail at boot naming a subsystem rather than a missing dependency — a much harder failure to read.",
    fix: "Add a runtime driver to this module's dependencies; the message suggests one. If this module only generates code for another module to run, set -Dexeris.verifyRuntime.skip=true.",
    anchors: ["has no kernel driver on its runtime classpath"],
  },

  // -------------------------------------------------------------------------
  // EXT-GEN-30xx — code-generation pipeline errors (CodegenMain exits 1 or 2)
  // -------------------------------------------------------------------------
  {
    id: "codegen/cli-generation-failed",
    extId: "EXT-GEN-3001",
    severity: "error",
    source: "codegen-pipeline",
    title: "The codegen command line failed to generate",
    what: "CodegenMain failed and exits with status 1: an I/O failure reading metadata or writing output (the message names the directory and ends with the cause), or an unexpected exception, printed with its stack trace.",
    why: "The command line reports a refusal of its input under the identifier exeris:generate uses for the same event — EXT-PLUG-2001, EXT-PLUG-2201, EXT-GEN-3003. This identifier is everything else: an environment failure or a generator failure.",
    fix: "For an I/O failure, check the path, permissions and disk space of the metadata and output directories. A stack trace inside the generator on metadata the processor wrote is a generator failure, for an exeris-tooling issue.",
    anchors: [],
  },
  {
    id: "codegen/cli-arguments-invalid",
    extId: "EXT-GEN-3002",
    severity: "error",
    source: "codegen-pipeline",
    title: "The codegen command line was given invalid arguments",
    what: "CodegenMain was given missing or malformed arguments, or a switch it does not know. It exits with status 2 and prints its usage text under this line.",
    why: "Arguments are validated before anything runs, and an unknown switch is refused rather than ignored — so a switch a newer release added fails on an older jar.",
    fix: "Pass --metadata-dir and --output-dir, and only the switches the printed usage text lists. If a switch is missing from it, the jar is older than the documentation you are following.",
    anchors: [],
  },
  {
    id: "codegen/field-type-not-persistable",
    extId: "EXT-GEN-3003",
    severity: "error",
    source: "codegen-pipeline",
    title: "An entity field has a type the generated repository cannot persist",
    what: "One or more entity fields have a type with no column encoding: a parameterised type other than List<…> (Map, Set, Optional, …), a List whose element is not a plain type, an array, char / Character, BigInteger, or a JDK value type with no static valueOf(String) (LocalTime, Duration, ZoneId, URI, Object, …). The message names every such field. Nothing is generated: exeris:generate fails with it, and CodegenMain prints it and exits with status 1. An enum is never refused.",
    why: "Every domain field is a column of the entity's table, written through a PersistenceStatement bind and read through a RowCursor accessor. A type with neither a typed SPI accessor nor a string round-trip has no column encoding; emitting one anyway produces a repository that does not compile. The refusal comes before the first write, so a refused run leaves the generated tree as it was. It is a limit of the Java repository's column encoding, raised by the Java pipeline only.",
    fix: "Declare each field as a List<…> of a plain element type (stored as a JSON column) or as a supported scalar: String, UUID, Long, Integer, Short, Byte, Boolean, Float, Double, BigDecimal, Instant, LocalDateTime, OffsetDateTime, ZonedDateTime, LocalDate, or an enum. Use BigDecimal in place of BigInteger, and a String for a time of day or a duration.",
    anchors: [],
  },
  {
    id: "codegen/cli-catalogue-unreadable",
    extId: "EXT-GEN-3004",
    severity: "error",
    source: "codegen-pipeline",
    title: "The codegen command line could not read its generator catalogue",
    what: "CodegenMain --print-catalogue found no META-INF/exeris/generator-catalogue.json on its classpath, or failed reading it.",
    why: "The catalogue ships inside the generator itself, so a missing one means the command line is running from a classpath that does not carry the generator.",
    fix: "Run it from the exeris-codegen-cli jar, or with exeris-codegen-java of the same release on the classpath.",
    reference: "ADR-097",
    anchors: [],
  },

  // -------------------------------------------------------------------------
  // EXT-GEN-31xx — code-generation pipeline warnings
  // -------------------------------------------------------------------------
  {
    id: "codegen/no-metadata-found",
    extId: "EXT-GEN-3101",
    severity: "warning",
    source: "codegen-pipeline",
    title: "Generation found no metadata to generate from",
    what: "The metadata directory holds neither domain nor capability metadata. Nothing is generated.",
    why: "Usually the compile failed before the annotation processor ran. Nothing committed is deleted on that account: if a previous run owns generated files, generation refuses instead (EXT-PLUG-2001).",
    fix: "Fix the compile, then re-run. Check that @ExerisDomain / @CapabilityModule classes are compiled before generation.",
    anchors: ["No domain or capability metadata found in"],
  },
  {
    id: "caps/optional-requirement-skipped",
    extId: "EXT-GEN-3102",
    severity: "warning",
    source: "capability-graph",
    title: "An optional @Requires has no provider and is skipped",
    what: "A capability module declares an optional @Requires that no provider satisfies, or none at the required version; the requirement is skipped.",
    why: "An unsatisfied optional requirement is a warning, not a graph failure: the composition stays valid without it.",
    fix: "Nothing, if the capability is meant to be optional. Otherwise add the @Provides the message names, or widen its version range.",
    reference: "ADR-024",
    anchors: ["(optional — skipped)"],
  },
  {
    id: "caps/graph-deferred",
    extId: "EXT-GEN-3103",
    severity: "warning",
    source: "capability-graph",
    title: "The capability graph failed on possibly stale metadata; the verdict is deferred",
    what: "exeris:generate found the capability graph unresolved, but on metadata that may be the previous build's, so it warned instead of failing and kept the previous cap-manifest.json. The problems follow in the message.",
    why: "At generate-sources the capability metadata on disk is last build's output; the processor refreshes it during the compile that follows. Failing here would deadlock the build on its own stale input — the @Requires edit that fixes the graph could never take effect. exeris:verify-capabilities re-validates the fresh metadata after compile and delivers the fail-closed verdict.",
    fix: "Nothing yet. If verify-capabilities later fails the same build with EXT-PLUG-2201, fix the problems it lists.",
    reference: "ADR-024",
    anchors: ["Capability graph invalid on possibly-stale metadata"],
  },
  {
    id: "codegen/base-package-inferred",
    extId: "EXT-GEN-3104",
    severity: "warning",
    source: "codegen-pipeline",
    title: "No base package given; the bootstrap classes' package was inferred",
    what: "No base package was set and the entities span more than one package. Application, RuntimeComponents, RuntimeLifecycle and the generated testsupport package go to the package of the entity whose fully-qualified name sorts first, with `.domain` removed.",
    why: "With entities in several packages there is no single right answer, so the pipeline picks deterministically and says which it picked. The warning is not printed when a base package is set.",
    fix: "Nothing, if that package suits you. Otherwise set exeris.basePackage (--base-package on the command line) to the package you want.",
    anchors: [],
  },

  // -------------------------------------------------------------------------
  // EXT-INIT-50xx — the exeris-initializr command line
  // -------------------------------------------------------------------------
  {
    id: "initializr/arguments-invalid",
    extId: "EXT-INIT-5001",
    severity: "error",
    source: "initializr",
    title: "exeris-initializr was given invalid arguments",
    what: "The initializr was given a switch it does not know, a switch without its value, a positional argument, or a value it cannot use — an unknown topology or database, or a groupId, artifactId, package or entity name that is not valid. It exits with status 2 and prints its usage text.",
    why: "The arguments are parsed and checked before anything is generated, so nothing is written when they are refused.",
    fix: "Pass only the switches the printed usage text lists, each as --switch=value.",
    reference: "ADR-091",
    anchors: [],
  },
  {
    id: "initializr/target-not-empty",
    extId: "EXT-INIT-5002",
    severity: "error",
    source: "initializr",
    title: "exeris-initializr refused to write over existing files",
    what: "The target directory is not empty, or the target archive exists, and --force was not given. Nothing was written; it exits with status 1.",
    why: "Writing a new project into an existing one would replace files that share a path with it, so the initializr does that only when asked to.",
    fix: "Choose another --output-dir or --zip, or pass --force: files of the same path are replaced and every other file is left in place.",
    reference: "ADR-091",
    anchors: [],
  },
  {
    id: "initializr/write-failed",
    extId: "EXT-INIT-5003",
    severity: "error",
    source: "initializr",
    title: "exeris-initializr failed writing the project",
    what: "Writing the project or archive failed; it exits with status 1. The message names the target and ends with the cause.",
    why: "An environment failure rather than a problem with the requested project.",
    fix: "Read the cause; check the path, permissions and disk space of the output directory or archive.",
    reference: "ADR-091",
    anchors: [],
  },
];
