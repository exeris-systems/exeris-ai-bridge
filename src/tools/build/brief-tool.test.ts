import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../../config/env.js";
import type { BundleState } from "../../data/bundle.js";
import { writeJar } from "../../data/__tests__/jar-fixture.js";
import { extractFromJar } from "../../data/vendor-resolver.js";
import { compileBriefSchema, MAX_BRIEF_BYTES } from "./brief.js";
import { MAX_BRIEFS } from "./brief-tool.js";
import { registerBuildTools } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const BRIEFS = join(REPO, "test", "fixtures", "briefs");
const FIXTURE_M2 = join(REPO, "test", "fixtures", "m2");
const FIXTURE_JAR = join(
  FIXTURE_M2,
  "eu/exeris/exeris-sdk-source-model/0.13.1/exeris-sdk-source-model-0.13.1.jar",
);
const ENTRY = "META-INF/exeris/brief-schema.json";
const SCHEMA_TEXT = extractFromJar(FIXTURE_JAR, ENTRY).toString("utf8");

const roots: string[] = [];
process.on("exit", () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function pom(sdk: string): string {
  return `<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>app</artifactId><version>1</version>
<dependencies><dependency><groupId>eu.exeris</groupId><artifactId>exeris-sdk-source-model</artifactId><version>${sdk}</version></dependency></dependencies></project>`;
}

interface ProjectOptions {
  readonly sdk?: string | null;
  readonly briefs?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A project with the named briefs (file name to text) and, optionally, emitted metadata. */
function project(options: ProjectOptions = {}): string {
  const root = scratch("exeris-brief-");
  const sdk = options.sdk === undefined ? "0.13.1" : options.sdk;
  if (sdk !== null) writeFileSync(join(root, "pom.xml"), pom(sdk));
  if (options.briefs !== undefined) {
    mkdirSync(join(root, "docs", "briefs"), { recursive: true });
    for (const [name, body] of Object.entries(options.briefs)) {
      writeFileSync(join(root, "docs", "briefs", name), body);
    }
  }
  if (options.metadata !== undefined) {
    const dir = join(root, "target", "classes", "exeris-metadata");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(options.metadata)) {
      writeFileSync(join(dir, name), JSON.stringify(body));
    }
  }
  return root;
}

function fixture(name: string): string {
  return readFileSync(join(BRIEFS, `${name}.brief.yaml`), "utf8");
}

const ALL_FIXTURES = [
  "empty",
  "empty-object",
  "minimal",
  "ready",
  "gap-assumption-without-owner",
  "gap-blocking-question-open",
  "gap-dangling-fulfilled-by",
  "gap-re-encoded-structure",
  "gap-workflow-without-response",
  "gap-repeated-question-id",
  "gap-undeclared-workflow-actor",
  "gap-unknown-concern-hint",
];

/** The bundle as the package ships it: the brief schema vendored from the 0.13.1 release. */
function briefBundle(schemaText: string = SCHEMA_TEXT): { bundle: BundleState; dir: string } {
  const dir = scratch("exeris-brief-bundle-");
  writeFileSync(join(dir, "brief-schema.json"), schemaText);
  return {
    dir,
    bundle: {
      state: "available",
      generatedAt: "2026-01-01T00:00:00.000Z",
      bridgeVersion: "0.0.0",
      entries: [
        {
          id: "brief-schema",
          path: "brief-schema.json",
          sha256: createHash("sha256").update(Buffer.from(schemaText, "utf8")).digest("hex"),
          bytes: Buffer.byteLength(schemaText),
          sourceArtifact: "eu.exeris:exeris-sdk-source-model:0.13.1",
        },
      ],
    },
  };
}

function configFor(root: string | null): BridgeConfig {
  const na = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };
  return {
    mode: "app",
    modeSource: "default",
    ecosystemRoot: null,
    docs: na,
    lsp: na,
    kernel: na,
    project:
      root === null
        ? { state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" }
        : { state: "available", projectRoot: root, source: "env" },
  };
}

/** An empty local Maven repository: nothing pinned resolves from it. */
function emptyM2(): string {
  return scratch("exeris-brief-m2-");
}

function toolFor(root: string | null, schemaText?: string, m2: string = FIXTURE_M2) {
  const { bundle, dir } = briefBundle(schemaText);
  const tools = registerBuildTools(configFor(root), bundle, dir, {}, { env: { EXERIS_MAVEN_REPO: m2, HOME: scratch("exeris-brief-home-") } });
  return tools.find((t) => t.definition.name === "build-validate_brief")!;
}

interface BriefOut {
  area: string;
  valid: boolean;
  ready: boolean;
  errors: { path: string; message: string }[];
  assumed: { questionId: string; owner: string; assumption: string }[];
  unresolved: { kind: string; ref: string }[];
  unchecked: { kind: string; ref: string }[];
  skew: Record<string, unknown>;
}

async function run(root: string, args: Record<string, unknown> = {}, schemaText?: string, m2?: string) {
  const res = await toolFor(root, schemaText, m2).handler(args);
  const raw = (res.content[0] as { text: string }).text;
  return { res, raw, payload: raw.startsWith("{") ? (JSON.parse(raw) as { briefs: BriefOut[]; [k: string]: unknown }) : null };
}

async function one(root: string, area: string, schemaText?: string, m2?: string): Promise<BriefOut> {
  const { payload, raw } = await run(root, { area }, schemaText, m2);
  assert.ok(payload !== null && payload.briefs.length === 1, raw);
  return payload.briefs[0];
}

function paths(b: BriefOut): string[] {
  return b.errors.map((e) => e.path);
}

// ---- the SDK's own fixtures ---------------------------------------------------------------

// The expected verdicts are the ones exeris-sdk's BriefSchemaContractTest asserts
// for the same twelve documents (nine at tag v0.13.1, three from exeris-sdk#258).
const SDK_VERDICTS: Record<string, { valid: boolean; ready: boolean }> = {
  ready: { valid: true, ready: true },
  minimal: { valid: true, ready: true },
  "gap-workflow-without-response": { valid: false, ready: false },
  "gap-repeated-question-id": { valid: false, ready: false },
  "gap-undeclared-workflow-actor": { valid: false, ready: false },
  "gap-unknown-concern-hint": { valid: false, ready: false },
  "gap-blocking-question-open": { valid: true, ready: false },
  "gap-assumption-without-owner": { valid: false, ready: false },
  "gap-re-encoded-structure": { valid: false, ready: false },
  "gap-dangling-fulfilled-by": { valid: true, ready: true },
  empty: { valid: false, ready: false },
  "empty-object": { valid: false, ready: false },
};

test("the bridge agrees with the SDK's verdict on every one of its twelve fixtures", async () => {
  assert.deepEqual(Object.keys(SDK_VERDICTS).sort(), [...ALL_FIXTURES].sort());
  for (const name of ALL_FIXTURES) {
    const b = await one(project({ briefs: { [`${name}.brief.yaml`]: fixture(name) } }), name);
    assert.deepEqual({ valid: b.valid, ready: b.ready }, SDK_VERDICTS[name], name);
    assert.equal(b.area, name);
    assert.equal(b.skew.schemaSource, "project", name);
  }
});

test("the same verdicts hold on the bundled schema", async () => {
  for (const name of ALL_FIXTURES) {
    const b = await one(project({ briefs: { [`${name}.brief.yaml`]: fixture(name) } }), name, undefined, emptyM2());
    assert.deepEqual({ valid: b.valid, ready: b.ready }, SDK_VERDICTS[name], name);
    assert.equal(b.skew.schemaSource, "bundled", name);
  }
});

test("a ready brief lists the question decided on credit, with its owner", async () => {
  const b = await one(project({ briefs: { "ready.brief.yaml": fixture("ready") } }), "ready");
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.assumed, [{ questionId: "Q1", owner: "Head of Finance", assumption: "EU VAT only." }]);
});

