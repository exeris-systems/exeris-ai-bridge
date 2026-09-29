---
title: "CLAUDE.md — exeris-ai-bridge"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-29
---

# CLAUDE.md — exeris-ai-bridge

This repository's agent contract lives in [`AGENTS.md`](AGENTS.md), and its detailed semantics in
[`.agents/`](.agents) — policies, references, role profiles, skills and workflows. Read `AGENTS.md`
first; it is the entry point every compatible agent can discover.

This file exists only because a Claude client looks for it (`agents-md-schema.md` rule 7, in
`exeris-systems/exeris-docs` under `standards/`). It states no rule of its own: a rule written here
would be a second place to author project semantics, which is what the schema forbids.

Claude-specific adapters generated from `.agents/` are in [`.claude/`](.claude), each carrying a
do-not-edit marker naming its source.
