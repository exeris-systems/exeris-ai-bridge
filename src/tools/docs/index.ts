import { lstatSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

import type { BridgeConfig, DocsConfig, DocsRoots, Unavailable } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import {
  formatSandboxStderrLine,
  readAdrContent,
  readAdrEntries,
  readHla,
  readTemplate,
  readWhitepaper,
  redactEcosystemPaths,
  TEMPLATE_KINDS,
  type DocsContent,
  type TemplateKind,
} from "./content.js";

export { formatSandboxStderrLine, redactEcosystemPaths };

// docs:* — surfaces the exeris-docs ADR registry, canonical narratives,
// decision-doc templates, and a bounded literal-substring search to AI
// agents over MCP. Filesystem reads route through the path-sandbox
// (ecosystemRoot) so cross-repo ADR links work without granting the agent
// access to anything else on disk. Search is scoped to `docsRoot` only
// (not the wider ecosystem) — cross-repo content is reachable via get_adr.

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

// Per ADR-025 §What is NOT in scope (line 66): "This first cut is fully
// public. An enterprise-private extension ... ships as a separate
// exeris-ai-bridge-enterprise repo per the ADR-020 / ADR-018 split
// pattern, NOT as a private overlay in this public repo."
//
// The base REPO_NAME_RE happily admits sibling repos whose name embeds
// the "enterprise" segment (exeris-kernel-enterprise, exeris-benchmarks-
// enterprise, exeris-enterprise-observability) and the private decision
// registry (exeris-business). Without explicit denial, this bridge would
// serve their docs/ contents — a founding-ADR violation.
//
// The pattern matches the literal "enterprise" word as a hyphen-segment
// (suffix OR interior) so both `*-enterprise` and `enterprise-*` shapes
// are caught. `exeris-business` is denied by exact name.
const REPO_NAME_ENTERPRISE_RE = /(^|-)enterprise(-|$)/;
const REPO_NAME_BUSINESS = "exeris-business";

// docs:search safety caps. The docs tree is small (dozens of files); these
// are headroom rather than tight bounds, but they make the worst case
// bounded regardless of what an agent supplies.
const SEARCH_MAX_RESULTS_DEFAULT = 50;
const SEARCH_MAX_RESULTS_CAP = 200;
const SEARCH_MAX_FILES_VISITED = 1000;
const SEARCH_MAX_BYTES_PER_FILE = 10_000_000;
const SEARCH_MAX_TOTAL_BYTES = 50_000_000;
const SEARCH_MAX_SNIPPET_LEN = 200;

/**
 * The docs:* family handle: the resolved roots, or the structured reason the
 * family is dark. Every tool definition below is built either way — only the
 * handlers are gated (see ../unavailable.ts).
 */
type DocsFamily = DocsConfig | Unavailable;

export function registerDocsTools(config: BridgeConfig): RegisteredTool[] {
  const docs = config.docs;
  const repoDocs = checkoutOnly(docs);
  return [
    listAdrsTool(docs),
    getAdrTool(docs),
    getTemplateTool(docs),
    getHlaTool(docs),
    getWhitepaperTool(docs),
    searchTool(docs),
    listReposTool(repoDocs),
    listRepoDocsTool(repoDocs),
    getRepoDocTool(repoDocs),
  ];
}

/**
 * The per-repository tools browse sibling `docs/` trees. The bundled snapshot
 * carries the registry tier only, so over a snapshot they are dark with their
 * own reason rather than answering from a partial tree as if it were whole.
 */
function checkoutOnly(handle: DocsFamily): DocsFamily {
  if (handle.state === "unavailable" || handle.source === "checkout") return handle;
  return {
    state: "unavailable",
    reason:
      "The docs-* tools are answering from the documentation snapshot bundled in the package, which carries the ADR registry, the records it links, the HLA, the whitepaper and the templates — not each repository's documentation tree.",
    remedy:
      "Set EXERIS_DOCS_ROOT to an exeris-docs checkout with its sibling repositories beside it to browse per-repository documentation.",
  };
}

// ---------------------------------------------------------------------------
// docs:list_adrs

function listAdrsTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-list_adrs",
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
    handler: guard("docs", handle, async (config, args) => {
      const status =
        typeof args.status === "string" ? args.status.trim().toLowerCase() : "";
      const index = readAdrEntries(config);
      if (!index.ok) return errorResult(index.message);
      const entries = index.entries;
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
    }),
  };
}