test("an assumption without its owner makes the brief invalid, at the owner", async () => {
  const b = await one(project({ briefs: { "a.brief.yaml": fixture("gap-assumption-without-owner") } }), "a");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.ok(paths(b).includes("/openQuestions/0/owner"), JSON.stringify(b.errors));
  assert.deepEqual(b.assumed, [{ questionId: "Q1", owner: null, assumption: "A company." }]);
});

test("a blocking question that is still open keeps a valid brief from being ready", async () => {
  const b = await one(project({ briefs: { "a.brief.yaml": fixture("gap-blocking-question-open") } }), "a");
  assert.equal(b.valid, true);
  assert.equal(b.ready, false);
  assert.deepEqual(b.errors, []);
});

test("a non-blocking open question does not hold readiness back", async () => {
  const text = fixture("minimal") + "openQuestions:\n  - id: Q9\n    question: Later?\n    blocking: false\n    status: open\n";
  const b = await one(project({ briefs: { "a.brief.yaml": text } }), "a");
  assert.equal(b.ready, true);
});

test("a workflow criterion without its response is reported at the response", async () => {
  const b = await one(project({ briefs: { "a.brief.yaml": fixture("gap-workflow-without-response") } }), "a");
  assert.equal(b.valid, false);
  assert.ok(paths(b).includes("/workflows/0/criteria/0/response"), JSON.stringify(b.errors));
});

test("a re-encoded source structure is refused: the contract has no slot for it", async () => {
  const b = await one(project({ briefs: { "a.brief.yaml": fixture("gap-re-encoded-structure") } }), "a");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.ok(paths(b).includes("/glossary/0/fields"), JSON.stringify(b.errors));
});

test("an EARS criterion is checked by its structure, never by its text", async () => {
  const text = fixture("minimal").replace("kind: ubiquitous\n        response:", "kind: when\n        response:");
  const b = await one(project({ briefs: { "a.brief.yaml": text } }), "a");
  assert.equal(b.valid, false);
  assert.ok(paths(b).includes("/workflows/0/criteria/0/trigger"), JSON.stringify(b.errors));

  // Nonsense prose in every text slot is still a valid brief.
  const prose = fixture("minimal").replace("the system keeps one record per customer", "colourless green ideas sleep furiously");
  assert.equal((await one(project({ briefs: { "a.brief.yaml": prose } }), "a")).ready, true);
});

// ---- never ready --------------------------------------------------------------------------

