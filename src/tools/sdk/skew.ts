import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../../fs/sandbox.js";

export type VersionSkewStatus = "aligned" | "skew_detected" | "unknown";

export interface VersionSkewReport {
  readonly status: VersionSkewStatus;
  readonly bundledSdkVersion: string;
  readonly projectSdkVersion?: string;
  readonly warning?: string;
}

const MAX_POM_BYTES = 2 * 1024 * 1024; // 2 MB size cap

/**
 * Offline, parser-free detection of the Exeris SDK version pinned by a Maven project.
 * Reads pom.xml directly without spawning Maven or linking any Java classpath.
 * Enforces path sandbox containment so symlinks escaping projectRoot are refused.
 */
export function detectProjectSdkVersion(projectRoot?: string): string | null {
  if (!projectRoot || typeof projectRoot !== "string") {
    return null;
  }
  let content: string;
  try {
    const pomPath = resolveInside(projectRoot, join(projectRoot, "pom.xml"));
    const stats = statSync(pomPath);
    if (!stats.isFile() || stats.size > MAX_POM_BYTES) {
      return null;
    }
    content = readFileSync(pomPath, "utf8");
  } catch {
    return null;
  }

  try {
    // Strip XML comments using fixed-point loop to satisfy CodeQL multi-character sanitization check
    let stripped = content;
    let prev: string;
    do {
      prev = stripped;
      stripped = stripped.replace(/<!--[\s\S]*?-->/g, "");
    } while (stripped !== prev);

    // Extract <properties>
    const properties = new Map<string, string>();
    const propsMatch = stripped.match(/<properties>([\s\S]*?)<\/properties>/i);
    if (propsMatch) {
      const propsBody = propsMatch[1];
      const tagRegex = /<([a-zA-Z0-9_.-]+)>([^<]+)<\/\1>/g;
      let match: RegExpExecArray | null;
      while ((match = tagRegex.exec(propsBody)) !== null) {
        properties.set(match[1].trim(), match[2].trim());
      }
    }

    function resolveValue(val: string, visited: Set<string> = new Set()): string | null {
      if (visited.size > 15) {
        return null;
      }
      const trimmed = val.trim();
      const propMatch = trimmed.match(/^\$\{([^}]+)\}$/);
      if (propMatch) {
        const key = propMatch[1].trim();
        if (visited.has(key)) {
          return null;
        }
        if (properties.has(key)) {
          visited.add(key);
          return resolveValue(properties.get(key)!, visited);
        }
        return null;
      }
      return trimmed;
    }

    // Find eu.exeris SDK dependency in <dependencies> or <dependencyManagement>
    const depRegex = /<dependency>([\s\S]*?)<\/dependency>/gi;
    let depMatch: RegExpExecArray | null;
    while ((depMatch = depRegex.exec(stripped)) !== null) {
      const block = depMatch[1];
      const groupMatch = block.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/i);
      const artifactMatch = block.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/i);
      const versionMatch = block.match(/<version>\s*([^<\s]+)\s*<\/version>/i);

      if (groupMatch && groupMatch[1].trim() === "eu.exeris") {
        const artId = artifactMatch ? artifactMatch[1].trim() : "";
        if (artId === "exeris-sdk" || artId.startsWith("exeris-sdk-")) {
          if (versionMatch) {
            const resolved = resolveValue(versionMatch[1]);
            if (resolved && resolved.length > 0) {
              return resolved;
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Computes version skew between the bundled reference catalog and the user's project.
 */
export function computeVersionSkew(
  bundledSdkVersion?: string | null,
  projectRoot?: string,
): VersionSkewReport {
  if (!bundledSdkVersion || bundledSdkVersion === "unknown") {
    return {
      status: "unknown",
      bundledSdkVersion: "unknown",
    };
  }

  const projectSdkVersion = detectProjectSdkVersion(projectRoot);
  if (!projectSdkVersion) {
    return {
      status: "unknown",
      bundledSdkVersion,
    };
  }

  if (projectSdkVersion === bundledSdkVersion) {
    return {
      status: "aligned",
      bundledSdkVersion,
      projectSdkVersion,
    };
  }

  return {
    status: "skew_detected",
    bundledSdkVersion,
    projectSdkVersion,
    warning: `Project pins Exeris SDK version ${projectSdkVersion}, while bundled reference catalog reflects ${bundledSdkVersion}. Annotations, scoping rules, or deprecations may differ between these versions.`,
  };
}
