import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveGithubUrl, parseAdrIndex } from "./adr-index.js";

const MINIMAL = `# ADR Index

## Index

| #   | Title           | Owning repo   | Scope    | Visibility | Status                  | Link                                           |
|-----|-----------------|---------------|----------|------------|-------------------------|------------------------------------------------|
| 001 | First           | exeris-docs   | platform | public     | accepted (2025-10-10)   | [adr/ADR-001](adr/ADR-001-first.md)            |
| 007 | Cross-repo one  | exeris-kernel | kernel   | public     | proposed (2026-02-22)   | [exeris-kernel/...](../exeris-kernel/x.md)     |
| 016 | Private one     | enterprise    | bench    | enterprise-private | accepted (2026-03-23) | [...](../enterprise/y.md)               |
| 031 | Reserved one    | spring        | obs      | public     | reserved (2026-05-17 — content TBD) | _(reserved; pending)_              |
`;

test("parseAdrIndex returns one entry per row in the Index table", () => {
  const entries = parseAdrIndex(MINIMAL);
  assert.equal(entries.length, 4);
});

test("parseAdrIndex extracts integer and padded forms of the ADR number", () => {
  const [first] = parseAdrIndex(MINIMAL);
  assert.equal(first.number, 1);
  assert.equal(first.numberPadded, "001");
});

test("parseAdrIndex extracts title, owningRepo, scope, visibility verbatim", () => {
  const [first] = parseAdrIndex(MINIMAL);
  assert.equal(first.title, "First");
  assert.equal(first.owningRepo, "exeris-docs");
  assert.equal(first.scope, "platform");
  assert.equal(first.visibility, "public");
});

test("parseAdrIndex extracts the first whitespace token as status.state", () => {
  const entries = parseAdrIndex(MINIMAL);
  assert.equal(entries[0].status.state, "accepted");
  assert.equal(entries[1].status.state, "proposed");
  assert.equal(entries[3].status.state, "reserved");
});

test("parseAdrIndex preserves the full status cell in status.raw", () => {
  const [, , , reserved] = parseAdrIndex(MINIMAL);
  assert.equal(reserved.status.raw, "reserved (2026-05-17 — content TBD)");
});

test("parseAdrIndex extracts link display + target and URL-decodes both", () => {
  const withEncoded = `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 003 | T | r | s | public | accepted (2025-11-12) | [ADR-003 Entity](../x/ADR-003%20Entity%20First.md) |
`;
  const [entry] = parseAdrIndex(withEncoded);
  assert.ok(entry.link);
  assert.equal(entry.link!.target, "../x/ADR-003 Entity First.md");
  assert.equal(entry.link!.display, "ADR-003 Entity");
});

test("parseAdrIndex returns link=null when the link cell has no markdown link", () => {
  const [, , , reserved] = parseAdrIndex(MINIMAL);
  assert.equal(reserved.link, null);
});

test("parseAdrIndex stops at the next heading (cross-repo stubs table)", () => {
  const withSecondTable = MINIMAL + `
## Cross-repo stubs

| #   | Other affected repo | Stub link              |
|-----|---------------------|------------------------|
| 020 | exeris-docs         | [stub](../x/stub.md)   |
`;
  const entries = parseAdrIndex(withSecondTable);
  // Still 4 — the 020 row from the second table must not leak through.
  assert.equal(entries.length, 4);
  assert.ok(!entries.some((e) => e.number === 20));
});

test("parseAdrIndex tolerates blank lines inside the table block by skipping them", () => {
  const sparse = `## Index

| # | Title | Owning repo | Scope | Visibility | Status | Link |
|---|-------|-------------|-------|------------|--------|------|
| 001 | A | r | s | public | accepted (2025-10-10) | [x](adr/A.md) |

| 002 | B | r | s | public | accepted (2025-10-11) | [y](adr/B.md) |
`;
  // Behaviour: blank line is silently skipped, both rows parsed.
  const entries = parseAdrIndex(sparse);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].number, 1);
  assert.equal(entries[1].number, 2);
});

test("parseAdrIndex throws when the file is missing the '## Index' heading", () => {
  assert.throws(
    () => parseAdrIndex("# Some Other Doc\n\nnot an ADR index"),
    /missing the '## Index' heading/,
  );
});