test("an absent, empty or empty-object brief is never ready", async () => {
  const root = project({ briefs: { "empty.brief.yaml": "", "blank.brief.yaml": "# nothing\n", "obj.brief.yaml": "{}\n" } });
  const absent = await one(root, "missing");
  assert.deepEqual({ valid: absent.valid, ready: absent.ready }, { valid: false, ready: false });
  assert.match(absent.errors[0].message, /no brief/);
  for (const area of ["empty", "blank", "obj"]) {
    const b = await one(root, area);
    assert.deepEqual({ valid: b.valid, ready: b.ready }, { valid: false, ready: false }, area);
    assert.ok(b.errors.length > 0, area);
  }
  assert.deepEqual(paths(await one(root, "obj")).sort(), ["/actors", "/briefSchema", "/nonGoals", "/purpose", "/workflows"]);
});

test("a project with no briefs says none exist and never says ready", async () => {
  for (const root of [project(), project({ briefs: {} })]) {
    const { res, payload, raw } = await run(root);
    assert.ok(!res.isError, raw);
    assert.equal(payload?.present, false);
    assert.deepEqual(payload?.briefs, []);
    assert.match(String(payload?.notice), /No briefs exist/);
    assert.equal(raw.includes('"ready": true'), false);
  }
});

test("without an area every brief directly under docs/briefs is validated, sorted, and stray names are listed", async () => {
  const root = project({
    briefs: {
      "b.brief.yaml": fixture("minimal"),
      "a.brief.yaml": fixture("gap-blocking-question-open"),
      "Upper.brief.yaml": fixture("minimal"),
      "notes.md": "x",
    },
  });
  mkdirSync(join(root, "docs", "briefs", "nested"));
  writeFileSync(join(root, "docs", "briefs", "nested", "c.brief.yaml"), fixture("minimal"));
  const { payload } = await run(root);
  assert.deepEqual(payload?.briefs.map((b) => [b.area, b.ready]), [["a", false], ["b", true]]);
  assert.deepEqual(payload?.ignored, ["Upper.brief.yaml"]);
});

test("more briefs than the bound is refused by name of the bound", async () => {
  const briefs: Record<string, string> = {};
  for (let i = 0; i <= MAX_BRIEFS; i += 1) briefs[`a${i}.brief.yaml`] = fixture("minimal");
  const { res, raw } = await run(project({ briefs }));
  assert.equal(res.isError, true);
  assert.match(raw, new RegExp(`limit is ${MAX_BRIEFS}`));
});

// ---- the area is a name, never a path ----------------------------------------------------

test("an area that is not a plain lowercase name is refused before any file is touched", async () => {
  const root = project({ briefs: { "x.brief.yaml": fixture("minimal") } });
  for (const area of ["../x", "../../etc/passwd", "/etc/passwd", "Billing", "a/b", "-a", "a.b", "", "a".repeat(65), "x\u0000"]) {
    const { res, raw } = await run(root, { area });
    assert.equal(res.isError, true, JSON.stringify(area));
    assert.match(raw, /'area' must be a name/, JSON.stringify(area));
  }
  const { res } = await run(root, { area: 7 });
  assert.equal(res.isError, true);
});

test("a brief that is a symlink out of the project is refused, and its target is not read", async () => {
  const outside = scratch("exeris-brief-outside-");
  writeFileSync(join(outside, "secret.yaml"), fixture("ready"));
  const root = project({ briefs: {} });
  mkdirSync(join(root, "docs", "briefs"), { recursive: true });
  symlinkSync(join(outside, "secret.yaml"), join(root, "docs", "briefs", "leak.brief.yaml"));
  const b = await one(root, "leak");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.match(b.errors[0].message, /sandbox escape/);
  assert.deepEqual(b.assumed, []);
  const all = await run(root);
  assert.equal(all.payload?.briefs[0].ready, false);
});

test("a docs/briefs directory that is a symlink out of the project is refused", async () => {
  const outside = scratch("exeris-brief-outside-");
  writeFileSync(join(outside, "x.brief.yaml"), fixture("ready"));
  const root = project({});
  mkdirSync(join(root, "docs"), { recursive: true });
  symlinkSync(outside, join(root, "docs", "briefs"));
  for (const args of [{ area: "x" }, {}]) {
    const { res, raw } = await run(root, args);
    assert.equal(res.isError, true);
    assert.match(raw, /sandbox escape/);
  }
});

test("a brief that is a symlink to a file inside the project but outside docs/briefs is refused", async () => {
  const root = project({ briefs: {} });
  mkdirSync(join(root, "docs", "briefs"), { recursive: true });
  writeFileSync(join(root, "elsewhere.yaml"), fixture("ready"));
  symlinkSync(join(root, "elsewhere.yaml"), join(root, "docs", "briefs", "in.brief.yaml"));
  const b = await one(root, "in");
  assert.equal(b.ready, false);
  assert.match(b.errors[0].message, /sandbox escape/);
});

// ---- which schema validates ---------------------------------------------------------------

/** A local Maven repository whose pinned source-model jar carries `text` as its brief schema. */
function m2With(text: string, version = "0.13.1"): string {
  const repo = emptyM2();
  writeJar(join(repo, "eu/exeris/exeris-sdk-source-model", version, `exeris-sdk-source-model-${version}.jar`), { [ENTRY]: text });
  return repo;
}

function stricterSchema(): string {
  const schema = JSON.parse(SCHEMA_TEXT) as { sdkVersion: string; $defs: { Brief: { required: string[] } } };
  schema.$defs.Brief.required.push("goals");
  schema.sdkVersion = "0.13.1-pinned";
  return JSON.stringify(schema);
}

