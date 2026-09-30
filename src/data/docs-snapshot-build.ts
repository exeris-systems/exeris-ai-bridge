import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { localLinkCandidates, parseAdrIndex } from "../tools/docs/adr-index.js";
import { isServableRepo } from "../tools/docs/index.js";
import {
  DOCS_SNAPSHOT_DIRNAME,
  DOCS_SNAPSHOT_MANIFEST,
  DOCS_SNAPSHOT_NOTICE,
  DOCS_SNAPSHOT_SCHEMA_VERSION,
  REGISTRY_REPO,
  type DocsSnapshotManifest,
  type SnapshotExclusion,
  type SnapshotFile,
  type SnapshotSource,
} from "./docs-snapshot.js";

// Builds the docs registry snapshot at pack time (ADR-025, 2026-09-30
// amendment). Runs from `scripts/vendor-reference-data.mjs`; the reader is
// ./docs-snapshot.ts.
//
// What goes in: the registry's own files (adr-index.md, the HLA, the
// whitepaper, the decision templates) and the record each public index row
// links, wherever it lives. What decides whether a repository contributes at
// all: its name passes the public-scope policy the per-repo tools apply, it is
// public, and its licence permits redistributing its documentation.
//
// Every file is read from the repository's default branch at one recorded
// commit — never from a working tree, which is on whatever branch its owner has
// checked out.

const ECOSYSTEM_ORG = "exeris-systems";

/** Files of the registry repository that are served by name rather than by index link. */
export const REGISTRY_FILES: readonly string[] = [
  "adr-index.md",
  "high-level-architecture.md",
  "b2b-technical-whitepaper.md",
  "templates/ADR-TEMPLATE.md",
  "templates/RFC-TEMPLATE.md",
  "templates/RESEARCH-TEMPLATE.md",
];

const LICENCE_FILES: readonly string[] = ["LICENSE", "LICENSE.md", "LICENSE.txt"];

/** A repository as the source sees it: the commit files are read at, and whether it is public. */
export interface RepoHead {
  readonly commit: string;
  readonly public: boolean;
}

/** Where the snapshot's files come from. */
export interface SnapshotReader {
  /** The repository's default-branch head, or null when the repository does not exist. */
  head(repo: string): Promise<RepoHead | null>;
  /** One file at `commit`, or null when it does not exist there. */
  read(repo: string, commit: string, path: string): Promise<Buffer | null>;
}

export interface BuildReport {
  readonly manifest: DocsSnapshotManifest;
  /** Index rows whose record was not vendored, with why — for the build log. */
  readonly unresolved: readonly { readonly adr: string; readonly reason: string }[];
}

/**
 * Identify a documentation licence from its text. Only licences that permit
 * redistribution are recognised; anything else returns null and keeps the
 * repository out of the snapshot.
 */
export function detectLicence(text: string): string | null {
  const head = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  if (head[0] === "Apache License" && /^Version 2\.0\b/.test(head[1] ?? "")) return "Apache-2.0";
  return null;
}

/**
 * Build the snapshot into `<dataRoot>/docs`. The directory must not already
 * exist: the caller owns cleaning `data/`, and writing over a previous
 * snapshot would leave files the new manifest does not list.
 *
 * Throws when the registry itself cannot be vendored — without it there is
 * nothing to serve. A sibling repository that cannot contribute is recorded as
 * excluded and the build continues.
 */
