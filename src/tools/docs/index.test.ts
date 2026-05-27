import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import { SandboxEscapeError } from "../../fs/sandbox.js";
import type { BridgeConfig } from "../../config/env.js";
import { formatSandboxStderrLine, redactEcosystemPaths, registerDocsTools } from "./index.js";

let base: string;
let config: BridgeConfig;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "exeris-docs-h-")));
  const docs = join(base, "exeris-docs");
  const adr = join(docs, "adr");
  const templates = join(docs, "templates");
  const sibling = join(base, "exeris-kernel", "docs", "adr");
  mkdirSync(adr, { recursive: true });
  mkdirSync(templates, { recursive: true });
  mkdirSync(sibling, { recursive: true });

  writeFileSync(
    join(docs, "adr-index.md"),
    `# ADR Index

## Index

| #   | Title           | Owning repo   | Scope    | Visibility         | Status                  | Link                                                          |
|-----|-----------------|---------------|----------|--------------------|-------------------------|---------------------------------------------------------------|
| 001 | Local A         | exeris-docs   | platform | public             | accepted (2026-01-01)   | [adr/ADR-001](adr/ADR-001-local-a.md)                         |
| 002 | Local B         | exeris-docs   | platform | public             | proposed (2026-02-01)   | [adr/ADR-002](adr/ADR-002-local-b.md)                         |
| 007 | Cross-repo C    | exeris-kernel | kernel   | public             | accepted (2026-03-01)   | [exeris-kernel/...](../exeris-kernel/docs/adr/ADR-007-cross.md) |
| 016 | Enterprise D    | enterprise    | bench    | enterprise-private | accepted (2026-04-01)   | [...](../exeris-enterprise/docs/adr/ADR-016-private.md)       |
| 031 | Reserved E      | spring        | obs      | public             | reserved (2026-05-01)   | _(reserved; pending)_                                         |
`,
    "utf8",
  );

  writeFileSync(join(adr, "ADR-001-local-a.md"), "# ADR-001 Local A\n\nBody for A.\nThe Wall is mentioned here.\n", "utf8");
  writeFileSync(join(adr, "ADR-002-local-b.md"), "# ADR-002 Local B\n\nBody for B.\n", "utf8");
  writeFileSync(
    join(sibling, "ADR-007-cross.md"),
    "# ADR-007 Cross-repo\n\nBody for cross-repo entry.\n",
    "utf8",
  );

  writeFileSync(join(templates, "ADR-TEMPLATE.md"), "# ADR-NNN TEMPLATE\n\nFill me in.\n", "utf8");
  writeFileSync(join(templates, "RFC-TEMPLATE.md"), "# RFC TEMPLATE\n\nFill me in.\n", "utf8");
  writeFileSync(join(templates, "RESEARCH-TEMPLATE.md"), "# RESEARCH TEMPLATE\n\nFill me in.\n", "utf8");

  writeFileSync(join(docs, "high-level-architecture.md"), "# HLA\n\nThree-tier model.\n", "utf8");
  writeFileSync(join(docs, "b2b-technical-whitepaper.md"), "# Whitepaper\n\nB2B story.\n", "utf8");

  config = { docsRoot: docs, ecosystemRoot: base };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function tools() {
  return new Map(registerDocsTools(config).map((t) => [t.definition.name, t]));
}

test("registerDocsTools registers all nine docs:* tools", () => {
  const t = tools();
  assert.ok(t.has("docs:list_adrs"));
  assert.ok(t.has("docs:get_adr"));
  assert.ok(t.has("docs:get_template"));
  assert.ok(t.has("docs:get_hla"));
  assert.ok(t.has("docs:get_whitepaper"));
  assert.ok(t.has("docs:search"));
  assert.ok(t.has("docs:list_repos"));
  assert.ok(t.has("docs:list_repo_docs"));
  assert.ok(t.has("docs:get_repo_doc"));
});

test("docs:list_adrs returns every entry from the registry as JSON text", async () => {
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.length, 5);
  assert.deepEqual(
    payload.map((e: { number: number }) => e.number),
    [1, 2, 7, 16, 31],
  );
});

test("docs:list_adrs filters by status (case-insensitive)", async () => {
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({ status: "ACCEPTED" });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.length, 3);
  assert.ok(payload.every((e: { status: { state: string } }) => e.status.state === "accepted"));
});

test("docs:list_adrs returns isError when status filter matches no entries in a non-empty registry", async () => {
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({ status: "withdrawn" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /No ADRs in the registry have status='withdrawn'/);
  // Surfaces the actually-present states so the agent can recover from a typo.
  assert.match(text, /Known states/);
});

test("docs:list_adrs trims whitespace in the status filter before comparing", async () => {
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({ status: "  accepted  " });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.length, 3);
});