// ---------------------------------------------------------------------------
// docs:get_adr

function getAdrTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-get_adr",
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
    handler: guard("docs", handle, async (config, args) => {
      if (typeof args.number !== "number" || !Number.isInteger(args.number)) {
        return errorResult(
          `Invalid input: 'number' must be an integer, got ${typeof args.number}`,
        );
      }
      const number = args.number;
      if (number < 1) {
        return errorResult(`Invalid input: 'number' must be ≥ 1, got ${number}`);
      }

      return render(readAdrContent(config, number));
    }),
  };
}

// ---------------------------------------------------------------------------
// docs:get_template

function getTemplateTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-get_template",
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
    handler: guard("docs", handle, async (config, args) => {
      if (typeof args.kind !== "string" || !TEMPLATE_KINDS.includes(args.kind as TemplateKind)) {
        return errorResult(
          `Invalid input: 'kind' must be one of ${TEMPLATE_KINDS.join(", ")}, got ${JSON.stringify(args.kind)}`,
        );
      }
      const kind = args.kind as TemplateKind;
      return render(readTemplate(config, kind));
    }),
  };
}

// ---------------------------------------------------------------------------
// docs:get_hla

function getHlaTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-get_hla",
      description:
        "Fetch the High-Level Architecture document (high-level-architecture.md) " +
        "from exeris-docs. Canonical narrative of the three-tier model.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("docs", handle, async (config) => render(readHla(config))),
  };
}

// ---------------------------------------------------------------------------
// docs:get_whitepaper

function getWhitepaperTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-get_whitepaper",
      description:
        "Fetch the B2B technical whitepaper (b2b-technical-whitepaper.md) " +
        "from exeris-docs.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("docs", handle, async (config) => render(readWhitepaper(config))),
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

function searchTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-search",
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
    handler: guard("docs", handle, async (config, args) => {
      const parsed = parseSearchArgs(args);
      if ("error" in parsed) return parsed.error;

      // Explicit docsRoot readability check — walkMarkdownFiles silently
      // swallows readdirSync errors per-directory; without this, a missing
      // or unreadable docsRoot would surface as `hitCount=0` indistinguishable
      // from "no matches".
      if (!isRealDirectory(config.docsRoot)) {
        return errorResult(
          "Failed to scan docs root: not a readable directory (check EXERIS_DOCS_ROOT)",
        );
      }

      const state: SearchScanState = { hits: [], totalBytes: 0, skippedOversize: false };
      let truncated = false;
      for (const absPath of walkDocsRoot(config)) {
        if (state.hits.length >= parsed.maxResults) break;
        if (state.totalBytes >= SEARCH_MAX_TOTAL_BYTES) {
          truncated = true;
          break;
        }
        const rel = relative(config.docsRoot, absPath);
        if (parsed.pathFilter.length > 0 && !rel.includes(parsed.pathFilter)) continue;
        scanSearchCandidate(config, absPath, rel, parsed, state);
      }

      return ok(
        JSON.stringify(
          {
            query: parsed.query,
            pathFilter: parsed.pathFilter.length > 0 ? parsed.pathFilter : null,
            maxResults: parsed.maxResults,
            hitCount: state.hits.length,
            truncated: truncated || state.skippedOversize || state.hits.length >= parsed.maxResults,
            hits: state.hits,
          },
          null,
          2,
        ),
      );
    }),
  };
}

interface SearchParams {
  query: string;
  queryLower: string;
  pathFilter: string;
  maxResults: number;
}

interface SearchScanState {
  hits: SearchHit[];
  totalBytes: number;
  skippedOversize: boolean;
}

function parseSearchArgs(
  args: Record<string, unknown>,
): SearchParams | { error: ReturnType<typeof errorResult> } {
  const queryRaw = typeof args.query === "string" ? args.query : "";
  const query = queryRaw.trim();
  if (query.length === 0) {
    return { error: errorResult("Invalid input: 'query' must be a non-empty string") };
  }
  const pathFilter = typeof args.pathFilter === "string" ? args.pathFilter.trim() : "";
  let maxResults: number = SEARCH_MAX_RESULTS_DEFAULT;
  if (typeof args.maxResults === "number" && Number.isInteger(args.maxResults)) {
    maxResults = Math.max(1, Math.min(args.maxResults, SEARCH_MAX_RESULTS_CAP));
  }
  return { query, queryLower: query.toLowerCase(), pathFilter, maxResults };
}

