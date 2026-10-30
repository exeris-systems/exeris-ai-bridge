import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ProjectConfig } from "../../config/env.js";
import { resolveInside } from "../../fs/sandbox.js";
import { referenceKey } from "./brief.js";
import { classifyMetadataFile, parseMetadataEnvelope } from "./shapes.js";

// The source elements a project's emitted DomainMetadata declares, as the keys
// a brief's `fulfilledBy` references are looked up by. It reads only
// target/classes/exeris-metadata; the capability manifest is a caps-* source
// and is never consulted.

const METADATA_DIR = "target/classes/exeris-metadata";

/** Most metadata files read for one call. */
export const MAX_SOURCE_FILES = 2_000;

/** Largest single metadata file read, in bytes. */
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;

export type BriefSource =
  | { readonly state: "absent" }
  | { readonly state: "unusable"; readonly reason: string }
  | { readonly state: "present"; readonly elements: ReadonlySet<string> };

/**
 * The entities, and the actions, rules and sagas of each, that the last build
 * emitted. An absent directory is `absent`; one that cannot be read in full is
 * `unusable`, so references are reported unchecked rather than falsely
 * unresolved.
 *
 * @param project - The pinned project.
 */
export function readBriefSource(project: ProjectConfig): BriefSource {
  let dir: string;
  try {
    dir = resolveInside(project.projectRoot, join(project.projectRoot, METADATA_DIR));
  } catch {
    return { state: "absent" };
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { state: "absent" };
  }
  const files = names.filter((n) => classifyMetadataFile(n)?.kind === "domain");
  if (files.length > MAX_SOURCE_FILES) {
    return { state: "unusable", reason: `${METADATA_DIR} holds more than ${MAX_SOURCE_FILES} domain files.` };
  }

  const elements = new Set<string>();
  for (const file of files) {
    try {
      const path = resolveInside(dir, join(dir, file));
      if (statSync(path).size > MAX_SOURCE_FILE_BYTES) {
        return { state: "unusable", reason: `${METADATA_DIR}/${file} is larger than ${MAX_SOURCE_FILE_BYTES} bytes.` };
      }
      const envelope = parseMetadataEnvelope(JSON.parse(readFileSync(path, "utf8")), file);
      addElements(elements, envelope.entityName, envelope.packageName, envelope.metadata);
    } catch {
      return { state: "unusable", reason: `${METADATA_DIR}/${file} could not be read as emitted metadata.` };
    }
  }
  return { state: "present", elements };
}

function addElements(
  into: Set<string>,
  entityName: string,
  packageName: string | null,
  metadata: Record<string, unknown>,
): void {
  const qualified = packageName === null || packageName === "" ? entityName : `${packageName}.${entityName}`;
  into.add(referenceKey({ kind: "entity", ref: qualified }));
  for (const [kind, list] of [
    ["action", metadata.actions],
    ["rule", metadata.rules],
  ] as const) {
    if (!Array.isArray(list)) continue;
    for (const member of list) {
      const name = nameOf(member);
      if (name !== null) into.add(referenceKey({ kind, ref: `${qualified}#${name}` }));
    }
  }
  const saga = nameOf(metadata.sagaMetadata);
  if (saga !== null) into.add(referenceKey({ kind: "saga", ref: `${qualified}#${saga}` }));
}

function nameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}
