import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A miniature ecosystem for the docs registry snapshot: the registry, one
// licensed sibling, one sibling whose licence the builder does not recognise,
// and an enterprise-tier repository the public-scope policy refuses by name.
// Written to a scratch directory by the tests and by the zero-checkout smoke
// run rather than committed, because committed files shaped like other
// repositories' ADRs would read as ADRs to every tool that looks for them.
//
// The index rows cover each way a record is vendored or left out: a relative
// link, a GitHub URL into a licensed sibling, an unlicensed sibling, an
// enterprise-private row, a public row in an enterprise-tier repository, a URL
// naming a file the sibling's default branch does not have, and a link outside
// the ecosystem.

const ADR_INDEX = `# ADR Index (fixture)

## Index

| #   | Title            | Owning repo              | Scope    | Visibility         | Status                | Link |
|-----|------------------|--------------------------|----------|--------------------|-----------------------|------|
| 001 | Local record     | exeris-docs              | platform | public             | accepted (2026-01-01) | [adr/ADR-001](adr/ADR-001-local-record.md) |
| 003 | Sibling by URL   | exeris-sdk               | sdk      | public             | accepted (2026-01-01) | [exeris-sdk/docs/adr/ADR-003 …](https://github.com/exeris-systems/exeris-sdk/blob/main/docs/adr/ADR-003-sibling-by-url.md) |
| 007 | Unlicensed repo  | exeris-kernel            | kernel   | public             | accepted (2026-01-01) | [exeris-kernel/docs/adr/ADR-007 …](../exeris-kernel/docs/adr/ADR-007-unlicensed.md) |
| 016 | Private record   | exeris-kernel-enterprise | kernel   | enterprise-private | accepted (2026-01-01) | […](../exeris-kernel-enterprise/docs/adr/ADR-016-private.md) |
| 018 | Denied repo name | exeris-kernel-enterprise | kernel   | public             | accepted (2026-01-01) | […](../exeris-kernel-enterprise/docs/adr/ADR-018-denied.md) |
| 020 | Not on branch    | exeris-sdk               | sdk      | public             | accepted (2026-01-01) | [exeris-sdk/docs/adr/ADR-020 …](https://github.com/exeris-systems/exeris-sdk/blob/development/0.12.0/docs/adr/ADR-020-not-on-branch.md) |
| 031 | Reserved         | exeris-docs              | platform | public             | reserved (2026-01-01) | _(reserved; pending)_ |
| 040 | Foreign          | exeris-docs              | platform | public             | accepted (2026-01-01) | [elsewhere](https://example.com/adr/ADR-040.md) |
`;

const FILES: Readonly<Record<string, string>> = {
  "exeris-docs/.snapshot-commit": "fixture-docs-commit\n",
  "exeris-docs/LICENSE": "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   (Fixture: the header the snapshot builder recognises; not a licence grant.)\n",
  "exeris-docs/adr/ADR-001-local-record.md": "# ADR-001 Local record\n\nThe Wall is mentioned here.\n",
  "exeris-docs/b2b-technical-whitepaper.md": "# Whitepaper (fixture)\n",
  "exeris-docs/high-level-architecture.md": "# HLA (fixture)\n\nThree-tier model.\n",
  "exeris-docs/templates/ADR-TEMPLATE.md": "# ADR TEMPLATE (fixture)\n",
  "exeris-docs/templates/RESEARCH-TEMPLATE.md": "# RESEARCH TEMPLATE (fixture)\n",
  "exeris-docs/templates/RFC-TEMPLATE.md": "# RFC TEMPLATE (fixture)\n",
  "exeris-docs/working-note.md": "# Working note (fixture)\n\nNot part of the registry tier; the snapshot must leave it out.\n",
  "exeris-kernel-enterprise/LICENSE": "EXERIS COMMERCIAL SOURCE-AVAILABLE LICENSE (ECSL)\n(Fixture: an enterprise-tier repository is never Apache-licensed. The snapshot builder never reads this file — the repository is excluded by name first.)\n",
  "exeris-kernel-enterprise/docs/adr/ADR-016-private.md": "# ADR-016 Private\n",
  "exeris-kernel-enterprise/docs/adr/ADR-018-denied.md": "# ADR-018 Denied\n",
  "exeris-kernel/LICENSE": "EXERIS SOFTWARE LICENSE — INDEX\n(Fixture: a licence the snapshot builder does not recognise.)\n",
  "exeris-kernel/docs/adr/ADR-007-unlicensed.md": "# ADR-007 Unlicensed\n",
  "exeris-sdk/.snapshot-commit": "fixture-sdk-commit\n",
  "exeris-sdk/LICENSE": "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   (Fixture: the header the snapshot builder recognises; not a licence grant.)\n",
  "exeris-sdk/docs/adr/ADR-003-sibling-by-url.md": "# ADR-003 Sibling by URL\n\nEntity-first.\n",
  "exeris-docs/adr-index.md": ADR_INDEX,
};

/** Write the fixture ecosystem into `root`, laid out as `<repo>/<path>`. */
export function writeDocsEcosystemFixture(root: string): void {
  for (const [path, content] of Object.entries(FILES)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}