/**
 * Resolve, size-check, and scan one candidate file, pushing matches into
 * `state.hits` up to `params.maxResults`. Sandbox check is on docsRoot
 * (not ecosystemRoot) — search is scoped to the docs tree per the tool
 * description; a symlink under docsRoot pointing to a sibling repo would
 * silently broaden the surface. statSync runs BEFORE readFileSync so a
 * multi-GB .md (legit growth or planted) cannot OOM the Node process.
 */
function scanSearchCandidate(
  config: DocsRoots,
  absPath: string,
  rel: string,
  params: SearchParams,
  state: SearchScanState,
): void {
  let resolved: string;
  try {
    resolved = resolveInside(config.docsRoot, absPath);
  } catch {
    return;
  }
  let size: number;
  try {
    size = statSync(resolved).size;
  } catch {
    return;
  }
  if (size > SEARCH_MAX_BYTES_PER_FILE) {
    // Track oversize-skips so `truncated` honestly reflects "some content
    // was not scanned"; a clean `truncated:false` payload would otherwise
    // promise "all matches returned" and be a false negative.
    state.skippedOversize = true;
    return;
  }
  let body: string;
  try {
    body = readFileSync(resolved, "utf8");
  } catch {
    return;
  }
  state.totalBytes += body.length;
  appendMatchingLines(body, rel, params, state);
}

function appendMatchingLines(
  body: string,
  rel: string,
  params: SearchParams,
  state: SearchScanState,
): void {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (state.hits.length >= params.maxResults) break;
    const line = lines[i];
    if (line.toLowerCase().includes(params.queryLower)) {
      state.hits.push({
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

/**
 * Walk docsRoot recursively, returning absolute paths of `*.md` files.
 * Thin wrapper over walkMarkdownFiles bound to docsRoot.
 */
function walkDocsRoot(config: DocsRoots): string[] {
  return walkMarkdownFiles(config.docsRoot, SEARCH_MAX_FILES_VISITED);
}

// ---------------------------------------------------------------------------
// docs:list_repos

function listReposTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-list_repos",
      description:
        "List sibling Exeris repos under the ecosystem root that publish a " +
        "`docs/` directory. Returned names are usable as `repo` input to " +
        "`docs-list_repo_docs` and `docs-get_repo_doc`.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("docs", handle, async (config) => {
      const repos = discoverReposWithDocs(config);
      return ok(JSON.stringify({ count: repos.length, repos }, null, 2));
    }),
  };
}

// ---------------------------------------------------------------------------
// docs:list_repo_docs

function listRepoDocsTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-list_repo_docs",
      description:
        "List markdown documents under `<repo>/docs/**` for an Exeris " +
        "sibling repo. The `adr/` subdirectory is excluded — those are " +
        "the registry's territory and reachable via `docs-list_adrs` / " +
        "`docs-get_adr`. Use `docs-list_repos` to discover valid repo names.",
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
    handler: guard("docs", handle, async (config, args) => {
      const repoOrErr = validateRepoName(args.repo);
      if (typeof repoOrErr !== "string") return repoOrErr;
      const repo = repoOrErr;
      const restrictedErr = rejectRestrictedRepo(repo, "list_repo_docs");
      if (restrictedErr) return restrictedErr;

      const rootRes = resolveRepoDocsRoot(config, repo);
      if (rootRes.kind === "err") return rootRes.error;
      const root = rootRes.root;

      const docs = walkMarkdownFiles(root, SEARCH_MAX_FILES_VISITED)
        .map((abs) => relative(root, abs))
        // Exclude exactly the `adr/` subtree — its entries are registry
        // content flowing through docs:get_adr. ADR-adjacent dirs
        // (adr-drafts/, adr-extras/, adr-archive/) and `adr.md` (meta-doc
        // about ADRs, not a record) remain visible.
        .filter((rel) => rel !== REPO_DOCS_ADR_SUBDIR && !rel.startsWith(REPO_DOCS_ADR_SUBDIR + sep))
        .sort((a, b) => a.localeCompare(b))
        .map((path) => ({ path }));

      return ok(JSON.stringify({ repo, count: docs.length, docs }, null, 2));
    }),
  };
}

