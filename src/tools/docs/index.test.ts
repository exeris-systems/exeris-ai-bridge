import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import type { BridgeConfig } from "../../config/env.js";
import { registerDocsTools } from "./index.js";

let base: string;
let config: BridgeConfig;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "exeris-docs-h-")));
  const docs = join(base, "exeris-docs");
  const adr = join(docs, "adr");
  const sibling = join(base, "exeris-kernel", "docs", "adr");
  mkdirSync(adr, { recursive: true });
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

  writeFileSync(join(adr, "ADR-001-local-a.md"), "# ADR-001 Local A\n\nBody for A.\n", "utf8");
  writeFileSync(join(adr, "ADR-002-local-b.md"), "# ADR-002 Local B\n\nBody for B.\n", "utf8");
  writeFileSync(
    join(sibling, "ADR-007-cross.md"),
    "# ADR-007 Cross-repo\n\nBody for cross-repo entry.\n",
    "utf8",
  );

  config = { docsRoot: docs, ecosystemRoot: base };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function tools() {
  return new Map(registerDocsTools(config).map((t) => [t.definition.name, t]));
}

test("registerDocsTools registers docs:list_adrs and docs:get_adr", () => {
  const t = tools();
  assert.ok(t.has("docs:list_adrs"));
  assert.ok(t.has("docs:get_adr"));
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
