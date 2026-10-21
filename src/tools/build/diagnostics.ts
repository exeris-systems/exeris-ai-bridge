// Matching a pasted diagnostic against the catalogue.
//
// The rows live in `diagnostics-catalogue.ts` and this file is the behaviour
// that reads them. They are separated because they are different kinds of
// thing with different reasons to change: a row changes when an upstream
// diagnostic is added or reworded, and this file changes when the way a paste
// is matched changes. Keeping them apart also means a static analyser looking
// at logic here is not looking at dozens of near-identical prose rows there.
//
// HOW A PASTE IS READ — identifiers first, text only where there is none.
//
//   1. Every well-formed `EXT-<AREA>-<NNNN>` identifier claims its diagnostic:
//      the line it is on, plus the indented continuation lines under it, which
//      is where a capability-graph or Wall failure lists its problems. The
//      identifier decides the entry. Where several entries share one
//      identifier, anchors inside the claimed text choose between them, and
//      with none hitting, the first entry carrying the identifier answers (the
//      catalogue puts the umbrella entry first).
//   2. Text anchors then read only what no identifier claimed. A line with an
//      identifier is that diagnostic, so an anchor that happens to occur inside
//      it — an optional @Requires prints the same sentence an unsatisfied one
//      does — cannot add a second, wrong explanation. Identifier-less text is
//      what exeris-tooling before 0.9.0 prints, and anchors are kept for it.
//
// Detection uses ADR-095's general shape, not a list of known areas. An
// identifier from an area or a release this catalogue does not know is still
// seen, claims its text like any other, and comes back as unrecognised: the
// caller learns the catalogue has a gap at a named identifier, instead of
// getting a text match that may name a different diagnostic, or a bare "not
// recognised" that hides the identifier it was handed.

import {
  DIAGNOSTICS,
  extIdsOf,
  type DiagnosticEntry,
  type DiagnosticSeverity,
  type DiagnosticSource,
} from "./diagnostics-catalogue.js";

export {
  DIAGNOSTICS,
  extIdsOf,
  type DiagnosticEntry,
  type DiagnosticSeverity,
  type DiagnosticSource,
} from "./diagnostics-catalogue.js";

export interface DiagnosticMatch {
  readonly id: string;
  /** The identifier the paste carried for this match; null for a text match. */
  readonly extId: string | null;
  /** Every identifier the entry explains, whichever one the paste carried. */
  readonly extIds: readonly string[];
  /** How the match was made: by an EXT- identifier, or by a text anchor. */
  readonly matchedBy: "identifier" | "text";
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly reference: string | null;
  /**
   * The exact text this entry matched on — the evidence for the match. The
   * identifier itself, or the anchor that chose between entries sharing it, or
   * the anchor of a text match.
   */
  readonly matchedOn: string;
}

export interface DiagnosticScan {
  readonly matches: DiagnosticMatch[];
  /** Well-formed identifiers in the paste with no catalogue entry, in printed order. */
  readonly unrecognisedIds: string[];
}

/** `DiagnosticId.PREFIX`, ahead of the identifier on every diagnostic exeris-tooling prints. */
export const PROCESSOR_PREFIX = "[Exeris] ";

/** A paste beyond this is a build log, not a diagnostic; scanning it all is waste. */
export const MAX_DIAGNOSTIC_CHARS = 64_000;

/**
 * An ADR-095 identifier: `EXT`, an upper-case area token, four digits.
 *
 * Upstream's own pattern also requires the `[Exeris] ` prefix and the `: `
 * after the identifier. This one accepts the bare identifier, because a person
 * asking what an identifier means may paste only that. `EXT` cannot collide
 * with the kernel's `EX-` codes: those have a hyphen where this has `T`.
 */
export const EXT_ID_PATTERN = /\bEXT-[A-Z]+-\d{4}\b/;
const EXT_ID_GLOBAL = new RegExp(EXT_ID_PATTERN.source, "g");

/** A Maven log level tag, which Maven puts ahead of every line of a goal failure. */
const LOG_LEVEL_TAG = /^\[(?:ERROR|WARNING|WARN|INFO|DEBUG)\] ?/;