test("deriveGithubUrl maps own-repo target to exeris-docs blob URL", () => {
  assert.equal(
    deriveGithubUrl("adr/ADR-001-foo.md", "public"),
    "https://github.com/exeris-systems/exeris-docs/blob/main/adr/ADR-001-foo.md",
  );
});

test("deriveGithubUrl maps cross-repo target via the first ../ segment", () => {
  assert.equal(
    deriveGithubUrl("../exeris-kernel/docs/adr/ADR-007-runtime.md", "public"),
    "https://github.com/exeris-systems/exeris-kernel/blob/main/docs/adr/ADR-007-runtime.md",
  );
});

test("deriveGithubUrl URL-encodes path segments containing spaces", () => {
  assert.equal(
    deriveGithubUrl("../exeris-sdk/docs/adr/ADR-003 Entity First.md", "public"),
    "https://github.com/exeris-systems/exeris-sdk/blob/main/docs/adr/ADR-003%20Entity%20First.md",
  );
});

test("deriveGithubUrl returns null for enterprise-private visibility", () => {
  assert.equal(
    deriveGithubUrl("../exeris-kernel-enterprise/docs/adr/ADR-018.md", "enterprise-private"),
    null,
  );
});

test("deriveGithubUrl returns null for malformed or escape-shaped targets", () => {
  assert.equal(deriveGithubUrl("", "public"), null);
  assert.equal(deriveGithubUrl("/etc/passwd", "public"), null);
  assert.equal(deriveGithubUrl("../", "public"), null);
  assert.equal(deriveGithubUrl("../../something", "public"), null);
});

test("parseAdrIndex populates link.github on each entry", () => {
  const entries = parseAdrIndex(MINIMAL);
  // entries: [0]=001 own-repo public, [1]=007 cross-repo public,
  //          [2]=016 cross-repo enterprise-private, [3]=031 reserved/no-link
  assert.equal(
    entries[0].link!.github,
    "https://github.com/exeris-systems/exeris-docs/blob/main/adr/ADR-001-first.md",
  );
  assert.equal(
    entries[1].link!.github,
    "https://github.com/exeris-systems/exeris-kernel/blob/main/x.md",
  );
  assert.equal(entries[2].link!.github, null);
  assert.equal(entries[3].link, null);
});

test("parseAdrIndex parses against the real exeris-docs/adr-index.md shape", () => {
  // Sample the first three real rows to ensure the parser holds against the
  // production index — no need to wire fs reads here; we replicate the rows.
  const real = `## Index

| #   | Title                                                                                    | Owning repo                  | Scope                | Visibility         | Status                                    | Link                                                                                                                                                                        |
|-----|------------------------------------------------------------------------------------------|------------------------------|----------------------|--------------------|-------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 001 | Cloud Native & Agnostic Infrastructure Strategy                                          | exeris-docs                  | platform             | public             | accepted (2025-10-10)                     | [adr/ADR-001 …](adr/ADR-001-cloud-native-and-agnostic-infrastructure-strategy.md)                                                                                           |
| 007 | Next-Gen Runtime Architecture                                                            | exeris-kernel                | kernel/runtime       | public             | accepted (2025-12-11, upd. 2026-02-22)    | [exeris-kernel/docs/adr/ADR-007 …](../exeris-kernel/docs/adr/ADR-007-next-gen-runtime-architecture.md)                                                                      |
| 016 | HTTP/3 Benchmarking — Enterprise-Only Track                                              | exeris-benchmarks-enterprise | benchmarks           | enterprise-private | accepted (2026-03-23)                     | [exeris-benchmarks-enterprise/docs/ADR-016 …](../exeris-benchmarks-enterprise/docs/ADR-016-HTTP3-BENCHMARKING-ENTERPRISE-TRACK.md)                                          |
`;
  const entries = parseAdrIndex(real);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].numberPadded, "001");
  assert.equal(entries[1].status.raw, "accepted (2025-12-11, upd. 2026-02-22)");
  assert.equal(entries[2].visibility, "enterprise-private");
  assert.equal(
    entries[1].link!.target,
    "../exeris-kernel/docs/adr/ADR-007-next-gen-runtime-architecture.md",
  );
});