test("the schema in the project's pinned jar wins over the bundled one", async () => {
  const root = project({ briefs: { "m.brief.yaml": fixture("minimal") } });
  // Bundled: minimal is valid. Pinned jar: it additionally requires goals.
  const viaBundle = await one(root, "m", undefined, emptyM2());
  assert.equal(viaBundle.valid, true);
  assert.equal(viaBundle.skew.schemaSource, "bundled");
  assert.match(String(viaBundle.skew.note), /not in the local Maven repository/);

  const viaProject = await one(root, "m", undefined, m2With(stricterSchema()));
  assert.equal(viaProject.valid, false);
  assert.ok(paths(viaProject).includes("/goals"), JSON.stringify(viaProject.errors));
  assert.equal(viaProject.skew.schemaSource, "project");
  assert.equal(viaProject.skew.schemaSdkVersion, "0.13.1-pinned");
  assert.equal(viaProject.skew.projectSdkVersion, "0.13.1");
  assert.equal(viaProject.skew.bundledSdkVersion, "0.13.1");
  assert.equal(viaProject.skew.status, "aligned");
});

test("skew has the shape sdk-* reports, and says when the pin differs from the bundled release", async () => {
  const root = project({ sdk: "0.13.0", briefs: { "m.brief.yaml": fixture("minimal") } });
  const b = await one(root, "m", undefined, emptyM2());
  assert.equal(b.skew.status, "skew_detected");
  assert.equal(b.skew.projectSdkVersion, "0.13.0");
  assert.equal(b.skew.bundledSdkVersion, "0.13.1");
  assert.equal(b.skew.schemaSource, "bundled");
  assert.equal(b.skew.source, "dependency");
  assert.match(String(b.skew.warning), /0\.13\.0/);
  assert.equal(b.valid, true);
});

test("a project whose SDK pin cannot be read is validated on the bundled schema with unknown skew", async () => {
  const b = await one(project({ sdk: null, briefs: { "m.brief.yaml": fixture("minimal") } }), "m");
  assert.equal(b.valid, true);
  assert.equal(b.skew.status, "unknown");
  assert.equal(b.skew.schemaSource, "bundled");
  assert.match(String(b.skew.reason), /pinned SDK version/);
});

test("a brief schema in an unknown format is refused, from either source", async () => {
  const root = project({ briefs: { "m.brief.yaml": fixture("minimal") } });
  const unknown = JSON.stringify({ ...JSON.parse(SCHEMA_TEXT), briefSchemaFormat: 2 });

  const fromProject = await run(root, { area: "m" }, undefined, m2With(unknown));
  assert.equal(fromProject.res.isError, true);
  assert.equal((fromProject.payload as unknown as { error: string }).error, "brief_schema_format_unsupported");
  assert.match(raw(fromProject), /briefSchemaFormat 2/);

  const fromBundle = await run(root, { area: "m" }, unknown, emptyM2());
  assert.equal(fromBundle.res.isError, true);
  assert.equal((fromBundle.payload as unknown as { error: string }).error, "brief_schema_unavailable");
  assert.match(raw(fromBundle), /briefSchemaFormat 2/);
});

function raw(r: { raw: string }): string {
  return r.raw;
}

test("a brief written against a newer SDK than the project pins is skew and is not validated", async () => {
  const newer = fixture("ready").replace("briefSchema: 0.13.0", "briefSchema: 0.14.0");
  const root = project({ briefs: { "n.brief.yaml": newer } });
  const b = await one(root, "n");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.equal(b.skew.status, "skew_detected");
  assert.equal(b.skew.briefSchema, "0.14.0");
  assert.equal(b.errors.length, 1);
  assert.equal(b.errors[0].path, "/briefSchema");
  assert.match(b.errors[0].message, /newer than the SDK 0\.13\.1/);
  assert.deepEqual(b.assumed, []);

  // At the pin it is validated.
  const same = fixture("ready").replace("briefSchema: 0.13.0", "briefSchema: 0.13.1");
  assert.equal((await one(project({ briefs: { "n.brief.yaml": same } }), "n")).ready, true);
});

test("a project pinned below the first SDK with a brief contract gets a reason and no validation", async () => {
  const root = project({ sdk: "0.12.0", briefs: { "m.brief.yaml": fixture("ready") } });
  const { res, payload, raw: text } = await run(root);
  assert.equal(res.isError, true);
  const body = payload as unknown as { error: string; reason: string; remedy: string; briefs?: unknown };
  assert.equal(body.error, "brief_contract_unsupported");
  assert.match(body.reason, /0\.12\.0/);
  assert.match(body.remedy, /0\.13\.0/);
  assert.equal(body.briefs, undefined);
  assert.equal(text.includes('"ready"'), false);
});

// ---- fulfilledBy --------------------------------------------------------------------------

const INVOICE = {
  "Invoice.json": {
    schemaVersion: "0.13.1",
    entityName: "Invoice",
    packageName: "com.acme.billing",
    actions: [{ name: "issue" }],
    rules: [{ name: "gaplessNumber" }],
  },
};

