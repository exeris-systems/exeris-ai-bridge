import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { BridgeConfig } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { RegisteredTool } from "../types.js";
import { parseAdrIndex, type AdrEntry } from "./adr-index.js";

// docs:* — surfaces the exeris-docs ADR registry, canonical narratives,
// decision-doc templates, and a bounded literal-substring search to AI
// agents over MCP. Filesystem reads route through the path-sandbox
// (ecosystemRoot) so cross-repo ADR links work without granting the agent
// access to anything else on disk. Search is scoped to `docsRoot` only
// (not the wider ecosystem) — cross-repo content is reachable via get_adr.

const ADR_INDEX_FILENAME = "adr-index.md";
const HLA_FILENAME = "high-level-architecture.md";
const WHITEPAPER_FILENAME = "b2b-technical-whitepaper.md";

// Per-repo docs live in `<ecosystemRoot>/<repo>/docs/**`. The repo regex
// matches the ecosystem's naming convention and prevents agent input from
// smuggling path traversal via repo name (e.g. repo="../etc").
const REPO_NAME_RE = /^exeris-[a-z0-9][a-z0-9-]*$/;
const REPO_DOCS_DIRNAME = "docs";
// Exactly the `adr/` subdirectory is registry territory — entries listed in
// adr-index.md live there and flow through docs:get_adr. Sibling directories
// like `adr-drafts/`, `adr-extras/`, `adr-archive/` are NOT registry content
// and are intentionally surfaced via per-repo tools.
const REPO_DOCS_ADR_SUBDIR = "adr";
// `exeris-docs` itself is covered by the registry-tier tools (list_adrs,
// get_adr, get_hla, get_whitepaper, get_template) and must not appear as a
// "sibling" in list_repos / get_repo_doc — would create overlapping access
// paths with different visibility semantics.
const REPO_NAME_DOCS_SELF = "exeris-docs";

const TEMPLATE_FILES: Record<TemplateKind, string> = {
  ADR: "templates/ADR-TEMPLATE.md",
  RFC: "templates/RFC-TEMPLATE.md",
  RESEARCH: "templates/RESEARCH-TEMPLATE.md",
};
type TemplateKind = "ADR" | "RFC" | "RESEARCH";
const TEMPLATE_KINDS: TemplateKind[] = ["ADR", "RFC", "RESEARCH"];

// docs:search safety caps. The docs tree is small (dozens of files); these
// are headroom rather than tight bounds, but they make the worst case
// bounded regardless of what an agent supplies.
const SEARCH_MAX_RESULTS_DEFAULT = 50;
const SEARCH_MAX_RESULTS_CAP = 200;
const SEARCH_MAX_FILES_VISITED = 1000;
const SEARCH_MAX_BYTES_PER_FILE = 10_000_000;
const SEARCH_MAX_TOTAL_BYTES = 50_000_000;
const SEARCH_MAX_SNIPPET_LEN = 200;

export function registerDocsTools(config: BridgeConfig): RegisteredTool[] {
  return [
    listAdrsTool(config),
    getAdrTool(config),
    getTemplateTool(config),
    getHlaTool(config),
    getWhitepaperTool(config),
    searchTool(config),
    listReposTool(config),
    listRepoDocsTool(config),
    getRepoDocTool(config),
  ];
}

// ---------------------------------------------------------------------------
// docs:list_adrs

function listAdrsTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:list_adrs",
      description:
        "List all ADRs from the Exeris ecosystem registry. Each entry " +
        "carries number, title, owning repo, scope, visibility, status, " +
        "and link. Optional `status` filter narrows the result by the " +
        "first token of the status cell (e.g. 'accepted', 'proposed', " +
        "'superseded', 'reserved').",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Filter to entries whose status.state equals this value " +
              "(case-insensitive; trimmed before comparison).",
          },
        },
      },
    },
    handler: async (args) => {
      const status =
        typeof args.status === "string" ? args.status.trim().toLowerCase() : "";
      let entries: AdrEntry[];
      try {
        entries = readAdrIndex(config);
      } catch (err) {
        return errorResult(describeReadError(err, config, "adr-index.md"));
      }
      if (status.length === 0) {
        return ok(JSON.stringify(entries, null, 2));
      }
      const filtered = entries.filter((e) => e.status.state.toLowerCase() === status);
      if (filtered.length === 0 && entries.length > 0) {
        const present = [
          ...new Set(entries.map((e) => e.status.state).filter((s) => s.length > 0)),
        ].sort((a, b) => a.localeCompare(b));
        return errorResult(
          `No ADRs in the registry have status='${status}'. ` +
            `Known states in the current registry: ${present.join(", ")}.`,
        );
      }
      return ok(JSON.stringify(filtered, null, 2));
    },
  };
}

// ---------------------------------------------------------------------------
// docs:get_adr

function getAdrTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:get_adr",
      description:
        "Fetch the full markdown body of a specific ADR by number. " +
        "Resolves the link from the registry against the ecosystem root, " +
        "so cross-repo ADRs (those whose content lives in a sibling repo) " +
        "are read from their authoritative source.",
      inputSchema: {
        type: "object",
        properties: {
          number: {
            type: "integer",
            description: "ADR number (e.g. 24 for ADR-024).",
            minimum: 1,
          },
        },
        required: ["number"],
      },
    },
    handler: async (args) => {
      if (typeof args.number !== "number" || !Number.isInteger(args.number)) {
        return errorResult(
          `Invalid input: 'number' must be an integer, got ${typeof args.number}`,
        );
      }
      const number = args.number;
      if (number < 1) {
        return errorResult(`Invalid input: 'number' must be ≥ 1, got ${number}`);
      }

      let entries: AdrEntry[];
      try {
        entries = readAdrIndex(config);
      } catch (err) {
        return errorResult(describeReadError(err, config, "adr-index.md"));
      }

      const entry = entries.find((e) => e.number === number);
      if (!entry) {
        return errorResult(`ADR-${pad(number)} is not in the registry`);
      }
      if (!entry.link) {
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") has no link in the registry ` +
            `(status: ${entry.status.raw}). The content is not yet authored.`,
        );
      }

      const trimmedTarget = entry.link.target.trim();
      if (trimmedTarget.length === 0) {
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") has an empty link target in the registry.`,
        );
      }

      const joined = join(config.docsRoot, trimmedTarget);
      let resolved: string;
      try {
        resolved = resolveInside(config.ecosystemRoot, joined);
      } catch (err) {
        if (err instanceof SandboxEscapeError) {
          // Operator-debug stderr parity with the other handlers — get_adr is
          // the most likely legit-escape surface (cross-repo links) so the
          // operator needs the structured fields on both branches below.
          process.stderr.write(formatSandboxStderrLine(err));
          if (err.resolved === null) {
            return errorResult(missingAdrContentMessage(entry, config, joined));
          }
          return errorResult(
            `ADR-${entry.numberPadded} link target escapes the ecosystem sandbox: ` +
              `${entry.link.target}`,
          );
        }
        throw err;
      }

      let body: string;
      try {
        body = readFileSync(resolved, "utf8");
      } catch (err) {
        const reason = redactEcosystemPaths(
          err instanceof Error ? err.message : String(err),
          config,
        );
        return errorResult(
          `ADR-${entry.numberPadded} ("${entry.title}") link resolves to ` +
            `${relativizeToEcosystem(config, resolved)}, ` +
            `but the file could not be read: ${reason}.`,
        );
      }

      return ok(body);
    },
  };
}

// ---------------------------------------------------------------------------
// docs:get_template

function getTemplateTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:get_template",
      description:
        "Fetch one of the canonical decision-doc templates from " +
        "exeris-docs/templates/. Three kinds: ADR (decision made), " +
        "RFC (multi-option strategic question), RESEARCH (falsifiable " +
        "hypothesis, lab-notebook shape).",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: TEMPLATE_KINDS,
            description: "Template kind: ADR, RFC, or RESEARCH.",
          },
        },
        required: ["kind"],
      },
    },
    handler: async (args) => {
      if (typeof args.kind !== "string" || !TEMPLATE_KINDS.includes(args.kind as TemplateKind)) {
        return errorResult(
          `Invalid input: 'kind' must be one of ${TEMPLATE_KINDS.join(", ")}, got ${JSON.stringify(args.kind)}`,
        );
      }
      const kind = args.kind as TemplateKind;
      return readDocsFileResult(config, TEMPLATE_FILES[kind], `${kind}-TEMPLATE.md`);
    },
  };
}

// ---------------------------------------------------------------------------
// docs:get_hla

function getHlaTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:get_hla",
      description:
        "Fetch the High-Level Architecture document (high-level-architecture.md) " +
        "from exeris-docs. Canonical narrative of the three-tier model.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => readDocsFileResult(config, HLA_FILENAME, HLA_FILENAME),
  };
}

// ---------------------------------------------------------------------------
// docs:get_whitepaper

function getWhitepaperTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:get_whitepaper",
      description:
        "Fetch the B2B technical whitepaper (b2b-technical-whitepaper.md) " +
        "from exeris-docs.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => readDocsFileResult(config, WHITEPAPER_FILENAME, WHITEPAPER_FILENAME),
  };
}

// ---------------------------------------------------------------------------
// docs:search

interface SearchHit {
  /** Path relative to docsRoot. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** Matched line, truncated to SEARCH_MAX_SNIPPET_LEN characters. */
  snippet: string;
}

function searchTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:search",
      description:
        "Search exeris-docs for a literal substring (case-insensitive). " +
        "Returns the path, line number, and snippet of each match, capped " +
        "by maxResults. Optional pathFilter narrows to files whose " +
        "docs-root-relative path contains the substring (e.g. 'adr/' to " +
        "scope to ADR files). Scope is the docs root only; cross-repo " +
        "content is reachable via get_adr.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Literal substring to search for (case-insensitive). Required, " +
              "must be non-empty after trim.",
          },
          pathFilter: {
            type: "string",
            description:
              "Optional substring; only files whose relative path contains " +
              "this string are scanned.",
          },
          maxResults: {
            type: "integer",
            description: `Maximum hits to return (default ${SEARCH_MAX_RESULTS_DEFAULT}, hard cap ${SEARCH_MAX_RESULTS_CAP}).`,
            minimum: 1,
            maximum: SEARCH_MAX_RESULTS_CAP,
          },
        },
        required: ["query"],
      },
    },
    handler: async (args) => {
      const queryRaw = typeof args.query === "string" ? args.query : "";
      const query = queryRaw.trim();
      if (query.length === 0) {
        return errorResult("Invalid input: 'query' must be a non-empty string");
      }
      const queryLower = query.toLowerCase();

      const pathFilter =
        typeof args.pathFilter === "string" ? args.pathFilter.trim() : "";

      let maxResults: number = SEARCH_MAX_RESULTS_DEFAULT;
      if (typeof args.maxResults === "number" && Number.isInteger(args.maxResults)) {
        maxResults = Math.max(1, Math.min(args.maxResults, SEARCH_MAX_RESULTS_CAP));
      }

      // Explicit docsRoot readability check — walkMarkdownFiles silently
      // swallows readdirSync errors per-directory; without this, a missing
      // or unreadable docsRoot would surface as `hitCount=0` indistinguishable
      // from "no matches".
      if (!isRealDirectory(config.docsRoot)) {
        return errorResult(
          "Failed to scan docs root: not a readable directory (check EXERIS_DOCS_ROOT)",
        );
      }

      const files = walkDocsRoot(config);

      const hits: SearchHit[] = [];
      let totalBytes = 0;
      let truncated = false;
      let skippedOversize = false;

      for (const absPath of files) {
        if (hits.length >= maxResults) break;
        if (totalBytes >= SEARCH_MAX_TOTAL_BYTES) {
          truncated = true;
          break;
        }

        const rel = relative(config.docsRoot, absPath);
        if (pathFilter.length > 0 && !rel.includes(pathFilter)) continue;

        // Defence-in-depth: re-route through sandbox before reading.
        // Sandbox is docsRoot (not ecosystemRoot) — search is scoped to the
        // docs tree per the tool description; a symlink under docsRoot
        // pointing to a sibling repo would silently broaden the surface.
        let resolved: string;
        try {
          resolved = resolveInside(config.docsRoot, absPath);
        } catch {
          continue;
        }

        // statSync BEFORE readFileSync — the per-file size cap must protect
        // memory, not just filter post-hoc. A multi-GB .md (legit growth
        // or planted) would OOM the Node process if read first.
        let size: number;
        try {
          size = statSync(resolved).size;
        } catch {
          continue;
        }
        if (size > SEARCH_MAX_BYTES_PER_FILE) {
          // Track oversize-skips so `truncated` honestly reflects "some
          // content was not scanned"; a clean `truncated:false` payload
          // promised "all matches returned" and would be a false negative.
          skippedOversize = true;
          continue;
        }

        let body: string;
        try {
          body = readFileSync(resolved, "utf8");
        } catch {
          continue;
        }
        totalBytes += body.length;

        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (hits.length >= maxResults) break;
          const line = lines[i];
          if (line.toLowerCase().includes(queryLower)) {
            hits.push({
              path: rel,
              line: i + 1,
              snippet:
                line.length > SEARCH_MAX_SNIPPET_LEN
                  ? line.slice(0, SEARCH_MAX_SNIPPET_LEN) + "…"
                  : line,
            });
          }
        }
      }

      return ok(
        JSON.stringify(
          {
            query,
            pathFilter: pathFilter.length > 0 ? pathFilter : null,
            maxResults,
            hitCount: hits.length,
            truncated: truncated || skippedOversize || hits.length >= maxResults,
            hits,
          },
          null,
          2,
        ),
      );
    },
  };
}

/**
 * Walk docsRoot recursively, returning absolute paths of `*.md` files.
 * Thin wrapper over walkMarkdownFiles bound to docsRoot.
 */
function walkDocsRoot(config: BridgeConfig): string[] {
  return walkMarkdownFiles(config.docsRoot, SEARCH_MAX_FILES_VISITED);
}

// ---------------------------------------------------------------------------
// docs:list_repos

function listReposTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:list_repos",
      description:
        "List sibling Exeris repos under the ecosystem root that publish a " +
        "`docs/` directory. Returned names are usable as `repo` input to " +
        "`docs:list_repo_docs` and `docs:get_repo_doc`.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      const repos = discoverReposWithDocs(config);
      return ok(JSON.stringify({ count: repos.length, repos }, null, 2));
    },
  };
}

// ---------------------------------------------------------------------------
// docs:list_repo_docs

function listRepoDocsTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:list_repo_docs",
      description:
        "List markdown documents under `<repo>/docs/**` for an Exeris " +
        "sibling repo. The `adr/` subdirectory is excluded — those are " +
        "the registry's territory and reachable via `docs:list_adrs` / " +
        "`docs:get_adr`. Use `docs:list_repos` to discover valid repo names.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Repo name (e.g. 'exeris-kernel'). Must match /^exeris-[a-z0-9][a-z0-9-]*$/.",
          },
        },
        required: ["repo"],
      },
    },
    handler: async (args) => {
      const repoOrErr = validateRepoName(args.repo);
      if (typeof repoOrErr !== "string") return repoOrErr;
      const repo = repoOrErr;
      if (repo === REPO_NAME_DOCS_SELF) {
        return errorResult(
          `'${REPO_NAME_DOCS_SELF}' is covered by the registry-tier tools, not the per-repo surface. ` +
            `Use docs:list_adrs / docs:get_hla / docs:search etc. instead.`,
        );
      }

      // Conservative symlink posture (matches discoverReposWithDocs):
      // a symlinked repo dir or symlinked docs/ would silently re-attribute
      // another location's files under the queried repo name. Reject up-front
      // rather than walk the resolved realpath.
      const repoDirAbs = join(config.ecosystemRoot, repo);
      if (!isRealDirectory(repoDirAbs) || isSymlink(repoDirAbs)) {
        return errorResult(`Repo '${repo}' is not present as a real directory in the ecosystem checkout.`);
      }
      const repoDocsAbs = join(repoDirAbs, REPO_DOCS_DIRNAME);
      if (!isRealDirectory(repoDocsAbs) || isSymlink(repoDocsAbs)) {
        return errorResult(`Repo '${repo}' has no real docs/ directory (missing or symlinked).`);
      }

      let resolved: string;
      try {
        resolved = resolveInside(config.ecosystemRoot, repoDocsAbs);
      } catch (err) {
        if (err instanceof SandboxEscapeError) {
          process.stderr.write(formatSandboxStderrLine(err));
          return errorResult(
            `Repo '${repo}' has no docs/ directory or is not present in the ecosystem checkout.`,
          );
        }
        throw err;
      }

      const docs = walkMarkdownFiles(resolved, SEARCH_MAX_FILES_VISITED)
        .map((abs) => relative(resolved, abs))
        // Exclude exactly the `adr/` subtree — its entries are registry
        // content flowing through docs:get_adr. ADR-adjacent dirs
        // (adr-drafts/, adr-extras/, adr-archive/) and `adr.md` (meta-doc
        // about ADRs, not a record) remain visible.
        .filter((rel) => rel !== REPO_DOCS_ADR_SUBDIR && !rel.startsWith(REPO_DOCS_ADR_SUBDIR + sep))
        .sort((a, b) => a.localeCompare(b))
        .map((path) => ({ path }));

      return ok(JSON.stringify({ repo, count: docs.length, docs }, null, 2));
    },
  };
}

// ---------------------------------------------------------------------------
// docs:get_repo_doc