// ---------------------------------------------------------------------------
// docs:get_repo_doc

function getRepoDocTool(handle: DocsFamily): RegisteredTool {
  return {
    definition: {
      name: "docs-get_repo_doc",
      description:
        "Fetch a specific markdown document from `<repo>/docs/<path>`. " +
        "Use `docs-list_repo_docs` to discover valid paths.",
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
    handler: guard("docs", handle, async (config, args) => {
      const repoOrErr = validateRepoName(args.repo);
      if (typeof repoOrErr !== "string") return repoOrErr;
      const repo = repoOrErr;
      const restrictedErr = rejectRestrictedRepo(repo, "get_repo_doc");
      if (restrictedErr) return restrictedErr;

      if (typeof args.path !== "string" || args.path.trim().length === 0) {
        return errorResult("Invalid input: 'path' must be a non-empty string");
      }
      const trimmedPath = args.path.trim();
      const fastAdr = adrFastPathError(trimmedPath);
      if (fastAdr) return fastAdr;

      const rootRes = resolveRepoDocsRoot(config, repo);
      if (rootRes.kind === "err") return rootRes.error;
      const repoDocsRoot = rootRes.root;

      // Sandbox the user-supplied path INSIDE repoDocsRoot — NOT
      // ecosystemRoot — so `..` in `path` cannot reach cross-repo content.
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

      const adrGuardErr = adrPostResolveGuard(repoDocsRoot, resolved);
      if (adrGuardErr) return adrGuardErr;

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
    }),
  };
}

type RepoDocsRootResult =
  | { kind: "ok"; root: string }
  | { kind: "err"; error: ReturnType<typeof errorResult> };

/**
 * Validate that `<ecosystemRoot>/<repo>/docs` exists as a real directory
 * (not a symlink at either level) and sandbox-resolve it inside the
 * ecosystem. Shared by `docs-list_repo_docs` and `docs-get_repo_doc` so
 * discovery and fetch agree on what counts as a real repo — preventing
 * the agent from getting symlinked content under a misattributed name.
 */
function resolveRepoDocsRoot(config: DocsRoots, repo: string): RepoDocsRootResult {
  const repoDirAbs = join(config.ecosystemRoot, repo);
  if (!isRealDirectory(repoDirAbs) || isSymlink(repoDirAbs)) {
    return {
      kind: "err",
      error: errorResult(`Repo '${repo}' is not present as a real directory in the ecosystem checkout.`),
    };
  }
  const repoDocsAbs = join(repoDirAbs, REPO_DOCS_DIRNAME);
  if (!isRealDirectory(repoDocsAbs) || isSymlink(repoDocsAbs)) {
    return {
      kind: "err",
      error: errorResult(`Repo '${repo}' has no real docs/ directory (missing or symlinked).`),
    };
  }
  try {
    return { kind: "ok", root: resolveInside(config.ecosystemRoot, repoDocsAbs) };
  } catch (err) {
    if (err instanceof SandboxEscapeError) {
      process.stderr.write(formatSandboxStderrLine(err));
      return {
        kind: "err",
        error: errorResult(
          `Repo '${repo}' has no docs/ directory or is not present in the ecosystem checkout.`,
        ),
      };
    }
    throw err;
  }
}

type RepoRestriction = "docs-self" | "enterprise" | "business";

/**
 * True when `repo` names an ecosystem repository whose documentation the
 * public surface may serve. The registry snapshot applies it at build time,
 * so the snapshot admits no repository the per-repo tools would refuse.
 */
export function isServableRepo(repo: string): boolean {
  return REPO_NAME_RE.test(repo) && !REPO_NAME_ENTERPRISE_RE.test(repo) && repo !== REPO_NAME_BUSINESS;
}

/**
 * Classify a repo name against the bridge's public-scope policy.
 * Returns the restriction kind if the repo MUST NOT be exposed via the
 * per-repo docs surface, or null if it's allowed.
 *
 * Per ADR-025 §What is NOT in scope: bridge is fully public; enterprise
 * tier and the private decision registry must not leak through here.
 */
function classifyRestrictedRepo(repo: string): RepoRestriction | null {
  if (repo === REPO_NAME_DOCS_SELF) return "docs-self";
  if (REPO_NAME_ENTERPRISE_RE.test(repo)) return "enterprise";
  if (repo === REPO_NAME_BUSINESS) return "business";
  return null;
}

function rejectRestrictedRepo(repo: string, toolSuffix: string): ReturnType<typeof errorResult> | null {
  const kind = classifyRestrictedRepo(repo);
  if (kind === null) return null;
  switch (kind) {
    case "docs-self":
      return errorResult(
        `'${REPO_NAME_DOCS_SELF}' is covered by the registry-tier tools ` +
          `(docs-list_adrs, docs-get_adr, docs-get_hla, docs-get_whitepaper, docs-get_template). ` +
          `Use those instead of docs-${toolSuffix}.`,
      );
    case "enterprise":
      return errorResult(
        `'${repo}' is an enterprise-tier sibling repo. exeris-ai-bridge is fully public per ADR-025; ` +
          `enterprise docs will ship via a separate exeris-ai-bridge-enterprise repo when needed.`,
      );
    case "business":
      return errorResult(
        `'${repo}' is the private decision registry and is not exposed by this bridge.`,
      );
  }
}

/**
 * Fast-path ADR redirect on raw input — covers the common case (literal
 * `adr/`-prefixed input) so an agent typing a non-existent ADR path gets
 * the helpful hint instead of "not found". The post-resolution guard is
 * the load-bearing security check; this is UX.
 */
function adrFastPathError(trimmedPath: string): ReturnType<typeof errorResult> | null {
  const lower = trimmedPath.toLowerCase();
  if (
    lower === REPO_DOCS_ADR_SUBDIR ||
    lower.startsWith(REPO_DOCS_ADR_SUBDIR + "/") ||
    lower.startsWith(REPO_DOCS_ADR_SUBDIR + sep)
  ) {
    return errorResult(
      `'${trimmedPath}' is an ADR path; use docs-get_adr with the ADR number instead.`,
    );
  }
  return null;
}

/**
 * Post-resolution ADR guard. Catches normalised (./adr/...), traversal
 * (foo/../adr/...), case-insensitive (ADR/... on macOS/Windows FS), and
 * backslash (adr\... on Windows) bypasses of the fast-path. `adr.md`
 * (a meta-doc about ADRs, NOT an ADR record) is NOT excluded.
 */
function adrPostResolveGuard(repoDocsRoot: string, resolved: string): ReturnType<typeof errorResult> | null {
  const relFromRepoDocs = relative(repoDocsRoot, resolved);
  const lowerRel = relFromRepoDocs.toLowerCase();
  if (lowerRel === REPO_DOCS_ADR_SUBDIR || lowerRel.startsWith(REPO_DOCS_ADR_SUBDIR + sep)) {
    return errorResult(
      `'${relFromRepoDocs}' is an ADR path; use docs-get_adr with the ADR number instead.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared internals

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
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    collectWalkEntries(current, entries, out, stack, maxFiles);
  }
  return out;
}

function collectWalkEntries(
  current: string,
  entries: Dirent[],
  out: string[],
  stack: string[],
  maxFiles: number,
): void {
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

/**
 * Walk ecosystemRoot one level deep and return repo names that match the
 * exeris-* convention AND have a `docs/` subdirectory. Excludes:
 *   - `exeris-docs` itself (covered by registry-tier tools)
 *   - enterprise-tier siblings (per ADR-025 §What is NOT in scope —
 *     enterprise surface ships as a separate exeris-ai-bridge-enterprise
 *     repo). Matched by classifyRestrictedRepo: `*-enterprise`,
 *     `enterprise-*`, and the literal `exeris-business` private registry.
 *   - symlinked repo directories (silently re-attribute another location's
 *     files under the queried name; reject conservatively in v0.2.0; if
 *     operators need symlinked checkouts, that's a later design)
 *   - symlinked `docs/` subdirectories (same reasoning)
 * Deterministic order. Silent exclusion is the intent — agents should
 * never learn the existence of restricted siblings via discovery.
 */
function discoverReposWithDocs(config: DocsRoots): string[] {
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
    if (classifyRestrictedRepo(entry.name) !== null) continue;

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

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Render shared registry content as a tool result: the body, or the failure as an error. */
function render(content: DocsContent) {
  return content.ok ? ok(content.text) : errorResult(content.message);
}
