import { readFileSync, statSync } from "node:fs";

import { resolveInside } from "../fs/sandbox.js";

// Minimal, offline pom.xml reading shared by the families that need a project's
// pinned versions (sdk:*, build:*). Regex-based by design: it reads a handful of
// well-known elements and never evaluates Maven.

const MAX_POM_BYTES = 2 * 1024 * 1024; // 2 MB size cap

/** exeris-tooling 0.9.0 published the app BOM chain under eu.exeris.tooling; 0.10.0 moved it to eu.exeris. */
export const APP_GROUP_IDS: readonly string[] = ["eu.exeris", "eu.exeris.tooling"];
export interface Coordinate {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
}

export interface PomModel {
  readonly properties: Map<string, string>;
  readonly parent?: Coordinate;
  readonly body: string;
}

export function stripComments(content: string): string {
  // Fixed-point loop to satisfy CodeQL multi-character sanitization check
  let stripped = content;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, "");
  } while (stripped !== prev);
  return stripped;
}

export function tagValue(block: string, tag: string): string | null {
  const m = new RegExp(String.raw`<${tag}>\s*([^<\s]+)\s*</${tag}>`, "i").exec(block);
  return m ? m[1].trim() : null;
}

const NESTED_BLOCKS = ["dependencies", "configuration", "executions"] as const;

/**
 * A block with its nested `<dependencies>`, `<configuration>` and `<executions>` elements
 * removed, so that `tagValue` on the result sees only the block's own direct children. Bounded:
 * each pass removes innermost-first matches and the passes are capped.
 */
export function withoutNestedBlocks(block: string): string {
  let result = block;
  for (let pass = 0; pass < 16; pass += 1) {
    const before = result;
    for (const tag of NESTED_BLOCKS) {
      result = result.replace(new RegExp(String.raw`<${tag}(?:\s[^>]*)?>[\s\S]*?</${tag}>`, "gi"), "");
    }
    if (result === before) break;
  }
  return result;
}

export function parsePom(content: string): PomModel {
  const stripped = stripComments(content);
  const properties = new Map<string, string>();
  const propsMatch = /<properties>([\s\S]*?)<\/properties>/i.exec(stripped);
  if (propsMatch) {
    const tagRegex = /<([a-zA-Z0-9_.-]+)>([^<]+)<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(propsMatch[1])) !== null) {
      properties.set(match[1].trim(), match[2].trim());
    }
  }
  let parent: Coordinate | undefined;
  const parentMatch = /<parent>([\s\S]*?)<\/parent>/i.exec(stripped);
  if (parentMatch) {
    const groupId = tagValue(parentMatch[1], "groupId");
    const artifactId = tagValue(parentMatch[1], "artifactId");
    const version = tagValue(parentMatch[1], "version");
    if (groupId && artifactId && version) {
      parent = { groupId, artifactId, version };
    }
  }
  return { properties, parent, body: stripped };
}

/** Resolves a literal, or a chain of `${prop}` references, within one pom's own properties. */
export function resolveValue(
  val: string,
  properties: Map<string, string>,
  visited: Set<string> = new Set(),
): string | null {
  if (visited.size > 15) {
    return null;
  }
  const trimmed = val.trim();
  const propMatch = /^\$\{([^}]+)\}$/.exec(trimmed);
  if (propMatch) {
    const key = propMatch[1].trim();
    if (visited.has(key) || !properties.has(key)) {
      return null;
    }
    visited.add(key);
    return resolveValue(properties.get(key)!, properties, visited);
  }
  if (trimmed.includes("${")) {
    return null; // partial interpolation is not attempted
  }
  return trimmed.length > 0 ? trimmed : null;
}

export function readBounded(root: string, path: string): string | null {
  try {
    const safe = resolveInside(root, path);
    const stats = statSync(safe);
    if (!stats.isFile() || stats.size > MAX_POM_BYTES) {
      return null;
    }
    return readFileSync(safe, "utf8");
  } catch {
    return null;
  }
}

