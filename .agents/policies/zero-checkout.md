---
title: "Policy — two personas, and the zero-checkout requirement"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-30
---

# Policy — two personas, and the zero-checkout requirement

Per the [ADR-025](../../docs/adr/ADR-025-ai-agent-bridge.md) 2026-08-16 amendment, the bridge serves
two co-equal audiences. Name which one a change serves before designing it:

- **P1 — ecosystem contributor.** Works *on* Exeris, has every sibling repository checked out.
  Served by `docs:*` / `kernel:*` / `lsp:*`.
- **P2 — application developer.** Builds *on* Exeris, has **no ecosystem checkout** — only a Maven
  dependency on `eu.exeris:*` and their own sources. Served by `sdk:*` / `build:*` / `caps:*`, and
  by `docs:*` from the registry snapshot bundled in the package (ADR-025 2026-09-30 amendment).

## Zero-checkout is a hard requirement

Any change to config resolution keeps the server booting on a machine with no `exeris-docs`, no
`exeris-platform`, no `exeris-kernel` on disk. A missing root disables its family with a structured
error; it never throws out of config load. `ecosystemRoot` is optional — never assume it exists.
`docs:*` is the one family with a bundled fallback: with no checkout it answers from the registry
snapshot under `data/docs/`, and is dark only when that snapshot is absent or fails its boot check.

## How it is enforced

`scripts/p2-smoke.mjs` (CI job `p2-smoke`, `npm run smoke:p2` — it refuses a bare `node scripts/…`
invocation) packs the real tarball, installs it into a scratch directory holding only an application
project, points `HOME` at an empty directory and scrubs every `EXERIS_*` variable.

**A change to config resolution, packaging (`files`, `bin`, `prepack`), or the launch ladder runs
it.** The unit suite runs inside an ecosystem checkout and cannot see a zero-checkout regression. Its
`assertZeroCheckout` guard exists because the test can go vacuous silently: the install-neighbour
docs default resolving would make `docs:*` answer from a checkout, and the assertions about the
bundled registry snapshot would stop testing it.
