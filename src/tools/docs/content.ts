import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { DocsRoots } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import { localLinkCandidates, parseAdrIndex, type AdrEntry } from "./adr-index.js";

// The registry-tier content of docs:* — the ADR index, one ADR, the HLA, the
// whitepaper and the decision-doc templates — read once, for every surface that
// serves it. The docs-* tools and the exeris://docs/* resources both call these
// functions, so a checkout, the bundled snapshot, the sandbox, the licence
// policy encoded in the registry links and the path redaction apply to both
// identically. A surface renders a DocsContent; it never re-reads.

export const ADR_INDEX_FILENAME = "adr-index.md";
export const HLA_FILENAME = "high-level-architecture.md";
export const WHITEPAPER_FILENAME = "b2b-technical-whitepaper.md";

export type TemplateKind = "ADR" | "RFC" | "RESEARCH";
export const TEMPLATE_KINDS: TemplateKind[] = ["ADR", "RFC", "RESEARCH"];
const TEMPLATE_FILES: Record<TemplateKind, string> = {
  ADR: "templates/ADR-TEMPLATE.md",
  RFC: "templates/RFC-TEMPLATE.md",
  RESEARCH: "templates/RESEARCH-TEMPLATE.md",
};

/**
 * Why a read produced nothing. `not_found` means the content does not exist or
 * is not served from here; `failed` means it should have been readable and was
 * not. `message` is agent-facing and carries no absolute path.
 */
export interface DocsFailure {
  readonly ok: false;
  readonly kind: "not_found" | "failed";
  readonly message: string;
}

export type DocsContent = { readonly ok: true; readonly text: string } | DocsFailure;

const notFound = (message: string): DocsFailure => ({ ok: false, kind: "not_found", message });
const failed = (message: string): DocsFailure => ({ ok: false, kind: "failed", message });

export function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

/** The parsed registry, or the reason it could not be read. */
export function readAdrEntries(
  config: DocsRoots,
): { readonly ok: true; readonly entries: AdrEntry[] } | DocsFailure {
  try {
    return { ok: true, entries: readAdrIndex(config) };
  } catch (err) {
    return describeReadError(err, config, ADR_INDEX_FILENAME);
  }
}

/** The registry index as the markdown the registry is authored in. */
export function readAdrIndexMarkdown(config: DocsRoots): DocsContent {
  return readSandboxedFile(config, config.docsRoot, ADR_INDEX_FILENAME, ADR_INDEX_FILENAME);
}

export function readTemplate(config: DocsRoots, kind: TemplateKind): DocsContent {
  return readSandboxedFile(config, config.docsRoot, TEMPLATE_FILES[kind], `${kind}-TEMPLATE.md`);
}

export function readHla(config: DocsRoots): DocsContent {
  return readSandboxedFile(config, config.docsRoot, HLA_FILENAME, HLA_FILENAME);
}

export function readWhitepaper(config: DocsRoots): DocsContent {
  return readSandboxedFile(config, config.docsRoot, WHITEPAPER_FILENAME, WHITEPAPER_FILENAME);
}

/**
 * The body of ADR `number`, resolved from the registry link against the
 * ecosystem root so a record held by a sibling repository is read from its
 * authoritative source. A record the snapshot could not vendor (no qualifying
 * licence, or a repository outside the public scope) resolves to nothing on
 * disk and answers with the owning repository and its GitHub URL.
 */
export function readAdrContent(config: DocsRoots, number: number): DocsContent {
  const index = readAdrEntries(config);
  if (!index.ok) return index;
  const entry = index.entries.find((e) => e.number === number);
  if (!entry) {
    return notFound(`ADR-${pad(number)} is not in the registry`);
  }
  if (!entry.link) {
    return notFound(
      `ADR-${entry.numberPadded} ("${entry.title}") has no link in the registry ` +
        `(status: ${entry.status.raw}). The content is not yet authored.`,
    );
  }

  const trimmedTarget = entry.link.target.trim();
  if (trimmedTarget.length === 0) {
    return failed(
      `ADR-${entry.numberPadded} ("${entry.title}") has an empty link target in the registry.`,
    );
  }

  const candidates = localLinkCandidates(trimmedTarget);
  if (candidates === null) {
    return notFound(
      `ADR-${entry.numberPadded} ("${entry.title}") is linked outside the Exeris ` +
        `ecosystem (${trimmedTarget}); the bridge reads registry content from disk only.`,
    );
  }

  // First candidate present on disk wins. Every candidate goes through the
  // sandbox, and one that resolves outside it refuses the whole lookup
  // rather than falling through to the next.
  // Operator-debug stderr parity with the other handlers — a registry read is
  // the most likely legit-escape surface (cross-repo links) so the operator
  // needs the structured fields on both failure branches. A candidate that
  // merely misses before a later one hits is not a failure and is not logged.
  let resolved: string | null = null;
  let firstMiss: SandboxEscapeError | null = null;
  for (const candidate of candidates) {
    const joined = join(config.docsRoot, candidate);
    try {
      resolved = resolveInside(config.ecosystemRoot, joined);
      break;
    } catch (err) {
      if (!(err instanceof SandboxEscapeError)) throw err;
      if (err.resolved !== null) {
        process.stderr.write(formatSandboxStderrLine(err));
        return failed(
          `ADR-${entry.numberPadded} link target escapes the ecosystem sandbox: ` +
            `${entry.link.target}`,
        );
      }
      firstMiss ??= err;
    }
  }
  if (resolved === null) {
    if (firstMiss) process.stderr.write(formatSandboxStderrLine(firstMiss));
    return notFound(missingAdrContentMessage(entry, config, candidates));
  }

  try {
    return { ok: true, text: readFileSync(resolved, "utf8") };
  } catch (err) {
    const reason = redactEcosystemPaths(err instanceof Error ? err.message : String(err), config);
    return failed(
      `ADR-${entry.numberPadded} ("${entry.title}") link resolves to ` +
        `${relativizeToEcosystem(config, resolved)}, ` +
        `but the file could not be read: ${reason}.`,
    );
  }
}

