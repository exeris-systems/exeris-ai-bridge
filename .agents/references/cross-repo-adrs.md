---
title: "Reference — when to consult the cross-repo ADRs"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-21
---

# Reference — when to consult the cross-repo ADRs

The ADRs below live in `exeris-systems/exeris-docs` under `adr/` (`../exeris-docs/adr/` in a sibling
checkout), indexed in its `adr-index.md`. This file says when each one bears on a change here; the
ADR text is the authority.

- **ADR-006** (Spring-Free Kernel Boundary) — every change that adds a dependency or extends
  `kernel:*` tooling.
- **ADR-020** (open-core documentation mirror policy) — every change that adds or changes
  documentation cross-references.
- **ADR-023** (capability licensing taxonomy) — when someone proposes changing the license or
  wrapping this repository in commercial terms.
- **ADR-024** (capability composition model) — its 2026-06-17 "Validation Stamp Lifecycle"
  amendment makes the open kernel **cap-blind**. `kernel:*` MUST NOT surface capability composition
  (there is no `kernel-list_capabilities`). Any composition surface sources from `exeris-tooling`
  build-time artefacts (`cap-manifest.json` + composition manifest) and/or the `exeris-platform`
  composition runtime, and needs its own ADR-025 amendment first. See ADR-025 §"`kernel:*` Is
  Cap-Blind".
- **ADR-025** (this repository's founding decision, `docs/adr/`) — every architectural change.
  Amendments to it are treated like amendments to a constitution.
- **ADR-033** — every change to the kernel adapter or `kernel:*` handlers; its consumer-side
  obligations are in `docs/adr/ADR-033.link.md`.
- **ADR-095** (stable diagnostic identifiers, `exeris-tooling`) — every change to
  `build-explain_diagnostic` or its catalogue; its consumer-side obligation is in
  `docs/adr/ADR-095.link.md`.
- **ADR-097** (generator catalogue and launchable generator, `exeris-tooling`) — every change to
  `build-explain_artefacts`, to the vendored generator catalogue (`scripts/vendor-reference-data.mjs`,
  `src/data/generator-catalogue.ts`) or to `build-preview_generation`'s launch of the generator; its
  consumer-side obligations are in `docs/adr/ADR-097.link.md`.

An ADR number is reserved in `adr-index.md` before its content is written.