test("docs:list_adrs treats whitespace-only status as no-filter", async () => {
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({ status: "   " });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.length, 5);
});

test("docs:list_adrs returns isError when the registry file is missing", async () => {
  rmSync(join(config.docsRoot, "adr-index.md"));
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({});
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /Failed to read adr-index.md/);
});

test("docs:get_adr returns the markdown body for an own-repo ADR", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 1 });
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# ADR-001 Local A/);
});

test("docs:get_adr resolves cross-repo links via the ecosystem sandbox", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 7 });
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# ADR-007 Cross-repo/);
});

test("docs:get_adr returns isError for an ADR not in the registry", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 999 });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /ADR-999 is not in the registry/);
});

test("docs:get_adr returns isError for a reserved ADR with no link", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 31 });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /has no link in the registry/);
});

test("docs:get_adr returns isError with enterprise-private hint when content is missing", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 16 });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /enterprise-private/);
});

test("docs:get_adr rejects non-integer input", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res1 = await tool.handler({ number: "001" });
  const res2 = await tool.handler({ number: 1.5 });
  assert.equal(res1.isError, true);
  assert.equal(res2.isError, true);
});

test("docs:get_adr rejects zero and negative numbers with a clean error (not 'ADR-0-1')", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res0 = await tool.handler({ number: 0 });
  const resNeg = await tool.handler({ number: -1 });
  assert.equal(res0.isError, true);
  assert.equal(resNeg.isError, true);
  assert.match((res0.content[0] as { text: string }).text, /must be ≥ 1/);
  assert.match((resNeg.content[0] as { text: string }).text, /must be ≥ 1/);
  // Verify no malformed 'ADR-0-1' / 'ADR-000' leaked.
  assert.doesNotMatch((resNeg.content[0] as { text: string }).text, /ADR-/);
});

test("docs:get_adr rejects an empty link target without leaking docsRoot", async () => {
  // `[empty]()` parses to link=null at the parser layer (empty target is not
  // a valid link contract), so the handler reaches the "no link in registry"
  // branch — same protection: docsRoot must not leak in the error message.
  writeFileSync(
    join(config.docsRoot, "adr-index.md"),
    `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 050 | Empty | exeris-docs | platform | public | accepted (2026-01-01) | [empty]() |
`,
    "utf8",
  );
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 50 });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  // Either the parser-side "no link" path or a handler-side "empty target"
  // message is acceptable; what's NOT acceptable is leaking docsRoot.
  assert.match(text, /(no link in the registry|empty link target)/);
  assert.ok(!text.includes(config.docsRoot));
});

test("docs:get_adr error messages render paths relative to ecosystemRoot, not absolute", async () => {
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 16 }); // enterprise-private, file missing
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  // ecosystemRoot prefix must NOT appear in the message — paths are relativized.
  assert.ok(!text.includes(config.ecosystemRoot));
  // But the relative segment SHOULD still be informative.
  assert.match(text, /exeris-enterprise/);
});

test("docs:get_adr surfaces real sandbox escape via symlink (not masked as 'missing content')", async (t) => {
  // Whole setup runs inside try/finally so a partial failure (mkdtemp
  // succeeds, writeFileSync fails) still cleans up outsideBase.
  const outsideBase = realpathSync(mkdtempSync(join(tmpdir(), "exeris-outside-")));
  try {
    const outsideFile = join(outsideBase, "trojan.md");
    writeFileSync(outsideFile, "stolen content");
    const linkPath = join(config.docsRoot, "adr", "ADR-099-trojan.md");

    try {
      symlinkSync(outsideFile, linkPath);
    } catch {
      // Loud skip — silently no-op'ing on a platform where symlinkSync isn't
      // permitted would let the F5 fix get credited as 'tested' in CI runs
      // where it isn't.
      t.skip("symlinkSync not permitted on this platform (Windows / sandboxed CI)");
      return;
    }

    // Plant a registry entry whose link is lexically inside docsRoot but the
    // realpath escapes via the symlink.
    writeFileSync(
      join(config.docsRoot, "adr-index.md"),
      `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 099 | Trojan | exeris-docs | platform | public | accepted (2026-01-01) | [trojan](adr/ADR-099-trojan.md) |
`,
      "utf8",
    );

    const tool = tools().get("docs:get_adr")!;
    const res = await tool.handler({ number: 99 });
    assert.equal(res.isError, true);
    const text = (res.content[0] as { text: string }).text;
    // Must classify as escape, not as benign missing-content/enterprise-private.
    assert.match(text, /escapes the ecosystem sandbox/);
    assert.doesNotMatch(text, /enterprise-private/);
    assert.doesNotMatch(text, /could not be resolved on disk/);
  } finally {
    rmSync(outsideBase, { recursive: true, force: true });
  }
});