export async function buildDocsSnapshot(
  reader: SnapshotReader,
  dataRoot: string,
  now: Date = new Date(),
): Promise<BuildReport> {
  const outRoot = join(dataRoot, DOCS_SNAPSHOT_DIRNAME);
  if (existsSync(outRoot)) throw new Error(`${outRoot} already exists; the snapshot is built into a clean directory`);

  const sources = new Map<string, SnapshotSource>();
  const excluded: SnapshotExclusion[] = [];
  const decided = new Set<string>();
  const files: SnapshotFile[] = [];
  const unresolved: { adr: string; reason: string }[] = [];

  /** Admit a repository once; returns its source, or null when it is excluded. */
  async function admit(repo: string): Promise<SnapshotSource | null> {
    if (decided.has(repo)) return sources.get(repo) ?? null;
    decided.add(repo);
    const exclude = (reason: string): null => {
      excluded.push({ repo, reason });
      return null;
    };
    if (!isServableRepo(repo)) return exclude("outside the public documentation scope");
    const head = await reader.head(repo);
    if (head === null) return exclude("not found");
    if (!head.public) return exclude("not a public repository");
    let licence: string | null = null;
    for (const name of LICENCE_FILES) {
      const text = await reader.read(repo, head.commit, name);
      if (text !== null) {
        licence = detectLicence(text.toString("utf8"));
        break;
      }
    }
    if (licence === null) return exclude("no licence that permits redistributing its documentation");
    const source = { repo, commit: head.commit, licence };
    sources.set(repo, source);
    return source;
  }

  function write(repo: string, path: string, bytes: Buffer): void {
    const target = join(outRoot, repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ repo, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }

  const registry = await admit(REGISTRY_REPO);
  if (registry === null) {
    const why = excluded.find((e) => e.repo === REGISTRY_REPO)?.reason ?? "unknown";
    throw new Error(`the registry repository ${REGISTRY_REPO} cannot be vendored: ${why}`);
  }

  const vendored = new Set<string>();
  for (const path of REGISTRY_FILES) {
    const bytes = await reader.read(REGISTRY_REPO, registry.commit, path);
    if (bytes === null) {
      if (path === "adr-index.md") throw new Error(`${REGISTRY_REPO} has no adr-index.md at ${registry.commit}`);
      continue;
    }
    write(REGISTRY_REPO, path, bytes);
    vendored.add(`${REGISTRY_REPO}/${path}`);
  }

  const index = readFileSync(join(outRoot, REGISTRY_REPO, "adr-index.md"), "utf8");
  for (const entry of parseAdrIndex(index)) {
    if (entry.link === null) continue;
    const adr = entry.numberPadded;
    if (entry.visibility !== "public") {
      unresolved.push({ adr, reason: `visibility ${entry.visibility}` });
      continue;
    }
    const candidates = localLinkCandidates(entry.link.target.trim());
    if (candidates === null) {
      unresolved.push({ adr, reason: "linked outside the ecosystem" });
      continue;
    }
    let found = false;
    let admittedRepo: string | null = null;
    for (const candidate of candidates) {
      const located = locate(candidate);
      if (located === null) continue;
      const source = await admit(located.repo);
      if (source === null) continue;
      admittedRepo = located.repo;
      const key = `${located.repo}/${located.path}`;
      if (vendored.has(key)) {
        found = true;
        break;
      }
      const bytes = await reader.read(located.repo, source.commit, located.path);
      if (bytes === null) continue;
      write(located.repo, located.path, bytes);
      vendored.add(key);
      found = true;
      break;
    }
    if (!found) {
      const repo = candidates.map(locate).find((l) => l !== null)?.repo ?? "unknown";
      unresolved.push({
        adr,
        reason:
          admittedRepo === null
            ? `repository ${repo} is excluded`
            : `not present on the default branch of ${admittedRepo}`,
      });
    }
  }

  const manifest: DocsSnapshotManifest = {
    schemaVersion: DOCS_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    sources: [...sources.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
    excluded: excluded.sort((a, b) => a.repo.localeCompare(b.repo)),
    files: files.sort((a, b) => `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`)),
  };
  writeFileSync(join(outRoot, DOCS_SNAPSHOT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(outRoot, DOCS_SNAPSHOT_NOTICE), renderNotice(manifest), "utf8");
  return { manifest, unresolved };
}

/**
 * Split a candidate (relative to the registry root) into repository and path.
 * Refuses anything that is not a plain path inside one repository.
 */
export function locate(candidate: string): { repo: string; path: string } | null {
  let repo = REGISTRY_REPO;
  let path = candidate.startsWith("./") ? candidate.slice(2) : candidate;
  if (path.startsWith("../")) {
    const rest = path.slice(3);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    repo = rest.slice(0, slash);
    path = rest.slice(slash + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") return null;
  }
  if (path.length === 0 || path.startsWith("/")) return null;
  if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  return { repo, path };
}

function renderNotice(manifest: DocsSnapshotManifest): string {
  const lines = [
    "# Bundled documentation",
    "",
    "This directory holds a snapshot of the Exeris documentation registry, served by the `docs:*`",
    "tools when no exeris-docs checkout is present. Each file is redistributed under the licence of",
    "the repository it was read from, at the commit listed below.",
    "",
    "| Repository | Commit | Licence |",
    "|:--|:--|:--|",
    ...manifest.sources.map(
      (s) => `| [${s.repo}](https://github.com/${ECOSYSTEM_ORG}/${s.repo}) | \`${s.commit}\` | ${s.licence} |`,
    ),
    "",
  ];
  if (manifest.excluded.length > 0) {
    lines.push("Repositories the registry links into that are not included:", "");
    for (const e of manifest.excluded) lines.push(`- ${e.repo} — ${e.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Readers

/**
 * Read from GitHub: each repository's default branch, pinned to the commit its
 * head resolved to when the build asked. File bytes come from the raw content
 * host at that commit, so every file of one repository is from the same tree.
 * `token` (GITHUB_TOKEN in CI) only raises the API rate limit; every
 * repository read is public.
 */
export function githubReader(token?: string, timeoutMs = 30_000): SnapshotReader {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "exeris-ai-bridge" };
  if (token !== undefined && token.length > 0) headers.Authorization = `Bearer ${token}`;

  async function get(url: string, accept?: string): Promise<Response | null> {
    const response = await fetch(url, {
      headers: accept === undefined ? headers : { ...headers, Accept: accept },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
    return response;
  }

  return {
    async head(repo) {
      const meta = await get(`https://api.github.com/repos/${ECOSYSTEM_ORG}/${repo}`);
      if (meta === null) return null;
      const info = (await meta.json()) as { default_branch?: unknown; private?: unknown };
      if (typeof info.default_branch !== "string") throw new Error(`${repo} reports no default branch`);
      const commit = await get(
        `https://api.github.com/repos/${ECOSYSTEM_ORG}/${repo}/commits/${encodeURIComponent(info.default_branch)}`,
        "application/vnd.github.sha",
      );
      if (commit === null) return null;
      return { commit: (await commit.text()).trim(), public: info.private === false };
    },
    async read(repo, commit, path) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const response = await get(`https://raw.githubusercontent.com/${ECOSYSTEM_ORG}/${repo}/${commit}/${encoded}`);
      return response === null ? null : Buffer.from(await response.arrayBuffer());
    },
  };
}

/**
 * Read from a local directory laid out as `<root>/<repo>/<path>`: a hermetic
 * source for tests and the zero-checkout smoke run. Every repository present is
 * treated as public; its commit is the content of `<repo>/.snapshot-commit`
 * when present, `local` otherwise.
 */
export function directoryReader(root: string): SnapshotReader {
  const base = realpathSync(root);
  return {
    head(repo) {
      const dir = join(base, repo);
      if (!isDirectory(dir)) return Promise.resolve(null);
      const marker = join(dir, ".snapshot-commit");
      const commit = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "local";
      return Promise.resolve({ commit, public: true });
    },
    read(repo, _commit, path) {
      if (locate(`../${repo}/${path}`) === null) return Promise.resolve(null);
      const file = join(base, repo, path);
      try {
        if (!realpathSync(file).startsWith(base + "/")) return Promise.resolve(null);
        return Promise.resolve(statSync(file).isFile() ? readFileSync(file) : null);
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
