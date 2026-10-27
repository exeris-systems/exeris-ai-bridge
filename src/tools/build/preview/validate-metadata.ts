import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isJavaSimpleName } from "../shapes.js";

// The generators turn names in the metadata into file paths. Neither contains
// its writes (see resolve-generator.ts), so a name such as "../../x" would place
// a file outside the output directory. The corpus is therefore checked BEFORE
// any generator is launched: this sanitises the input, it does not predict what
// the generator would do with it.

/** Bounds on the corpus read here; a metadata directory beyond them is refused, not truncated. */
export const MAX_METADATA_FILES = 2_000;
export const MAX_METADATA_FILE_BYTES = 1024 * 1024;
export const MAX_METADATA_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_DEPTH = 8;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 200_000;

export interface MetadataProblem {
  /** Path of the offending file relative to the project root, `/`-separated. */
  readonly file: string;
  readonly reason: string;
}

/** A dotted package name: Java identifiers joined by single dots, or empty (the default package). */
function isPackageName(name: string): boolean {
  return name === "" || name.split(".").every((segment) => isJavaSimpleName(segment));
}

/** A value that may become a path segment: no separator, not `.` or `..`, no control character. */
function isPathSafe(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[/\\\u0000-\u001f\u007f]/u.test(value)) return false;
  return value !== ".." && value !== ".";
}

function isNameKey(key: string): boolean {
  return key === "name" || key === "module" || key.endsWith("Name");
}

function isPackageKey(key: string): boolean {
  return key === "packageName" || key === "package" || key.endsWith("Package");
}

/**
 * Check every `*.json` under `dir` (recursively, as the TypeScript generator reads
 * it): it parses to an object; its top-level `entityName` is a Java simple name and
 * its `packageName` a dotted Java name; and every other string under a name key
 * (`name`, `*Name`, `module`) or package key (`*Package`) is free of path
 * separators, `..` segments and control characters. A symbolic link is refused,
 * since the Java generator would read through it. Returns the first problem.
 *
 * `relativeDir` is `dir` relative to the project root, for the reported paths.
 */
export function validateMetadata(dir: string, relativeDir: string): MetadataProblem | null {
  let files = 0;
  let total = 0;

  const walk = (current: string, relative: string, depth: number): MetadataProblem | null => {
    if (depth > MAX_METADATA_DEPTH) {
      return { file: relative, reason: `The metadata directory nests deeper than ${MAX_METADATA_DEPTH} levels.` };
    }
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const rel = `${relative}/${name}`;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        return { file: rel, reason: "A symbolic link inside the metadata directory is not followed." };
      }
      if (stat.isDirectory()) {
        const nested = walk(absolute, rel, depth + 1);
        if (nested !== null) return nested;
        continue;
      }
      if (!stat.isFile() || !name.endsWith(".json")) continue;

      files += 1;
      total += stat.size;
      if (files > MAX_METADATA_FILES) {
        return { file: rel, reason: `The metadata directory holds more than ${MAX_METADATA_FILES} JSON files.` };
      }
      if (stat.size > MAX_METADATA_FILE_BYTES || total > MAX_METADATA_TOTAL_BYTES) {
        return { file: rel, reason: "The metadata is larger than the preview reads (1 MiB a file, 16 MiB in all)." };
      }
      const problem = checkFile(readFileSync(absolute, "utf8"), rel);
      if (problem !== null) return problem;
    }
    return null;
  };

  return walk(dir, relativeDir, 0);
}

function checkFile(content: string, file: string): MetadataProblem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { file, reason: "The file is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { file, reason: "The file does not contain a JSON object." };
  }
  const top = parsed as Record<string, unknown>;
  if (top.entityName !== undefined) {
    if (typeof top.entityName !== "string" || !isJavaSimpleName(top.entityName)) {
      return { file, reason: `entityName ${show(top.entityName)} is not a Java simple name.` };
    }
  }
  if (top.packageName !== undefined) {
    if (typeof top.packageName !== "string" || !isPackageName(top.packageName)) {
      return { file, reason: `packageName ${show(top.packageName)} is not a dotted Java package name.` };
    }
  }

  let nodes = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      return { file, reason: "The metadata is nested or populated beyond what the preview reads." };
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string") {
          if (isNameKey(key) && !isPathSafe(child)) {
            return { file, reason: `${key} ${show(child)} contains a path separator, a '..' segment or a control character.` };
          }
          if (isPackageKey(key) && !isPackageName(child)) {
            return { file, reason: `${key} ${show(child)} is not a dotted Java package name.` };
          }
        } else {
          stack.push({ value: child, depth: depth + 1 });
        }
      }
    }
  }
  return null;
}

function show(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}