test("docs:list_adrs registry-read error does not leak ecosystemRoot in the message", async () => {
  // Force a SandboxEscape on the index path itself (delete the file so
  // resolveInside fails with SandboxEscapeError(resolved=null)).
  rmSync(join(config.docsRoot, "adr-index.md"));
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.ok(!text.includes(config.ecosystemRoot), `leaked ecosystemRoot: ${text}`);
  assert.ok(!text.includes(config.docsRoot), `leaked docsRoot: ${text}`);
  assert.match(text, /Failed to read adr-index.md/);
});

test("docs:get_adr readFileSync error (EISDIR via directory target) does not leak ecosystemRoot", async () => {
  // Outcome-level audit: regardless of which error type Node raises (EISDIR
  // here carries no path in the message; EACCES would carry one), the
  // wire-facing string never contains ecosystemRoot. Direct
  // redactEcosystemPaths unit tests above cover the substitution mechanism
  // itself; this is a defence-in-depth smoke.
  const target = join(config.docsRoot, "adr"); // a directory, not a file
  writeFileSync(
    join(config.docsRoot, "adr-index.md"),
    `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 077 | Directory | exeris-docs | platform | public | accepted (2026-01-01) | [dir](adr) |
`,
    "utf8",
  );
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 77 });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  // The relativized prefix should appear; the absolute path in the trailing
  // err.message should be sanitized to <ecosystem>.
  assert.ok(!text.includes(config.ecosystemRoot), `leaked ecosystemRoot in: ${text}`);
  // Spot-check: tmpdir absolute paths typically start with '/' on POSIX.
  // We assert no substring of the absolute target leaked verbatim.
  assert.ok(!text.includes(target), `leaked absolute target: ${text}`);
  void target; // silence unused if branch above changes
});

test("redactEcosystemPaths replaces the ecosystemRoot+sep prefix with <ecosystem>", () => {
  const c: BridgeConfig = { docsRoot: "/x/dev/exeris-docs", ecosystemRoot: "/x/dev" };
  assert.equal(
    redactEcosystemPaths("ENOENT: open '/x/dev/exeris-docs/foo.md'", c),
    "ENOENT: open '<ecosystem>/exeris-docs/foo.md'",
  );
});

test("redactEcosystemPaths does NOT over-replace when ecosystemRoot is a non-boundary prefix of another path", () => {
  // The whole point of anchoring on `ecosystemRoot + sep`: /x/dev must not
  // match inside /x/development/foo. Pre-anchor substitution produced
  // "<ecosystem>elopment/foo" — both malformed AND leaked the adjacent
  // path's existence.
  const c: BridgeConfig = { docsRoot: "/x/dev/exeris-docs", ecosystemRoot: "/x/dev" };
  const message = "ENOENT: no such file, open '/x/development/foo.md'";
  assert.equal(redactEcosystemPaths(message, c), message);
});

test("redactEcosystemPaths leaves messages with no ecosystemRoot prefix unchanged", () => {
  const c: BridgeConfig = { docsRoot: "/x/dev/exeris-docs", ecosystemRoot: "/x/dev" };
  assert.equal(redactEcosystemPaths("EISDIR: illegal operation", c), "EISDIR: illegal operation");
  assert.equal(redactEcosystemPaths("adr-index.md missing", c), "adr-index.md missing");
});

test("formatSandboxStderrLine produces a single-line JSON object with structured fields", () => {
  const err = new SandboxEscapeError("/r", "candidate.md", "/r/candidate.md");
  const line = formatSandboxStderrLine(err);
  // Exactly one trailing newline, nothing in the middle.
  assert.ok(line.endsWith("\n"));
  assert.equal(line.match(/\n/g)?.length, 1);
  const parsed = JSON.parse(line.slice(0, -1));
  assert.equal(parsed.level, "error");
  assert.equal(parsed.component, "exeris-ai-bridge");
  assert.equal(parsed.event, "SandboxEscape");
  assert.equal(parsed.root, "/r");
  assert.equal(parsed.candidate, "candidate.md");
  assert.equal(parsed.resolved, "/r/candidate.md");
});

