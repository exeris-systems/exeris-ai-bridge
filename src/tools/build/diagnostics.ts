// Matching a pasted diagnostic against the catalogue.
//
// The rows live in `diagnostics-catalogue.ts` and this file is the behaviour
// that reads them. They are separated because they are different kinds of
// thing with different reasons to change: a row changes when an upstream
// message changes, and this file changes when the way a paste is matched
// changes. Keeping them apart also means a static analyser looking at logic
// here is not looking at seventeen near-identical prose rows there.

import {
  DIAGNOSTICS,
  type DiagnosticSeverity,
  type DiagnosticSource,
} from "./diagnostics-catalogue.js";

export {
  DIAGNOSTICS,
  type DiagnosticEntry,
  type DiagnosticSeverity,
  type DiagnosticSource,
} from "./diagnostics-catalogue.js";

export interface DiagnosticMatch {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly reference: string | null;
  /** The exact text this entry matched on — the evidence for the match. */
  readonly matchedOn: string;
}

/** `ExerisDomainProcessor.DIAG_PREFIX`, on every diagnostic the processor emits. */
export const PROCESSOR_PREFIX = "[Exeris] ";

/** A paste beyond this is a build log, not a diagnostic; scanning it all is waste. */
export const MAX_DIAGNOSTIC_CHARS = 64_000;

/**
 * Find every catalogue entry the pasted text matches.
 *
 * All matches are returned, deduplicated by id: a pasted build log genuinely
 * carries several diagnostics, and picking one would drop the rest. Order is
 * by position in the text, so the answer reads in the order the build printed.
 */
export function matchDiagnostics(text: string): DiagnosticMatch[] {
  const found: { at: number; match: DiagnosticMatch }[] = [];
  for (const entry of DIAGNOSTICS) {
    const hit = firstAnchorHit(text, entry.anchors);
    if (hit === null) continue;
    found.push({
      at: hit.at,
      match: {
        id: entry.id,
        severity: entry.severity,
        source: entry.source,
        title: entry.title,
        what: entry.what,
        why: entry.why,
        fix: entry.fix,
        reference: entry.reference ?? null,
        matchedOn: hit.text,
      },
    });
  }
  found.sort((a, b) => a.at - b.at || a.match.id.localeCompare(b.match.id));
  return found.map((f) => f.match);
}

function firstAnchorHit(
  text: string,
  anchors: readonly (string | RegExp)[],
): { at: number; text: string } | null {
  let best: { at: number; text: string } | null = null;
  for (const anchor of anchors) {
    if (typeof anchor === "string") {
      const at = text.indexOf(anchor);
      if (at !== -1 && (best === null || at < best.at)) best = { at, text: anchor };
    } else {
      const m = anchor.exec(text);
      if (m && (best === null || m.index < best.at)) best = { at: m.index, text: m[0] };
    }
  }
  return best;
}

/**
 * Does this text look like it came from an Exeris build at all?
 *
 * Used only to decide which kind of "no catalogue entry" answer to give. It is
 * never used to tell a caller their problem is not an Exeris problem — this
 * server cannot know that, and the honest failure is "not in the catalogue".
 */
export function looksLikeExerisOutput(text: string): boolean {
  return (
    text.includes(PROCESSOR_PREFIX) ||
    text.includes("eu.exeris") ||
    text.includes("@ExerisDomain") ||
    /\bexeris:(generate|detach|verify-capabilities|verify-runtime)\b/.test(text)
  );
}
