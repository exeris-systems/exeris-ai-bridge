import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local Maven repository probing — the rung of the launch ladder that makes the
// application-developer (P2) persona work.
//
// A P2 has no ecosystem checkout, but they DO have `~/.m2`: building an app from
// `@ExerisDomain` annotations needs `exeris-tooling`, and compiling and testing
// against the runtime needs the kernel, so `eu.exeris:*` artifacts land in the
// local repository as a matter of course. The bridge can therefore find a
// runnable child there without a checkout and without touching the network.
//
// Everything here is deliberately generic — a coordinate in, a path out. The
// sdk:* / build:* / caps: families resolve their own artifacts the same way, so
// this must not grow kernel-specific knowledge.
//
// STRICTLY OFFLINE. Nothing in this file fetches; it reads directory names and
// one settings file. A boot path that could block on the network would make
// every MCP client's startup hostage to a Maven repository being reachable.

/** A Maven coordinate, as it appears in the local repository layout. */
export interface MavenCoordinate {
  readonly groupId: string;
  readonly artifactId: string;
}

/**
 * Locate the local Maven repository, in Maven's own order of precedence:
 *
 *   1. `EXERIS_MAVEN_REPO` — our override, for a caller who knows better
 *   2. `<localRepository>` in `~/.m2/settings.xml`
 *   3. `~/.m2/repository` — Maven's default
 *
 * (There is no `MAVEN_REPO_LOCAL` environment variable to honour; the
 * Maven-native form is the `-Dmaven.repo.local` command-line property, which is
 * not visible to us.)
 *
 * Returns null when nothing resolves to an existing directory — the caller
 * treats that as "this rung of the ladder does not fire".
 */
export function resolveLocalRepository(env: NodeJS.ProcessEnv): string | null {
  const override = env.EXERIS_MAVEN_REPO?.trim();
  if (override !== undefined && override.length > 0) {
    return isDirectory(override) ? override : null;
  }
  const home = env.HOME?.trim() || homedir();
  const configured = localRepositoryFromSettings(join(home, ".m2", "settings.xml"), home);
  if (configured !== null && isDirectory(configured)) return configured;
  const fallback = join(home, ".m2", "repository");
  return isDirectory(fallback) ? fallback : null;
}

/**
 * Read `<localRepository>` out of a settings.xml.
 *
 * XML comments are stripped FIRST, and that is not a nicety: Maven's own
 * shipped settings.xml documents this element inside a comment block that
 * contains a complete `<localRepository>/path/to/local/repo</localRepository>`
 * line. Matching without stripping would send every default installation to a
 * path that does not exist.
 *
 * `${user.home}` is expanded because it is overwhelmingly the form people
 * write — against the same `home` the settings file was found under, so an
 * injected HOME governs the whole resolution rather than half of it. Any other
 * `${...}` property is left alone; the path then fails the directory check and
 * the caller falls through, which is the right outcome for an interpolation we
 * cannot resolve.
 */
function localRepositoryFromSettings(settingsPath: string, home: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return null; // no settings.xml is the common case, not an error
  }
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "");
  const match = /<localRepository>([^<]*)<\/localRepository>/.exec(withoutComments);
  if (match === null) return null;
  const value = match[1].trim();
  if (value.length === 0) return null;
  return value.includes("${user.home}") ? value.split("${user.home}").join(home) : value;
}

/**
 * The newest RELEASE version present for a coordinate in the local repository.
 *
 * "Release" means a bare `MAJOR.MINOR.PATCH` and nothing else. A real local
 * repository accumulates `0.11.0-SNAPSHOT`, `0.11.0-preview-SNAPSHOT`,
 * `0.6.0-RESEARCH-LOCALITY` and even `UNSPECIFIED-PIN-VIA-Dexeris.kernel.version`
 * next to the releases; launching a child from any of those would be picking up
 * somebody's experiment. Ordering is numeric per segment, so 0.10.2 correctly
 * outranks 0.9.0 — which lexicographic sorting would get backwards.
 */
export function newestReleaseVersion(repo: string, coord: MavenCoordinate): string | null {
  let entries: string[];
  try {
    entries = readdirSync(artifactDir(repo, coord));
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestParts: number[] = [];
  for (const entry of entries) {
    const parts = parseReleaseVersion(entry);
    if (parts === null) continue;
    if (best === null || compareVersions(parts, bestParts) > 0) {
      best = entry;
      bestParts = parts;
    }
  }
  return best;
}

/**
 * Absolute path to `<repo>/<group>/<artifact>/<version>/<artifact>-<version>.jar`,
 * or null when that file is not present.
 *
 * Note this proves the file exists, not that it is runnable: whether the jar
 * carries a `Main-Class` is a property of how upstream builds it. Callers pick
 * coordinates they know are packaged as executable artifacts.
 */
export function findArtifactJar(
  repo: string,
  coord: MavenCoordinate,
  version: string,
): string | null {
  const jar = join(artifactDir(repo, coord), version, `${coord.artifactId}-${version}.jar`);
  try {
    return statSync(jar).isFile() ? jar : null;
  } catch {
    return null;
  }
}

function artifactDir(repo: string, coord: MavenCoordinate): string {
  return join(repo, ...coord.groupId.split("."), coord.artifactId);
}

/** Parse a bare MAJOR.MINOR.PATCH into segments; null for anything else. */
function parseReleaseVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