function readAdrIndex(config: DocsRoots): AdrEntry[] {
  const indexPath = resolveInside(config.ecosystemRoot, join(config.docsRoot, ADR_INDEX_FILENAME));
  const raw = readFileSync(indexPath, "utf8");
  return parseAdrIndex(raw);
}

/**
 * Sandbox-check + read. `anchorRoot` is the trusted base path the
 * `relativePath` is joined under; both end up sandbox-checked against
 * `config.ecosystemRoot` before any read. `displayName` is the identifier shown
 * to the agent in failure messages.
 */
export function readSandboxedFile(
  config: DocsRoots,
  anchorRoot: string,
  relativePath: string,
  displayName: string,
): DocsContent {
  const joined = join(anchorRoot, relativePath);
  let resolved: string;
  try {
    resolved = resolveInside(config.ecosystemRoot, joined);
  } catch (err) {
    if (err instanceof SandboxEscapeError) {
      process.stderr.write(formatSandboxStderrLine(err));
      return err.resolved === null
        ? notFound(`Failed to read ${displayName}: file not found at the expected path`)
        : failed(`Failed to read ${displayName}: resolved path is outside the ecosystem sandbox`);
    }
    throw err;
  }
  try {
    return { ok: true, text: readFileSync(resolved, "utf8") };
  } catch (err) {
    const reason = redactEcosystemPaths(err instanceof Error ? err.message : String(err), config);
    return failed(
      `Failed to read ${displayName} at ${relativizeToEcosystem(config, resolved)}: ${reason}`,
    );
  }
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
function relativizeToEcosystem(config: DocsRoots, absPath: string): string {
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
export function redactEcosystemPaths(message: string, config: DocsRoots): string {
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
 * Compose a user-facing failure for an index/registry-read error without
 * leaking absolute paths. `resourceName` is the file/resource identifier
 * shown to the agent.
 *
 * Side effect: writes a JSON-serialised stderr line carrying the absolute
 * paths for operator debugging.
 */
function describeReadError(err: unknown, config: DocsRoots, resourceName: string): DocsFailure {
  if (err instanceof SandboxEscapeError) {
    process.stderr.write(formatSandboxStderrLine(err));
    return err.resolved === null
      ? notFound(`Failed to read ${resourceName}: file not found in the configured docs root`)
      : failed(`Failed to read ${resourceName}: resolved path is outside the ecosystem sandbox`);
  }
  const raw = err instanceof Error ? err.message : String(err);
  return failed(`Failed to read ${resourceName}: ${redactEcosystemPaths(raw, config)}`);
}

function missingAdrContentMessage(entry: AdrEntry, config: DocsRoots, candidates: string[]): string {
  const hint =
    entry.visibility === "enterprise-private"
      ? "This is an enterprise-private ADR; its content may not be available in this checkout."
      : `Check that the cross-repo sibling (${entry.owningRepo}) is present alongside exeris-docs.` +
        (entry.link?.github ? ` Its authoritative copy is ${entry.link.github}.` : "");
  // A GitHub URL is its own clearest statement of the target; the on-disk
  // guesses derived from it would only restate it, less readably.
  const target =
    candidates.length === 1
      ? relativizeToEcosystem(config, join(config.docsRoot, candidates[0]))
      : (entry.link?.target ?? "");
  return (
    `ADR-${entry.numberPadded} ("${entry.title}") link target ` +
    `${target} could not be resolved on disk. ${hint}`
  );
}
