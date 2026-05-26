import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved lazily so import-time failures do not bypass the caller's error path.
// Caller (server entry) invokes this from inside main() so the friendly fatal
// logger in main().catch is the single user-facing error surface.
export function getServerVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");

  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read package.json at ${pkgPath}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`package.json at ${pkgPath} is not valid JSON`, { cause });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof (parsed as { version: unknown }).version !== "string"
  ) {
    throw new Error(`package.json at ${pkgPath} is missing a "version" string`);
  }

  const version = (parsed as { version: string }).version.trim();
  if (version.length === 0) {
    throw new Error(`package.json at ${pkgPath} has a blank "version" field`);
  }

  return version;
}