test("without emitted metadata every reference is unchecked, not failed", async () => {
  const b = await one(project({ briefs: { "r.brief.yaml": fixture("ready") } }), "r");
  assert.equal(b.ready, true);
  assert.deepEqual(b.unresolved, []);
  assert.deepEqual(b.unchecked, [
    { kind: "entity", ref: "com.acme.billing.Invoice" },
    { kind: "action", ref: "com.acme.billing.Invoice#issue" },
    { kind: "rule", ref: "com.acme.billing.Invoice#gaplessNumber" },
  ]);
});

test("references that match the emitted metadata resolve", async () => {
  const b = await one(project({ briefs: { "r.brief.yaml": fixture("ready") }, metadata: INVOICE }), "r");
  assert.deepEqual(b.unresolved, []);
  assert.deepEqual(b.unchecked, []);
  assert.equal(b.ready, true);
});

test("a reference that matches nothing is unresolved, and does not change readiness", async () => {
  const metadata = {
    "Customer.json": {
      schemaVersion: "0.13.1",
      entityName: "Customer",
      packageName: "com.acme.crm",
      actions: [{ name: "enrol" }],
    },
  };
  const b = await one(project({ briefs: { "d.brief.yaml": fixture("gap-dangling-fulfilled-by") }, metadata }), "d");
  assert.deepEqual(b.unresolved, [{ kind: "action", ref: "com.acme.crm.Customer#register" }]);
  assert.deepEqual(b.unchecked, []);
  assert.equal(b.valid, true);
  assert.equal(b.ready, true);
});

test("a member resolves by its kind: a rule does not satisfy an action reference", async () => {
  const metadata = {
    "Invoice.json": { ...INVOICE["Invoice.json"], actions: [], rules: [{ name: "issue" }, { name: "gaplessNumber" }] },
  };
  const b = await one(project({ briefs: { "r.brief.yaml": fixture("ready") }, metadata }), "r");
  assert.deepEqual(b.unresolved, [{ kind: "action", ref: "com.acme.billing.Invoice#issue" }]);
});

test("a saga resolves as <entity>#<saga name>", async () => {
  const text = fixture("minimal") + "  - name: Settle\n    criteria:\n      - kind: ubiquitous\n        response: it settles\n    fulfilledBy:\n      - kind: saga\n        ref: com.acme.billing.Invoice#settlement\n";
  const present = { "Invoice.json": { ...INVOICE["Invoice.json"], sagaMetadata: { name: "settlement" } } };
  const found = await one(project({ briefs: { "s.brief.yaml": text }, metadata: present }), "s");
  assert.deepEqual(found.unresolved, []);
  assert.equal(found.valid, true, JSON.stringify(found.errors));
  const missing = await one(project({ briefs: { "s.brief.yaml": text }, metadata: INVOICE }), "s");
  assert.deepEqual(missing.unresolved, [{ kind: "saga", ref: "com.acme.billing.Invoice#settlement" }]);
});

test("metadata that cannot be read makes references unchecked rather than unresolved", async () => {
  const root = project({ briefs: { "r.brief.yaml": fixture("ready") }, metadata: INVOICE });
  writeFileSync(join(root, "target", "classes", "exeris-metadata", "Broken.json"), "{not json");
  const { payload } = await run(root, { area: "r" });
  assert.deepEqual(payload?.briefs[0].unresolved, []);
  assert.equal(payload?.briefs[0].unchecked.length, 3);
  assert.equal((payload?.referenceSource as { state: string }).state, "unusable");
});

test("the capability manifest is never read", async () => {
  const root = project({ briefs: { "r.brief.yaml": fixture("ready") } });
  mkdirSync(join(root, "src", "main", "generated", "java"), { recursive: true });
  writeFileSync(join(root, "src", "main", "generated", "java", "cap-manifest.json"), JSON.stringify({ entities: ["com.acme.billing.Invoice"] }));
  const b = await one(root, "r");
  assert.equal(b.unchecked.length, 3);
});

// ---- YAML is data, bounded ----------------------------------------------------------------

test("a YAML alias bomb is refused, not expanded", async () => {
  const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
  let prev = "a";
  for (let i = 0; i < 9; i += 1) {
    const name = String.fromCharCode(98 + i);
    lines.push(`${name}: &${name} [${Array(10).fill(`*${prev}`).join(", ")}]`);
    prev = name;
  }
  const b = await one(project({ briefs: { "bomb.brief.yaml": lines.join("\n") + "\n" } }), "bomb");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.match(b.errors[0].message, /alias/i);
});

test("a file over the size cap is refused without being read", async () => {
  const big = "# " + "x".repeat(MAX_BRIEF_BYTES) + "\n" + fixture("ready");
  const b = await one(project({ briefs: { "big.brief.yaml": big } }), "big");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.match(b.errors[0].message, new RegExp(`limit is ${MAX_BRIEF_BYTES}`));
});

test("more than one YAML document, a non-mapping root and a custom tag are errors", async () => {
  const root = project({
    briefs: {
      "multi.brief.yaml": fixture("ready") + "---\n" + fixture("ready"),
      "list.brief.yaml": "- a\n- b\n",
      "scalar.brief.yaml": "just words\n",
      "tag.brief.yaml": fixture("minimal").replace("purpose: Keep", "purpose: !custom Keep"),
      "dup.brief.yaml": fixture("minimal") + "purpose: again\n",
      "broken.brief.yaml": "a: [unclosed\n",
    },
  });
  for (const area of ["multi", "list", "scalar", "tag", "dup", "broken"]) {
    const b = await one(root, area);
    assert.deepEqual({ valid: b.valid, ready: b.ready }, { valid: false, ready: false }, area);
    assert.ok(b.errors.length > 0, area);
  }
  assert.match((await one(root, "multi")).errors[0].message, /more than one YAML document/);
  assert.match((await one(root, "list")).errors[0].message, /mapping/);
});