/**
 * Find every catalogue entry the pasted text matches.
 *
 * All matches are returned, deduplicated by entry: a pasted build log genuinely
 * carries several diagnostics, and picking one would drop the rest. Order is by
 * position in the text, so the answer reads in the order the build printed.
 */
export function matchDiagnostics(text: string): DiagnosticMatch[] {
  return scanDiagnostics(text).matches;
}

/** As {@link matchDiagnostics}, also naming the identifiers the catalogue has no entry for. */
export function scanDiagnostics(text: string): DiagnosticScan {
  const found: { at: number; match: DiagnosticMatch }[] = [];
  const matched = new Set<string>();
  const unrecognised: string[] = [];
  const claimed: { start: number; end: number }[] = [];

  const add = (entry: DiagnosticEntry, at: number, match: DiagnosticMatch): void => {
    if (matched.has(entry.id)) return;
    matched.add(entry.id);
    found.push({ at, match });
  };

  // Step 1: identifiers.
  let m: RegExpExecArray | null;
  EXT_ID_GLOBAL.lastIndex = 0;
  while ((m = EXT_ID_GLOBAL.exec(text)) !== null) {
    const code = m[0];
    const at = m.index;
    const span = claimedSpan(text, at);
    claimed.push(span);

    const candidates = DIAGNOSTICS.filter((e) => extIdsOf(e).includes(code));
    if (candidates.length === 0) {
      if (!unrecognised.includes(code)) unrecognised.push(code);
      continue;
    }
    if (candidates.length === 1) {
      add(candidates[0], at, toMatch(candidates[0], code, "identifier", code));
      continue;
    }

    // Several entries share the identifier: the claimed text chooses.
    const region = text.slice(span.start, span.end);
    let chosen = 0;
    for (const entry of candidates) {
      const hit = firstAnchorHit(region, entry.anchors);
      if (hit === null) continue;
      chosen++;
      add(entry, span.start + hit.at, toMatch(entry, code, "identifier", hit.text));
    }
    if (chosen === 0) {
      add(candidates[0], at, toMatch(candidates[0], code, "identifier", code));
    }
  }

  // Step 2: text anchors, over what no identifier claimed. Claimed text is
  // blanked rather than cut out, so positions still order the answer.
  const unclaimed = blank(text, claimed);
  for (const entry of DIAGNOSTICS) {
    if (matched.has(entry.id)) continue;
    const hit = firstAnchorHit(unclaimed, entry.anchors);
    if (hit === null) continue;
    add(entry, hit.at, toMatch(entry, null, "text", hit.text));
  }

  found.sort((a, b) => a.at - b.at || a.match.id.localeCompare(b.match.id));
  return { matches: found.map((f) => f.match), unrecognisedIds: unrecognised };
}

function toMatch(
  entry: DiagnosticEntry,
  extId: string | null,
  matchedBy: DiagnosticMatch["matchedBy"],
  matchedOn: string,
): DiagnosticMatch {
  return {
    id: entry.id,
    extId,
    extIds: extIdsOf(entry),
    matchedBy,
    severity: entry.severity,
    source: entry.source,
    title: entry.title,
    what: entry.what,
    why: entry.why,
    fix: entry.fix,
    reference: entry.reference ?? null,
    matchedOn,
  };
}

/**
 * The text one identifier speaks for: its whole line, then each following line
 * that continues it — indented once any Maven level tag is set aside — up to a
 * line that carries an identifier of its own.
 */
function claimedSpan(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", at) + 1;
  let end = lineEnd(text, at);
  while (end < text.length) {
    const next = text.slice(end + 1, lineEnd(text, end + 1));
    const body = next.replace(LOG_LEVEL_TAG, "");
    if (!/^[ \t]+\S/.test(body) || EXT_ID_PATTERN.test(next)) break;
    end = lineEnd(text, end + 1);
  }
  return { start, end };
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

function blank(text: string, spans: readonly { start: number; end: number }[]): string {
  if (spans.length === 0) return text;
  const chars = text.split("");
  for (const { start, end } of spans) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
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
    EXT_ID_PATTERN.test(text) ||
    /\bexeris:(generate|detach|verify-capabilities|verify-runtime)\b/.test(text)
  );
}
