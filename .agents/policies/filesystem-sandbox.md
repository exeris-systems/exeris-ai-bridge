---
title: "Policy — filesystem reads are sandboxed to pinned roots"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-28
---

# Policy — filesystem reads are sandboxed to pinned roots

Every filesystem-bound handler reads under a root the server pinned, never under a root the agent
named:

- `docs-*` reads the configured `exeris-docs` checkout (`../exeris-docs/` beside this repository in
  an ecosystem checkout), or, when none resolves, the registry snapshot under
  `<packageRoot>/data/docs/`, whose digests are verified at boot. Reads resolve against the
  ecosystem root, the parent of the docs root, so a registry record that links into a sibling
  repository can be read; nothing outside that root is. The per-repository tools refuse the
  enterprise-tier repositories and `exeris-business`. The `exeris://docs/*` resources and the
  prompts read through the same functions, so the same sandbox applies to them.
- A subscription to `exeris://docs/adr-index` watches the docs root, read-only, and only when a
  checkout answers and a subscriber exists: one watcher on that directory alone (no descent) that
  reports `adr-index.md` only, stopped at the last unsubscribe and when the server closes. A docs
  root that is a filesystem root or the home directory is refused. The watcher is the one in
  `src/fs/watch.ts`, with the confinement described under `lsp-*` below.
- The bundled reference corpus reads `<packageRoot>/data/`; each entry's path is sandbox-checked and
  its digest verified on every read.
- `build-*` and `caps-*` read the pinned `projectRoot` and nothing above it. So do the readers of
  the project's `pom.xml` and of its installed `@exeris/codegen-ts` manifest, which the SDK and
  tooling skew reports use; the POMs they follow into the local Maven repository are read under
  that repository's root.
- `lsp-*` pins the LSP workspace root, which defaults to the bridge's working directory unless
  `EXERIS_LSP_WORKSPACE` is set. The bridge may **watch** that root, read-only, to tell the language
  server about writes by other processes: one watcher per root, started only when the language
  server registers file watchers. It is confined to the root: events are resolved and dropped when
  they leave it, and symlinked directories are never followed. It places no watch under `.git` or
  `node_modules`, nor under `target` or `build` beside a `pom.xml` or Gradle build file (except
  `target/generated-sources` and `build/generated`), nor under `dist` beside a `package.json`. It
  holds at most 10 000 watched directories, and watches nothing when the root is a filesystem root
  or the home directory. Past those bounds the watch degrades to an invalidation before each
  request.
- `build-preview_generation` reads the project's `target/classes/exeris-metadata` (refused when it
  resolves outside `projectRoot`) and its committed generated tree (read only when it resolves
  inside `projectRoot`), and launches a generator it finds locally: the jar must resolve inside the
  local Maven repository, and the TypeScript entry point inside the installed package.

Never accept an absolute path from the agent and read it. Always resolve relative to a pinned root,
and verify the **resolved** path stays inside that root.

This applies to paths *we* generate too. The bundle manifest is ours, but it is still a file on disk
that a later step could rewrite, so its entry paths are sandbox-checked like any other.

## The one directory the bridge writes

`build-preview_generation` is the only code that writes files, and it writes only a scratch
directory it creates under the operating system's temporary directory for the call. The check is the
inverse of the sandbox's: the directory must lie **outside** the project root and the ecosystem
root, tested before it is created and again on its real path, and it is removed when the call
returns on every path and when the bridge exits.

The generator is handed that directory as its only output area, with a fixed environment allowlist.
Nothing in the generator's own code confines its writes, so the bridge does:

- the metadata corpus is validated before either generator starts, because a name with a path
  segment would otherwise place a file outside the output directory; a name or package that could
  not be an identifier, a separator or `..` in a name, a control character, or a symbolic link
  inside the corpus is refused;
- the TypeScript child runs under Node's permission model, with writes allowed only to the scratch
  directory;
- the Java child has no runtime confinement, so the corpus validation is what keeps it inside.

The review procedure for a handler that touches the filesystem is the
`exeris-ai-bridge-path-sandbox-review` skill.
