---
title: "Reference — the tool families"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-04
---

# Reference — the tool families

Authoritative source: [ADR-025](../../docs/adr/ADR-025-ai-agent-bridge.md) and its amendments. What
follows is the short form an agent needs before touching a tool. It is not authority: when it and
ADR-025 disagree, ADR-025 wins and this file is the defect. The registered tools themselves are in
`src/tools/<family>/index.ts`.

| Family     | Scope | Source |
|:-----------|:------|:-------|
| `docs:*`   | ADR registry, HLA, whitepaper, templates — read-only | the `exeris-docs` filesystem |
| `lsp:*`    | `@ExerisDomain` source model, action signatures, codegen artefacts — read-only | `exeris-platform-lsp` via JSON-RPC |
| `kernel:*` | Provider registry, bootstrap/subsystem DAG, per-subsystem detail, resolved JVM ergonomics — read-only, one tool per `KernelDiagnostics` method (**cap-blind**; no capability composition) | Running kernel via `KernelDiagnostics` |
| `sdk:*`    | Annotation catalog, attribute contracts, `@Field`/`@Validation` scoping, deprecations, AST schema, project version skew — read-only, 0.7.0 complete | Released/reference `exeris-sdk` artifacts vendored into the package; scoping rules authored in-repo from `package-info` and ADR-054 |
| `build:*`  | The **user's own project**: emitted `DomainMetadata`, the codegen output tree with a per-file explanation, L1/L2 ownership, and a decoder for the diagnostics the build printed — read-only, 0.6.0 complete. Reads what the pipeline emitted; never predicts what it would emit | `<projectRoot>/target/classes/exeris-metadata/`, `<projectRoot>/src/main/generated/java/`, and a catalogue that ships in this package |
| `caps:*`   | `cap-manifest.json` + `CompositionStamp` for the user's own project — read-only; reads manifests, never re-resolves the `@Requires`→`@Provides` DAG | `<projectRoot>/src/main/generated/java/cap-manifest.json` |
| `bridge:*` | The **bridge itself**, not Exeris: resolved persona mode, per-family availability with reason + remedy, child-process state. Read-only, **zero spawns**, frozen at 2 tools | This server's own boot-time state |

## Where each family's authorisation comes from

- `docs:*`, `lsp:*`, `kernel:*` — ADR-025 obligation 2.
- `sdk:*`, `build:*`, `caps:*` — the 2026-08-16 "Two Personas" amendment. Their milestone numbers
  were reordered on 2026-09-02 (`build:*`/`caps:*` to 0.6.0, `sdk:*` to 0.7.0), which changes
  scheduling only, not authorisation. `caps:*` specifically satisfies the deferred-composition
  clause of the 2026-06-17 cap-blind amendment. `build:*` and `caps:*` are implemented as of 0.6.0;
  `sdk:*` as of 0.7.0, with public npm publication gated on the upstream 0.12.0 GA release reaching
  Maven Central. `build-get_starter` and `build-preview_generation` join `build:*` in 0.9.0 under the
  2026-10-04 amendment, which lets the preview write into a temporary directory the bridge owns and
  nowhere else.
- `bridge:*` — the 2026-08-26 addendum.

The rules for adding to any of them are in the [`tool-surface`](../policies/tool-surface.md) policy.