test("YAML 1.2 core schema: the version stays a string and yes/no stay strings", async () => {
  const text = fixture("minimal").replace("briefSchema: 0.13.0", "briefSchema: 0.13");
  const b = await one(project({ briefs: { "v.brief.yaml": text } }), "v");
  assert.equal(b.valid, false);
  assert.ok(paths(b).includes("/briefSchema"));
});

// ---- the tool itself ----------------------------------------------------------------------

test("compiling a schema twice in one process yields the same validator", () => {
  assert.equal(compileBriefSchema(SCHEMA_TEXT), compileBriefSchema(SCHEMA_TEXT));
});

test("with no project the build family answers its structured unavailable result", async () => {
  const res: CallToolResult = await toolFor(null).handler({});
  assert.equal(res.isError, true);
  const body = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(body.error, "family_unavailable");
  assert.equal(body.family, "build");
  assert.ok(body.remedy.length > 0);
});

test("the tool is one of the eight build-* tools", () => {
  const { bundle, dir } = briefBundle();
  const names = registerBuildTools(configFor(null), bundle, dir).map((t) => t.definition.name).sort();
  assert.equal(names.length, 8);
  assert.ok(names.includes("build-validate_brief"));
});

test("validating writes nothing into the project", async () => {
  const root = project({ briefs: { "r.brief.yaml": fixture("ready"), "g.brief.yaml": fixture("gap-re-encoded-structure") }, metadata: INVOICE });
  const snapshot = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const stat = statSync(path);
        out.push(`${path}:${stat.isDirectory() ? "d" : stat.size}:${stat.mtimeMs}`);
        if (stat.isDirectory()) walk(path);
      }
    };
    walk(root);
    return out;
  };
  const before = snapshot();
  await run(root);
  await run(root, { area: "r" });
  assert.deepEqual(snapshot(), before);
});

test("the definition states what it reads, that it writes nothing, local-only, the schema order and readiness", () => {
  const description = toolFor(null).definition.description ?? "";
  for (const phrase of [/writes nothing/, /local only/, /pinned eu\.exeris:exeris-sdk-source-model jar/, /bundled with this bridge/, /never downloaded/, /valid and no blocking open question/]) {
    assert.match(description, phrase);
  }
  assert.equal(/\bbuild:\*|\bsdk:\*/.test(description), false);
});