function getRepoDocTool(config: BridgeConfig): RegisteredTool {
  return {
    definition: {
      name: "docs:get_repo_doc",
      description:
        "Fetch a specific markdown document from `<repo>/docs/<path>`. " +
        "Use `docs:list_repo_docs` to discover valid paths.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Repo name (e.g. 'exeris-kernel'). Must match /^exeris-[a-z0-9][a-z0-9-]*$/.",
          },
          path: {
            type: "string",
            description: "Path relative to `<repo>/docs/`, e.g. 'subsystems/bootstrap.md'.",
          },
        },
        required: ["repo", "path"],
      },
    },
    handler: async (args) => {
      const repoOrErr = validateRepoName(args.repo);
      if (typeof repoOrErr !== "string") return repoOrErr;
      const repo = repoOrErr;
      if (repo === REPO_NAME_DOCS_SELF) {
        return errorResult(
          `'${REPO_NAME_DOCS_SELF}' is covered by the registry-tier tools ` +
            `(docs:list_adrs, docs:get_adr, docs:get_hla, docs:get_whitepaper, docs:get_template). ` +
            `Use those instead of docs:get_repo_doc.`,
        );
      }

      if (typeof args.path !== "string" || args.path.trim().length === 0) {
        return errorResult("Invalid input: 'path' must be a non-empty string");
      }
      const trimmedPath = args.path.trim();

      // Fast-path ADR redirect: covers the common case (literal `adr/`-prefixed
      // input) so an agent typing a non-existent ADR path still gets the
      // helpful "use docs:get_adr" hint instead of "not found". The
      // post-resolution guard below is the load-bearing security check —
      // it catches normalised (./adr/...), traversal (foo/../adr/...),
      // case-insensitive (ADR/... on macOS/Windows FS), and backslash
      // (adr\... on Windows after join normalisation) bypasses.
      const lowerLiteral = trimmedPath.toLowerCase();
      if (
        lowerLiteral === REPO_DOCS_ADR_SUBDIR ||
        lowerLiteral.startsWith(REPO_DOCS_ADR_SUBDIR + "/") ||
        lowerLiteral.startsWith(REPO_DOCS_ADR_SUBDIR + sep)
      ) {
        return errorResult(
          `'${trimmedPath}' is an ADR path; use docs:get_adr with the ADR number instead.`,
        );
      }

      // Step 1: sandbox repoDocsRoot inside ecosystemRoot. After this the
      // per-path sandbox uses repoDocsRoot — NOT ecosystemRoot — so `..` in
      // `path` cannot reach cross-repo content (which would defeat the
      // tool's documented scope and bypass docs:get_adr's registry flow).
      const repoDocsAbs = join(config.ecosystemRoot, repo, REPO_DOCS_DIRNAME);
      let repoDocsRoot: string;
      try {
        repoDocsRoot = resolveInside(config.ecosystemRoot, repoDocsAbs);
      } catch (err) {
        if (err instanceof SandboxEscapeError) {
          process.stderr.write(formatSandboxStderrLine(err));
          return errorResult(
            `Repo '${repo}' has no docs/ directory or is not present in the ecosystem checkout.`,
          );
        }
        throw err;
      }

      // Step 2: sandbox the user-supplied path INSIDE repoDocsRoot.
      const joined = join(repoDocsRoot, trimmedPath);
      let resolved: string;
      try {
        resolved = resolveInside(repoDocsRoot, joined);
      } catch (err) {
        if (err instanceof SandboxEscapeError) {
          process.stderr.write(formatSandboxStderrLine(err));
          return errorResult(
            err.resolved === null
              ? `'${trimmedPath}' was not found under ${repo}/${REPO_DOCS_DIRNAME}/`
              : `'${trimmedPath}' resolves outside of ${repo}/${REPO_DOCS_DIRNAME}/ (sandbox escape).`,
          );
        }
        throw err;
      }

      // ADR-guard runs AFTER resolution so it catches:
      //   ./adr/X.md, foo/../adr/X.md  → normalise to adr/X.md → caught
      //   ADR/x.md on case-insensitive FS → realpath lands at adr/x.md → caught
      //   adr\X.md on Windows           → join normalises → caught
      // The check is on the lowercased relative-from-repoDocsRoot path with
      // platform-aware separator. `adr.md` (a meta-doc about ADRs, NOT an
      // ADR record) is NOT excluded — it's not in the registry.
      const relFromRepoDocs = relative(repoDocsRoot, resolved);
      const lowerRel = relFromRepoDocs.toLowerCase();
      if (lowerRel === REPO_DOCS_ADR_SUBDIR || lowerRel.startsWith(REPO_DOCS_ADR_SUBDIR + sep)) {
        return errorResult(
          `'${relFromRepoDocs}' is an ADR path; use docs:get_adr with the ADR number instead.`,
        );
      }

      try {
        return ok(readFileSync(resolved, "utf8"));
      } catch (err) {
        const reason = redactEcosystemPaths(
          err instanceof Error ? err.message : String(err),
          config,
        );
        return errorResult(
          `Failed to read ${repo}/${REPO_DOCS_DIRNAME}/${trimmedPath}: ${reason}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared internals

function readAdrIndex(config: BridgeConfig): AdrEntry[] {
  const indexPath = resolveInside(config.ecosystemRoot, join(config.docsRoot, ADR_INDEX_FILENAME));
  const raw = readFileSync(indexPath, "utf8");
  return parseAdrIndex(raw);
}

/**
 * Walk a directory recursively, returning absolute paths of `*.md` files
 * under it. Skips hidden dirs and `node_modules`. Bounded by maxFiles to
 * keep worst-case work O(constant).
 */
function walkMarkdownFiles(rootAbs: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack: string[] = [rootAbs];
  while (stack.length > 0 && out.length < maxFiles) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Walk ecosystemRoot one level deep and return repo names that match the
 * exeris-* convention AND have a `docs/` subdirectory. Excludes:
 *   - `exeris-docs` itself (covered by registry-tier tools)
 *   - symlinked repo directories (silently re-attribute another location's
 *     files under the queried name; reject conservatively in v0.2.0; if
 *     operators need symlinked checkouts, that's a later design)
 *   - symlinked `docs/` subdirectories (same reasoning)
 * Deterministic order.
 */
function discoverReposWithDocs(config: BridgeConfig): string[] {
  let entries;
  try {
    entries = readdirSync(config.ecosystemRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const entry of entries) {
    // Use lstat (entry.isDirectory() is lstat-based per Node docs) — a
    // symlink to a directory reports isDirectory() === false here, so
    // symlinked repo dirs are skipped by the existing check.
    if (!entry.isDirectory()) continue;
    if (!REPO_NAME_RE.test(entry.name)) continue;
    if (entry.name === REPO_NAME_DOCS_SELF) continue;

    const docsDir = join(config.ecosystemRoot, entry.name, REPO_DOCS_DIRNAME);
    if (!isRealDirectory(docsDir) || isSymlink(docsDir)) continue;
    repos.push(entry.name);
  }
  return repos.sort((a, b) => a.localeCompare(b));
}

function isRealDirectory(absPath: string): boolean {
  try {
    return lstatSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Validate an agent-supplied repo name against the exeris-* convention.
 * Returns the validated string on success, or an errorResult to short-circuit
 * the handler. Rejecting non-matching names also blocks path traversal
 * attempts via the repo segment (e.g. repo="../etc").
 */
function validateRepoName(value: unknown):
  | string
  | ReturnType<typeof errorResult> {
  if (typeof value !== "string" || !REPO_NAME_RE.test(value)) {
    return errorResult(
      `Invalid input: 'repo' must match /^exeris-[a-z0-9][a-z0-9-]*$/, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Sandbox-check + read a docs-root-relative file path and return either the
 * body wrapped in a docs:* `ok()` result, or an `errorResult` with a redacted
 * message. The `displayName` is used in user-facing strings (and identifies
 * the resource in the SandboxEscape branch).
 */
function readDocsFileResult(
  config: BridgeConfig,
  relativePath: string,
  displayName: string,
) {
  return readSandboxedFile(config, config.docsRoot, relativePath, displayName);
}

/**
 * Generalised sandbox-check + read. `anchorRoot` is the trusted base path
 * the `relativePath` is joined under; both end up sandbox-checked against
 * `config.ecosystemRoot` before any read. Used by docs:* tools that read
 * either from docsRoot (templates, hla, whitepaper) or from a sibling
 * repo's docs/ tree (get_repo_doc).
 */
function readSandboxedFile(
  config: BridgeConfig,
  anchorRoot: string,
  relativePath: string,
  displayName: string,
) {
  const joined = join(anchorRoot, relativePath);
  let resolved: string;
  try {
    resolved = resolveInside(config.ecosystemRoot, joined);
  } catch (err) {
    if (err instanceof SandboxEscapeError) {
      process.stderr.write(formatSandboxStderrLine(err));
      return errorResult(
        err.resolved === null
          ? `Failed to read ${displayName}: file not found at the expected path`
          : `Failed to read ${displayName}: resolved path is outside the ecosystem sandbox`,
      );
    }
    throw err;
  }
  try {
    return ok(readFileSync(resolved, "utf8"));
  } catch (err) {
    const reason = redactEcosystemPaths(
      err instanceof Error ? err.message : String(err),
      config,
    );
    return errorResult(
      `Failed to read ${displayName} at ${relativizeToEcosystem(config, resolved)}: ${reason}`,
    );
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

/**
 * Render an absolute path relative to ecosystemRoot for user-facing messages.
 * Avoids leaking operator $HOME / install layout. Note: a `..`-prefixed
 * result still reveals the climb depth (e.g. `../../something`) — that's
 * structural information about how deep ecosystemRoot sits in the operator's
 * filesystem. Accepted trade-off: post-sandbox paths shouldn't reach this
 * function with `..` prefixes, so the depth-leak is a degraded-state hint
 * for an unexpected code path, not the primary surface.
 */
function relativizeToEcosystem(config: BridgeConfig, absPath: string): string {
  const rel = relative(config.ecosystemRoot, absPath);
  if (rel === "") return ".";
  return rel;
}

/**
 * Strip the ecosystemRoot absolute prefix from a free-form message and
 * substitute `<ecosystem>`. Anchored on a trailing path separator so a
 * non-boundary prefix doesn't over-replace — e.g. ecosystemRoot=/home/u/dev
 * must not substitute inside /home/u/development/foo.
 *
 * SCOPE: this helper only redacts ecosystem-rooted paths. Errors that embed
 * absolute paths from OUTSIDE the ecosystem (currently unreachable in this
 * codebase — every read goes through resolveInside) are not stripped.
 * Defence-in-depth (regex-redact any `/path/to/file.md`) is deliberately
 * not added here; it would have false positives and a wider blast radius.
 */
export function redactEcosystemPaths(message: string, config: BridgeConfig): string {
  const anchor = config.ecosystemRoot + sep;
  return message.split(anchor).join("<ecosystem>" + sep);
}

/**
 * Format the operator-debug stderr line carrying SandboxEscape structured
 * fields. JSON-serialized so control characters in agent-reachable fields
 * (decoded `%0A` newline, `%1B` ESC, `%07` BEL from a poisoned registry
 * link target) can't forge log lines or inject ANSI escapes. The output
 * is a single-line JSON object suitable for log scrapers.
 */
export function formatSandboxStderrLine(err: SandboxEscapeError): string {
  return (
    JSON.stringify({
      level: "error",
      component: "exeris-ai-bridge",
      event: "SandboxEscape",
      root: err.root,
      candidate: err.candidate,
      resolved: err.resolved,
    }) + "\n"
  );
}

/**
 * Compose a user-facing message for an index/registry-read failure without
 * leaking absolute paths. `resourceName` is the file/resource identifier
 * shown to the agent. Wire-facing message stays sanitized.
 *
 * Side effect: writes a JSON-serialised stderr line carrying the absolute
 * paths for operator debugging. Placeholder for 0.7.0 observability.
 */
function describeReadError(err: unknown, config: BridgeConfig, resourceName: string): string {
  if (err instanceof SandboxEscapeError) {
    process.stderr.write(formatSandboxStderrLine(err));
    return err.resolved === null
      ? `Failed to read ${resourceName}: file not found in the configured docs root`
      : `Failed to read ${resourceName}: resolved path is outside the ecosystem sandbox`;
  }
  const raw = err instanceof Error ? err.message : String(err);
  return `Failed to read ${resourceName}: ${redactEcosystemPaths(raw, config)}`;
}

function missingAdrContentMessage(entry: AdrEntry, config: BridgeConfig, joined: string): string {
  const hint =
    entry.visibility === "enterprise-private"
      ? "This is an enterprise-private ADR; its content may not be available in this checkout."
      : "Check that the cross-repo sibling is present alongside exeris-docs.";
  return (
    `ADR-${entry.numberPadded} ("${entry.title}") link target ` +
    `${relativizeToEcosystem(config, joined)} could not be resolved on disk. ${hint}`
  );
}