test("formatSandboxStderrLine neutralises control chars in agent-reachable fields (no log forging / ANSI injection)", () => {
  // Threat model: a poisoned exeris-docs entry like `[label](trojan%0A[exeris-ai-bridge] fake.md)`
  // decodes to a candidate containing a real newline. Without JSON-escaping,
  // the stderr write would emit two lines: the real one + a forged
  // "[exeris-ai-bridge] fake.md" that a log scraper would parse as another
  // bridge log line. Same vector for ANSI escapes (clear-screen etc).
  const malicious = new SandboxEscapeError(
    "/root",
    "trojan.md\n[exeris-ai-bridge] forged log line\x1b[2J",
    null,
  );
  const line = formatSandboxStderrLine(malicious);
  // Only the trailing newline survives.
  assert.equal(line.match(/\n/g)?.length, 1);
  // ESC byte is encoded; no raw \x1b leaks through.
  assert.ok(!line.includes("\x1b"));
  // The forged-line text appears in the JSON string-encoded form, NOT as a
  // separate bare log line.
  const parsed = JSON.parse(line.slice(0, -1));
  assert.match(parsed.candidate, /forged log line/);
});

test("docs:list_adrs missing-index error never contains the ecosystem path or an over-replace artefact", async () => {
  // Outcome smoke: the SandboxError branch is path-free by design; the
  // non-Sandbox redaction branch is exercised by redactEcosystemPaths unit
  // tests above. This test catches regressions where future error wrapping
  // accidentally interpolates a raw path through some other code path.
  rmSync(join(config.docsRoot, "adr-index.md"));
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.ok(!text.includes(config.ecosystemRoot));
  // No '<ecosystem>elopment' or similar over-replace artefact.
  assert.doesNotMatch(text, /<ecosystem>[a-zA-Z0-9]/);
});

test("docs:list_adrs 'Known states' message filters out empty status strings", async () => {
  // Plant a row with an intentionally-blank status cell. parseRow doesn't
  // reject it (only numberPadded is regex-validated), so the entry's
  // status.state is ''. The Known-states list must NOT include the empty
  // string, which would render as ", accepted, proposed" with leading comma.
  writeFileSync(
    join(config.docsRoot, "adr-index.md"),
    `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 080 | Blank | r | s | public |  | [x](adr/X.md) |
| 081 | Real | r | s | public | accepted (2026-01-01) | [y](adr/Y.md) |
`,
    "utf8",
  );
  const tool = tools().get("docs:list_adrs")!;
  const res = await tool.handler({ status: "withdrawn" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  // No leading or doubled comma in the known-states list.
  assert.doesNotMatch(text, /Known states[^:]*:\s*,/);
  assert.doesNotMatch(text, /,\s*,/);
  // Sanity: 'accepted' is in the present list.
  assert.match(text, /accepted/);
});

test("docs:get_adr rejects a link that escapes the ecosystem sandbox", async () => {
  // Real escape: enough ../ to climb above ecosystemRoot (= base = /tmp/...).
  // POSIX `path.join` neutralizes a leading `/` in the target, so an absolute
  // `/etc/passwd` target is NOT an escape — it lexically lands inside docsRoot.
  // The actual attack surface is dot-dot traversal in the target.
  writeFileSync(
    join(config.docsRoot, "adr-index.md"),
    `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 099 | Escape | exeris-docs | platform | public | accepted (2026-01-01) | [escape](../../../etc/passwd) |
`,
    "utf8",
  );
  const tool = tools().get("docs:get_adr")!;
  const res = await tool.handler({ number: 99 });
  assert.equal(res.isError, true);
  assert.match(
    (res.content[0] as { text: string }).text,
    /escapes the ecosystem sandbox/,
  );
});

// ---------------------------------------------------------------------------
// docs:get_template

test("docs:get_template returns the ADR template body", async () => {
  const tool = tools().get("docs:get_template")!;
  const res = await tool.handler({ kind: "ADR" });
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# ADR-NNN TEMPLATE/);
});

test("docs:get_template returns the RFC and RESEARCH templates", async () => {
  const tool = tools().get("docs:get_template")!;
  const rfc = await tool.handler({ kind: "RFC" });
  const research = await tool.handler({ kind: "RESEARCH" });
  assert.match((rfc.content[0] as { text: string }).text, /^# RFC TEMPLATE/);
  assert.match((research.content[0] as { text: string }).text, /^# RESEARCH TEMPLATE/);
});

test("docs:get_template rejects an unknown kind with a clean message", async () => {
  const tool = tools().get("docs:get_template")!;
  const res = await tool.handler({ kind: "PRD" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /'kind' must be one of ADR, RFC, RESEARCH/);
});

test("docs:get_template rejects a missing or non-string kind", async () => {
  const tool = tools().get("docs:get_template")!;
  const res1 = await tool.handler({});
  const res2 = await tool.handler({ kind: 42 });
  assert.equal(res1.isError, true);
  assert.equal(res2.isError, true);
});

test("docs:get_template returns isError without leaking docsRoot when the template file is missing", async () => {
  rmSync(join(config.docsRoot, "templates", "ADR-TEMPLATE.md"));
  const tool = tools().get("docs:get_template")!;
  const res = await tool.handler({ kind: "ADR" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.ok(!text.includes(config.ecosystemRoot), `leaked ecosystemRoot: ${text}`);
  assert.match(text, /ADR-TEMPLATE.md/);
});

// ---------------------------------------------------------------------------
// docs:get_hla + docs:get_whitepaper

test("docs:get_hla returns the high-level-architecture body", async () => {
  const tool = tools().get("docs:get_hla")!;
  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# HLA/);
});

test("docs:get_whitepaper returns the whitepaper body", async () => {
  const tool = tools().get("docs:get_whitepaper")!;
  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# Whitepaper/);
});

test("docs:get_hla returns isError without leaking ecosystemRoot when the file is missing", async () => {
  rmSync(join(config.docsRoot, "high-level-architecture.md"));
  const tool = tools().get("docs:get_hla")!;
  const res = await tool.handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.ok(!text.includes(config.ecosystemRoot));
});

// ---------------------------------------------------------------------------
// docs:search

test("docs:search finds a literal substring across the docs tree", async () => {
  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "The Wall" });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.ok(payload.hitCount >= 1);
  assert.ok(payload.hits.some((h: { path: string }) => h.path.endsWith("ADR-001-local-a.md")));
});

test("docs:search is case-insensitive", async () => {
  const tool = tools().get("docs:search")!;
  const upper = await tool.handler({ query: "THE WALL" });
  const lower = await tool.handler({ query: "the wall" });
  const upperHits = JSON.parse((upper.content[0] as { text: string }).text).hitCount;
  const lowerHits = JSON.parse((lower.content[0] as { text: string }).text).hitCount;
  assert.equal(upperHits, lowerHits);
  assert.ok(upperHits >= 1);
});

test("docs:search pathFilter narrows the file set", async () => {
  const tool = tools().get("docs:search")!;
  // 'Body' appears in both ADR-001 and ADR-002 in the fixture.
  const allRes = await tool.handler({ query: "Body" });
  const allHits = JSON.parse((allRes.content[0] as { text: string }).text);
  const filteredRes = await tool.handler({ query: "Body", pathFilter: "ADR-001" });
  const filteredHits = JSON.parse((filteredRes.content[0] as { text: string }).text);
  assert.ok(allHits.hitCount > filteredHits.hitCount);
  assert.ok(filteredHits.hits.every((h: { path: string }) => h.path.includes("ADR-001")));
});

test("docs:search respects maxResults and reports truncated=true when capped", async () => {
  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "Body", maxResults: 1 });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.hitCount, 1);
  assert.equal(payload.truncated, true);
});

test("docs:search clamps maxResults above the hard cap", async () => {
  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "Body", maxResults: 999_999 });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  // 200 is the cap; the query won't produce 200 hits but maxResults in the
  // payload should be clamped.
  assert.equal(payload.maxResults, 200);
});