// A guard against the fixtures drifting from the files the tests were written for.
// ajv is built without format validation, so a schema that starts relying on
// `format` would be enforced by the SDK's reader and silently skipped here.
test("the brief schema states no format keyword, so skipping format validation loses nothing", () => {
  const formats: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}/${i}`));
    } else if (typeof node === "object" && node !== null) {
      for (const [k, v] of Object.entries(node)) {
        if (k === "format" && typeof v === "string") formats.push(path);
        walk(v, `${path}/${k}`);
      }
    }
  };
  walk(JSON.parse(SCHEMA_TEXT), "");
  assert.deepEqual(formats, []);
});

// ---- validity is the schema plus its reader requirements -----------------------------------

/** The 0.13.1 schema as released: it lists only UNKNOWN_PROPERTIES_ARE_ERRORS. */
function listing(ids: readonly string[] | undefined): string {
  const schema = JSON.parse(SCHEMA_TEXT) as Record<string, unknown>;
  if (ids === undefined) delete schema["x-exeris-reader-requirements"];
  else schema["x-exeris-reader-requirements"] = ids.map((id) => ({ id }));
  return JSON.stringify(schema);
}

test("the released 0.13.1 schema lists only the unknown-properties requirement", () => {
  const ids = (JSON.parse(SCHEMA_TEXT)["x-exeris-reader-requirements"] as { id: string }[]).map((r) => r.id);
  assert.deepEqual(ids, ["UNKNOWN_PROPERTIES_ARE_ERRORS"]);
});

test("a repeated open-question id is reported at the later question", async () => {
  const b = await one(project({ briefs: { "q.brief.yaml": fixture("gap-repeated-question-id") } }), "q");
  assert.equal(b.valid, false);
  assert.equal(b.ready, false);
  assert.deepEqual(b.errors, [{ path: "/openQuestions/1/id", message: "repeats the id of /openQuestions/0" }]);
});

test("a workflow actor that no declared actor carries is reported at that actor", async () => {
  const b = await one(project({ briefs: { "w.brief.yaml": fixture("gap-undeclared-workflow-actor") } }), "w");
  assert.equal(b.valid, false);
  assert.deepEqual(b.errors, [{ path: "/workflows/0/actors/1", message: "names no actor the brief declares" }]);
});

test("both rules apply under a schema that lists only the unknown-properties requirement", async () => {
  for (const [name, path] of [["gap-repeated-question-id", "/openQuestions/1/id"], ["gap-undeclared-workflow-actor", "/workflows/0/actors/1"]]) {
    const b = await one(project({ briefs: { "x.brief.yaml": fixture(name) } }), "x", listing(["UNKNOWN_PROPERTIES_ARE_ERRORS"]), emptyM2());
    assert.equal(b.valid, false, name);
    assert.deepEqual(paths(b), [path], name);
  }
});

test("a schema with no requirements list, or a malformed one, still has both rules applied", async () => {
  for (const text of [listing(undefined), JSON.stringify({ ...JSON.parse(SCHEMA_TEXT), "x-exeris-reader-requirements": "nope" })]) {
    const b = await one(project({ briefs: { "x.brief.yaml": fixture("gap-repeated-question-id") } }), "x", text, emptyM2());
    assert.equal(b.valid, false);
    assert.deepEqual(paths(b), ["/openQuestions/1/id"]);
  }
});

test("a schema stating a requirement this build does not know is refused, from either source", async () => {
  const text = listing(["UNKNOWN_PROPERTIES_ARE_ERRORS", "SOMETHING_NEW"]);
  const root = project({ briefs: { "x.brief.yaml": fixture("minimal") } });
  for (const [schema, m2] of [[text, emptyM2()], [undefined, m2With(text)]] as const) {
    const r = await run(root, { area: "x" }, schema, m2);
    assert.equal(r.res.isError, true);
    const body = r.payload as unknown as { error: string; reason: string; remedy: string };
    assert.equal(body.error, "brief_schema_unusable");
    assert.match(body.reason, /SOMETHING_NEW/);
    assert.match(body.remedy, /Upgrade @exeris\/ai-bridge/);
  }
});

test("the rules do not double-report a shape the schema already rejects", async () => {
  const wrong = fixture("minimal") + "openQuestions: nope\n";
  const a = await one(project({ briefs: { "x.brief.yaml": wrong } }), "x");
  assert.equal(a.valid, false);
  assert.deepEqual(paths(a), ["/openQuestions"]);

  const noActors = fixture("minimal").replace("actors:\n  - name: Clerk\n", "actors: 5\n").replace("workflows:\n", "workflows:\n  - actors: [Ghost]\n    name: W\n    criteria: []\n");
  const b = await one(project({ briefs: { "y.brief.yaml": noActors } }), "y");
  assert.equal(b.errors.some((e) => e.message === "names no actor the brief declares"), false);
});

test("the unknown-concern-hint fixture is invalid on the schema alone, at the hint", async () => {
  const b = await one(project({ briefs: { "h.brief.yaml": fixture("gap-unknown-concern-hint") } }), "h");
  assert.deepEqual(paths(b), ["/glossary/0/concernHints/0"]);
});

// ---- skew is the schema used against the pin ----------------------------------------------

test("a project schema that matches the pin is aligned and carries no warning", async () => {
  const b = await one(project({ briefs: { "m.brief.yaml": fixture("minimal") } }), "m");
  assert.equal(b.skew.schemaSource, "project");
  assert.equal(b.skew.status, "aligned");
  assert.equal(b.skew.warning, undefined);
});

test("a pin whose jar is absent falls back to the bundled schema, and a newer brief is not validated against it", async () => {
  const newer = fixture("ready").replace("briefSchema: 0.13.0", "briefSchema: 0.14.0");
  const root = project({ sdk: "0.14.0", briefs: { "n.brief.yaml": newer, "o.brief.yaml": fixture("minimal") } });
  const n = await one(root, "n", undefined, emptyM2());
  assert.equal(n.skew.schemaSource, "bundled");
  assert.equal(n.skew.schemaSdkVersion, "0.13.1");
  assert.equal(n.skew.projectSdkVersion, "0.14.0");
  assert.equal(n.skew.status, "skew_detected");
  assert.match(String(n.skew.warning), /bundled with this bridge, from 0\.13\.1/);
  assert.match(String(n.skew.warning), /0\.14\.0 is newer/);
  assert.equal(n.valid, false);
  assert.equal(n.ready, false);
  assert.equal(n.errors[0].path, "/briefSchema");
  assert.match(n.errors[0].message, /newer than the SDK 0\.13\.1 whose brief schema was used/);
  // A brief at the schema's own release is validated, with the skew still reported.
  const o = await one(root, "o", undefined, emptyM2());
  assert.equal(o.valid, true);
  assert.equal(o.skew.status, "skew_detected");
});

test("with no readable pin a brief newer than the schema used is still not validated", async () => {
  const newer = fixture("ready").replace("briefSchema: 0.13.0", "briefSchema: 0.14.0");
  const b = await one(project({ sdk: null, briefs: { "n.brief.yaml": newer } }), "n");
  assert.equal(b.skew.projectSdkVersion, undefined);
  assert.equal(b.skew.schemaSdkVersion, "0.13.1");
  assert.equal(b.skew.status, "skew_detected");
  assert.equal(b.valid, false);
  assert.equal(b.errors[0].path, "/briefSchema");
  assert.equal(b.skew.briefSchema, "0.14.0");
});

// ---- the jar is read in-process, and a failure says what failed ----------------------------

test("a corrupt pinned jar is reported as unreadable with its cause, not as lacking the entry", async () => {
  const repo = emptyM2();
  const jar = join(repo, "eu/exeris/exeris-sdk-source-model/0.13.1/exeris-sdk-source-model-0.13.1.jar");
  mkdirSync(dirname(jar), { recursive: true });
  writeFileSync(jar, Buffer.alloc(300, 1));
  const b = await one(project({ briefs: { "m.brief.yaml": fixture("minimal") } }), "m", undefined, repo);
  assert.equal(b.skew.schemaSource, "bundled");
  assert.match(String(b.skew.note), /could not be read from .*end-of-central-directory/);
  assert.equal(/carries no/.test(String(b.skew.note)), false);
  assert.equal(b.valid, true);
});

test("a pinned jar without the entry says it carries none", async () => {
  const repo = emptyM2();
  writeJar(join(repo, "eu/exeris/exeris-sdk-source-model/0.13.1/exeris-sdk-source-model-0.13.1.jar"), { "x.txt": "y" });
  const b = await one(project({ briefs: { "m.brief.yaml": fixture("minimal") } }), "m", undefined, repo);
  assert.match(String(b.skew.note), /carries no META-INF\/exeris\/brief-schema\.json/);
});

test("a deflated schema in the pinned jar is used", async () => {
  const repo = emptyM2();
  writeJar(
    join(repo, "eu/exeris/exeris-sdk-source-model/0.13.1/exeris-sdk-source-model-0.13.1.jar"),
    { [ENTRY]: stricterSchema() },
    { deflate: true },
  );
  const b = await one(project({ briefs: { "m.brief.yaml": fixture("minimal") } }), "m", undefined, repo);
  assert.equal(b.skew.schemaSource, "project");
  assert.equal(b.valid, false);
});

// ---- the frozen top-level shape ------------------------------------------------------------

test("a call with briefs and a call with none answer with the same keys", async () => {
  const none = (await run(project())).payload!;
  const some = (await run(project({ briefs: { "a.brief.yaml": fixture("minimal") } }))).payload!;
  assert.deepEqual(Object.keys(none).sort(), Object.keys(some).sort());
  assert.deepEqual(Object.keys(some).sort(), ["briefs", "ignored", "ignoredTruncated", "notice", "present", "referenceSource"]);
  assert.equal(some.present, true);
  assert.equal(none.present, false);
});

test("present means a brief file was read: an area with no file is not present", async () => {
  const { payload } = await run(project({ briefs: { "a.brief.yaml": fixture("minimal") } }), { area: "zzz" });
  assert.equal(payload?.present, false);
  assert.equal(payload?.briefs.length, 1);
  assert.equal(payload?.briefs[0].ready, false);
});

test("the ignored list is capped and says when it was cut", async () => {
  const briefs: Record<string, string> = { "a.brief.yaml": fixture("minimal") };
  for (let i = 0; i < 25; i += 1) briefs[`Bad${i}.brief.yaml`] = "x";
  const { payload } = await run(project({ briefs }));
  assert.equal((payload?.ignored as string[]).length, 20);
  assert.equal(payload?.ignoredTruncated, true);
});

test("reference resolution that never ran is not_read, and one that found no directory is absent", async () => {
  const unparsable = await run(project({ briefs: { "a.brief.yaml": "- x\n" } }));
  assert.equal((unparsable.payload?.referenceSource as { state: string }).state, "not_read");
  const built = await run(project({ briefs: { "a.brief.yaml": fixture("minimal") } }));
  assert.equal((built.payload?.referenceSource as { state: string }).state, "absent");
});

test("a metadata directory that is a symlink out of the project is unusable, not absent", async () => {
  const outside = scratch("exeris-brief-outside-");
  writeFileSync(join(outside, "Invoice.json"), JSON.stringify(INVOICE["Invoice.json"]));
  const root = project({ briefs: { "r.brief.yaml": fixture("ready") } });
  mkdirSync(join(root, "target", "classes"), { recursive: true });
  symlinkSync(outside, join(root, "target", "classes", "exeris-metadata"));
  const { payload } = await run(root, { area: "r" });
  const source = payload?.referenceSource as { state: string; reason: string };
  assert.equal(source.state, "unusable");
  assert.match(source.reason, /sandbox escape/);
  assert.equal(payload?.briefs[0].unchecked.length, 3);
});

test("metadata beyond the total byte cap is unusable and the cap is named", async () => {
  const root = project({ briefs: { "r.brief.yaml": fixture("ready") } });
  const dir = join(root, "target", "classes", "exeris-metadata");
  mkdirSync(dir, { recursive: true });
  const pad = "x".repeat(900 * 1024);
  for (let i = 0; i < 19; i += 1) {
    writeFileSync(join(dir, `E${i}.json`), JSON.stringify({ schemaVersion: "1", entityName: `E${i}`, packageName: "p", pad }));
  }
  const { payload } = await run(root, { area: "r" });
  const source = payload?.referenceSource as { state: string; reason: string };
  assert.equal(source.state, "unusable");
  assert.match(source.reason, /16777216 bytes/);
});

test("the definition names the pom chain read from the local Maven repository and the not-validated outcome", () => {
  const description = toolFor(null).definition.description ?? "";
  assert.match(description, /app BOM poms it inherits from/);
  assert.match(description, /valid:false, ready:false with the skew reported, and is not validated/);
});

test("the fixture directory holds exactly the SDK's twelve briefs", () => {
  const names = readdirSync(BRIEFS).filter((n) => n.endsWith(".brief.yaml")).map((n) => n.replace(".brief.yaml", "")).sort();
  assert.deepEqual(names, [...ALL_FIXTURES].sort());
});
