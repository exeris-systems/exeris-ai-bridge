---
title: "Review rules for exeris-ai-bridge"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-22
---

# Review rules for `exeris-ai-bridge`

The `repo-routine` extension of `exeris-systems/.github`'s `docs-guardrails-review.md`, applied
**after** its steps and under its severity tags, output format and verdict schema. It adds checks and
raises severities; it lowers nothing and skips nothing. The shared routine judges prose, records,
commits and pull request bodies; this file judges the TypeScript server those documents describe.

## What this repository is answerable for

A Model Context Protocol server, in TypeScript on Node, that publishes Exeris surfaces to agents and
is driven by strings an agent chose. Three properties carry everything else: every tool is a read;
every path an agent names stays inside a pinned root; and the kernel is reached across a process
boundary, never linked. `CLAUDE.md` states them as hard constraints and strong defaults and is the
home of their wording; the rules below are how a reviewer applies them to a diff.

## Step B — rules of this repository

B1. **Every tool is a read.** A tool name, input schema, handler body or transport call that
    writes, restarts, swaps, deletes or applies — a `fs.writeFile` against a project path, LSP
    `workspace/applyEdit` or `exeris/applyMutation`, a kernel control-plane call, a handler that
    accepts a free-form command string — → `[HARD BLOCK]`. `lsp-preview_mutation`, which returns a
    diff computed in memory, is the one sanctioned path to an edit, and it writes nothing.

B2. **An agent-supplied path is resolved against a pinned root and proven to stay inside it.** A
    filesystem-bound handler that reads an absolute path an agent supplied, resolves without
    canonicalising (`realpath`, symlinks followed), or checks containment by string prefix on the
    unresolved path → `[HARD BLOCK]`. The same holds for paths the server generates itself, such as
    bundle-manifest entries. A new or changed filesystem-bound handler without a test that attempts
    a traversal (`..`, an encoded `..`, a symlink out of the root) → `[CONTRACT]`. A rejection
    that throws out of the handler rather than returning an MCP error result → `[CONTRACT]`.

B3. **The kernel is across a process boundary.** A dependency that bundles Java bytecode or links a
    JVM, or any in-process path to Java (GraalVM, JNI, JNR, native-image embedding) → `[HARD
    BLOCK]` (ADR-006, ADR-025). Kernel access is newline-delimited JSON over stdio against the
    `KernelDiagnostics` adapter, LSP access is JSON-RPC; a new wire format → `[CONTRACT]`.

B4. **No model runs here.** A dependency on a model SDK (`@anthropic-ai/sdk`, `openai` or any
    equivalent), a model API call, or a model key in code or configuration → `[HARD BLOCK]`. The
    bridge is the server half of MCP; the model lives in the client.

B5. **The bridge is not a capability.** `@Provides` / `@Requires`, an entry in a composition
    manifest, or a dependency from an `exeris-caps-*` artefact onto this package → `[HARD BLOCK]`
    (ADR-025 §Concrete obligations item 5).

B6. **A tool is exactly one family, and a family is authorised.** A registered tool name outside
    `^[a-z]+-[a-z_]+$`, a tool whose source coupling belongs to another family, a tool registered
    anywhere but its family's `register<Family>Tools()`, a new family without an ADR-025 amendment or
    successor ADR cited, or a third tool in the frozen `bridge-*` family → `[HARD BLOCK]`. A change
    that weakens the test holding the surface to that pattern → `[HARD BLOCK]`. A string the agent
    reads at runtime that names a family in the `family:*` prose form instead of the wire form →
    `[STYLE]`.

B7. **Agent strings are data, never code.** `eval`, `new Function(...)`, `vm` evaluation of input,
    or a dynamic `import()` / `require()` of a path an agent influenced → `[HARD BLOCK]`.

B8. **The compiler and the type-aware lint stay as strict as they are.** Turning off a `tsconfig`
    strictness flag (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`), adding
    a global ESLint relaxation, or widening one of the scoped relaxations `eslint.config.mjs` argues
    for → `[HARD BLOCK]` unless the same pull request argues it in the config the way the existing
    ones are argued. A new `@ts-ignore`, `@ts-expect-error`, `eslint-disable` or `as any` in `src/`
    outside a test without a comment saying why it is needed there → `[CONTRACT]`. A floating promise
    or an unhandled rejection in a handler → `[CONTRACT]`.

B9. **The server boots with no ecosystem checkout.** A change to configuration resolution,
    packaging (`files`, `bin`, `prepack`) or the launch ladder that can throw out of configuration
    load when a root is missing, or that assumes `ecosystemRoot` exists → `[HARD BLOCK]`: a missing
    root disables its family with a structured error. Such a change without the zero-checkout smoke
    (`npm run smoke:p2`, CI job `p2 smoke`) green on the pull request → `[CONTRACT]`.

B10. **`data/` is generated.** A committed file under `data/`, a hand edit of it, or placeholder
    content → `[HARD BLOCK]`. It is rebuilt by `prepack` from released artefacts with every digest
    verified.

B11. **Behaviour arrives with a test, and the checks this repository runs are green.** A change in
    behaviour under `src/tools/` or `src/transport/` without a test that fails without it →
    `[CONTRACT]`. `REPOSITORY CHECK OUTPUT` carries `npm run typecheck`, `npm run lint` and
    `npm test`; any of them failing → `[HARD BLOCK]`. A *Verification* section whose counts disagree
    with that output → `[STYLE]`; one claiming tests that do not exist → `[HARD BLOCK]`.

B12. **Dependencies are few and justified.** A new runtime dependency without a sentence in the
    pull request body saying what it replaces or why the standard library does not do it →
    `[CONTRACT]`. A dependency pinned to a floating tag, a git URL, or a registry other than npm's →
    `[CONTRACT]`.

## Where this does not apply, and what it costs

Not to the shared routine's own steps: PR body, records, commits and hygiene are judged by
`docs-guardrails-review.md` and are not restated here. Not to the agent material under `.agents/`,
which the shared checks judge against the bundle.

These rules are prose a reviewer applies. B8, B10 and B11 are mechanical and partly enforced already
— the compiler, the lint and the test suite run in `build.yml` and as the repository checks this
review reads — and B6's name pattern is a test. B1, B2, B3 and B7 are judgement over a diff, and a
reviewer that reads them loosely enforces them loosely; each belongs in a test or a lint rule the
moment one can express it.