test("docs:search rejects an empty or whitespace-only query", async () => {
  const tool = tools().get("docs:search")!;
  const empty = await tool.handler({ query: "" });
  const blank = await tool.handler({ query: "   " });
  assert.equal(empty.isError, true);
  assert.equal(blank.isError, true);
});

test("docs:search returns hits=[] when nothing matches but request was valid", async () => {
  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "x-x-x-no-such-token-x-x-x" });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.hitCount, 0);
  assert.deepEqual(payload.hits, []);
});

test("docs:search includes line number and snippet for each hit", async () => {
  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "The Wall" });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  const hit = payload.hits[0];
  assert.ok(typeof hit.line === "number" && hit.line >= 1);
  assert.ok(typeof hit.snippet === "string" && hit.snippet.length > 0);
  assert.ok(hit.snippet.toLowerCase().includes("the wall"));
});

// ---------------------------------------------------------------------------
// docs:list_repos / docs:list_repo_docs / docs:get_repo_doc

function seedSiblingRepoFixture(name: string, files: Record<string, string>): string {
  const repoDocs = join(config.ecosystemRoot, name, "docs");
  mkdirSync(repoDocs, { recursive: true });
  for (const [relPath, body] of Object.entries(files)) {
    const full = join(repoDocs, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return repoDocs;
}

test("docs:list_repos returns sibling exeris-* repos that have a docs/ directory", async () => {
  // The existing fixture only creates exeris-docs and exeris-kernel/docs/adr.
  // Add two more siblings to make the discovery non-trivial.
  seedSiblingRepoFixture("exeris-sdk", { "guide.md": "# SDK guide" });
  mkdirSync(join(config.ecosystemRoot, "exeris-tooling"), { recursive: true }); // no docs/
  seedSiblingRepoFixture("exeris-spring-runtime", { "overview.md": "# Spring" });

  const tool = tools().get("docs:list_repos")!;
  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  // exeris-kernel already has docs/ (from the base fixture's adr/ subdir).
  // exeris-tooling has no docs/ so it should NOT appear.
  assert.ok(payload.repos.includes("exeris-kernel"));
  assert.ok(payload.repos.includes("exeris-sdk"));
  assert.ok(payload.repos.includes("exeris-spring-runtime"));
  assert.ok(!payload.repos.includes("exeris-tooling"));
  // exeris-docs is the docsRoot itself; it shows up if it has docs/ (which
  // it doesn't here) — assert only that the discovery is deterministic.
  assert.deepEqual([...payload.repos].sort((a: string, b: string) => a.localeCompare(b)), payload.repos);
});

test("docs:list_repos handles an ecosystemRoot it cannot read by returning []", async () => {
  // Synthesise an empty-but-valid config to drive the empty branch.
  const emptyRoot = realpathSync(mkdtempSync(join(tmpdir(), "exeris-empty-")));
  const altConfig: BridgeConfig = { docsRoot: emptyRoot, ecosystemRoot: emptyRoot };
  try {
    const altTool = registerDocsTools(altConfig).find((t) => t.definition.name === "docs:list_repos")!;
    const res = await altTool.handler({});
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.repos, []);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("docs:list_repo_docs lists *.md files excluding the adr/ subtree", async () => {
  seedSiblingRepoFixture("exeris-sdk", {
    "guide.md": "# Guide",
    "subsystems/persistence.md": "# Persistence",
    "subsystems/transport.md": "# Transport",
    "adr/ADR-100-fake.md": "# Should be excluded",
  });
  const tool = tools().get("docs:list_repo_docs")!;
  const res = await tool.handler({ repo: "exeris-sdk" });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  const paths = payload.docs.map((d: { path: string }) => d.path);
  assert.ok(paths.includes("guide.md"));
  assert.ok(paths.some((p: string) => p.startsWith("subsystems/")));
  // ADR subdir excluded by design.
  assert.ok(!paths.some((p: string) => p.startsWith("adr/")));
});

test("docs:list_repo_docs returns isError for a non-existent repo without leaking ecosystemRoot", async () => {
  const tool = tools().get("docs:list_repo_docs")!;
  const res = await tool.handler({ repo: "exeris-nonexistent" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /not present as a real directory|has no real docs/);
  assert.ok(!text.includes(config.ecosystemRoot));
});

test("docs:list_repo_docs rejects repo names that don't match the exeris-* convention (path-traversal guard)", async () => {
  const tool = tools().get("docs:list_repo_docs")!;
  const cases = ["", "../etc", "/abs/path", "Exeris-Kernel", "node_modules", "exeris-", "exeris-_underscore"];
  for (const repo of cases) {
    const res = await tool.handler({ repo });
    assert.equal(res.isError, true, `should reject repo=${JSON.stringify(repo)}`);
    assert.match((res.content[0] as { text: string }).text, /must match \/\^exeris-/);
  }
});

test("docs:get_repo_doc returns the body of a doc under <repo>/docs/<path>", async () => {
  seedSiblingRepoFixture("exeris-sdk", {
    "subsystems/persistence.md": "# Persistence subsystem\n\nDetails here.",
  });
  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-sdk", path: "subsystems/persistence.md" });
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# Persistence subsystem/);
});

test("docs:get_repo_doc rejects an ADR path with a redirection hint to docs:get_adr", async () => {
  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-kernel", path: "adr/ADR-007.md" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /use docs:get_adr/);
});

test("docs:get_repo_doc rejects path traversal in the 'path' argument", async () => {
  seedSiblingRepoFixture("exeris-sdk", { "guide.md": "# Guide" });
  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-sdk", path: "../../../etc/passwd" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  // Either sandbox rejects, or file not found — never a successful read.
  assert.ok(!text.includes("/etc/passwd") || /sandbox|not found/.test(text));
});

test("docs:get_repo_doc rejects malformed inputs", async () => {
  const tool = tools().get("docs:get_repo_doc")!;
  const r1 = await tool.handler({ repo: "exeris-sdk" });
  const r2 = await tool.handler({ repo: "exeris-sdk", path: "" });
  const r3 = await tool.handler({ repo: "exeris-sdk", path: "   " });
  const r4 = await tool.handler({ repo: "../etc", path: "passwd" });
  assert.equal(r1.isError, true);
  assert.equal(r2.isError, true);
  assert.equal(r3.isError, true);
  assert.equal(r4.isError, true);
});

test("docs:get_repo_doc cannot read cross-repo files via ../ traversal (sandbox at <repo>/docs, not ecosystemRoot)", async () => {
  // Plant a file in a DIFFERENT sibling repo's checkout (not in docs/).
  // Reviewer's scenario: get_repo_doc with repo='exeris-sdk' and path that
  // escapes to '../../exeris-kernel/pom.xml'. Pre-fix the sandbox was
  // anchored at ecosystemRoot, so containment passed and the file leaked.
  const kernelRoot = join(config.ecosystemRoot, "exeris-kernel");
  mkdirSync(kernelRoot, { recursive: true });
  writeFileSync(join(kernelRoot, "pom.xml"), "<project>secret</project>", "utf8");
  seedSiblingRepoFixture("exeris-sdk", { "guide.md": "# Guide" });

  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({
    repo: "exeris-sdk",
    path: "../../exeris-kernel/pom.xml",
  });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /sandbox escape|not found/);
  // Must NOT have served the pom.xml content.
  assert.ok(!text.includes("<project>"));
});

test("docs:get_repo_doc ADR-redirect catches normalised paths (./adr/X.md)", async () => {
  // Reviewer's scenario: literal startsWith('adr/') is false for './adr/...',
  // path.join would normalise it back, and the ADR file would leak past the
  // registry-only contract. The fast-path lowercase check catches this
  // before resolution because './adr/...' lower-startsWith('adr/') === false
  // but the POST-resolution guard catches it on the normalised relative path.
  // Plant a real ADR file in the sibling docs/adr/ directory.
  const adrDir = join(config.ecosystemRoot, "exeris-kernel", "docs", "adr");
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(join(adrDir, "ADR-007.md"), "# secret ADR", "utf8");

  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-kernel", path: "./adr/ADR-007.md" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /use docs:get_adr/);
});

test("docs:get_repo_doc ADR-redirect catches traversal-normalised paths (foo/../adr/X.md)", async () => {
  const adrDir = join(config.ecosystemRoot, "exeris-kernel", "docs", "adr");
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(join(adrDir, "ADR-007.md"), "# secret ADR", "utf8");
  mkdirSync(join(config.ecosystemRoot, "exeris-kernel", "docs", "foo"), { recursive: true });

  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({
    repo: "exeris-kernel",
    path: "foo/../adr/ADR-007.md",
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /use docs:get_adr/);
});

test("docs:get_repo_doc fast-path catches case-insensitive ADR prefix (ADR/...)", async () => {
  // On case-insensitive FS (macOS/Windows), 'ADR/...' resolves to 'adr/...'.
  // The lowercase fast-path catches the input shape directly; the
  // post-resolution guard would also catch the normalised path on those
  // platforms. On Linux (case-sensitive) the file genuinely doesn't exist
  // at 'ADR/...' — fast-path still redirects so the agent gets the hint
  // instead of "not found".
  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-kernel", path: "ADR/ADR-007.md" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /use docs:get_adr/);
});

test("docs:get_repo_doc serves a legitimate top-level adr.md meta-doc (not an ADR record)", async () => {
  // Reviewer's scenario: `adr.md` is a meta-doc about ADRs, NOT an ADR
  // record. The earlier overly-strict exclusion blocked it entirely.
  // Now it's reachable.
  seedSiblingRepoFixture("exeris-sdk", { "adr.md": "# How we use ADRs in the SDK\n" });
  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-sdk", path: "adr.md" });
  assert.equal(res.isError, undefined);
  assert.match((res.content[0] as { text: string }).text, /^# How we use ADRs/);
});

test("docs:list_repo_docs includes adr-adjacent dirs (adr-drafts/, adr-extras/) — those are NOT registry content", async () => {
  seedSiblingRepoFixture("exeris-sdk", {
    "adr-drafts/wip-ADR-110.md": "# Draft",
    "adr-extras/historical.md": "# Notes",
    "adr/ADR-100.md": "# Should be excluded (registry)",
  });
  const tool = tools().get("docs:list_repo_docs")!;
  const res = await tool.handler({ repo: "exeris-sdk" });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  const paths = payload.docs.map((d: { path: string }) => d.path);
  assert.ok(paths.some((p: string) => p.startsWith("adr-drafts/")));
  assert.ok(paths.some((p: string) => p.startsWith("adr-extras/")));
  assert.ok(!paths.some((p: string) => p.startsWith("adr/")));
});

test("docs:list_repo_docs includes adr.md as a regular file", async () => {
  seedSiblingRepoFixture("exeris-sdk", { "adr.md": "# Meta-doc" });
  const tool = tools().get("docs:list_repo_docs")!;
  const res = await tool.handler({ repo: "exeris-sdk" });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.ok(payload.docs.some((d: { path: string }) => d.path === "adr.md"));
});

test("docs:list_repos excludes exeris-docs itself (covered by registry tools)", async () => {
  // Plant exeris-docs/docs/ to make sure even with that present it's NOT
  // listed (the discovery filters it out by name).
  mkdirSync(join(config.ecosystemRoot, "exeris-docs", "docs"), { recursive: true });
  const tool = tools().get("docs:list_repos")!;
  const res = await tool.handler({});
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.ok(!payload.repos.includes("exeris-docs"));
});

test("docs:get_repo_doc rejects repo='exeris-docs' with a hint to use registry tools", async () => {
  const tool = tools().get("docs:get_repo_doc")!;
  const res = await tool.handler({ repo: "exeris-docs", path: "high-level-architecture.md" });
  assert.equal(res.isError, true);
  assert.match(
    (res.content[0] as { text: string }).text,
    /covered by the registry-tier tools/,
  );
});

test("docs:list_repos with a non-existent ecosystemRoot actually exercises the readdirSync catch", async () => {
  // Reviewer's #15: the previous test used a real-but-empty tmpdir, which
  // doesn't throw — it returns []. To genuinely exercise the try/catch we
  // need readdirSync to fail. A long unique random path that definitely
  // doesn't exist does it.
  const fakeRoot = "/__exeris-bridge-does-not-exist-" + Math.random().toString(36).slice(2) + "__";
  const altConfig: BridgeConfig = { docsRoot: fakeRoot, ecosystemRoot: fakeRoot };
  const altTool = registerDocsTools(altConfig).find((t) => t.definition.name === "docs:list_repos")!;
  const res = await altTool.handler({});
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.count, 0);
  assert.deepEqual(payload.repos, []);
});

test("docs:search returns isError when docsRoot is unreadable (no silent 'no matches')", async () => {
  rmSync(config.docsRoot, { recursive: true, force: true });
  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "anything" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /not a readable directory|EXERIS_DOCS_ROOT/);
});

test("docs:search marks truncated=true when oversize files are skipped (no false 'all matches returned')", async () => {
  // Plant a file just over SEARCH_MAX_BYTES_PER_FILE (10MB). Use a
  // size-only sparse write would be faster, but writeFileSync of a 10MB
  // string is fast enough for one test.
  const oversizeContent = "x".repeat(10_000_001);
  writeFileSync(join(config.docsRoot, "huge.md"), oversizeContent, "utf8");
  // Plant a small file that DOES contain the query so hits=1, not 0.
  writeFileSync(join(config.docsRoot, "small.md"), "# small\nThe Wall here\n", "utf8");

  const tool = tools().get("docs:search")!;
  const res = await tool.handler({ query: "The Wall" });
  const text = (res.content[0] as { text: string }).text;
  const payload = JSON.parse(text);
  assert.ok(payload.hitCount >= 1);
  assert.equal(payload.truncated, true, `expected truncated:true when oversize files skipped, payload: ${text}`);
});

test("docs:get_adr writes a structured stderr line on SandboxEscape (parity with other handlers)", async () => {
  // Capture stderr writes to verify formatSandboxStderrLine fires from the
  // get_adr inline catch — earlier this path was the only sandbox-error
  // surface without operator-debug output, even though it's the most
  // likely legit-escape path (cross-repo registry links).
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    // Plant a registry entry whose target escapes via real ../traversal.
    writeFileSync(
      join(config.docsRoot, "adr-index.md"),
      `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 099 | Escape | exeris-docs | platform | public | accepted (2026-01-01) | [x](../../../etc/passwd) |
`,
      "utf8",
    );
    const tool = tools().get("docs:get_adr")!;
    await tool.handler({ number: 99 });
  } finally {
    (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  const sandboxLines = captured.filter((line) => line.includes('"event":"SandboxEscape"'));
  assert.ok(sandboxLines.length >= 1, `expected SandboxEscape stderr line, captured: ${JSON.stringify(captured)}`);
});

test("docs:search skips symlinks that escape the ecosystem (no content served)", async (t) => {
  const outsideBase = realpathSync(mkdtempSync(join(tmpdir(), "exeris-outside-search-")));
  try {
    const secret = join(outsideBase, "secret.md");
    writeFileSync(secret, "this is super-secret content with The Wall in it");
    const linkPath = join(config.docsRoot, "trojan.md");
    try {
      symlinkSync(secret, linkPath);
    } catch {
      t.skip("symlinkSync not permitted on this platform");
      return;
    }
    const tool = tools().get("docs:search")!;
    const res = await tool.handler({ query: "super-secret" });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    assert.equal(payload.hitCount, 0);
    assert.ok(!payload.hits.some((h: { path: string }) => h.path.includes("trojan")));
  } finally {
    rmSync(outsideBase, { recursive: true, force: true });
  }
});
