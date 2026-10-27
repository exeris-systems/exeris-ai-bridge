import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppStarter, AppStarterState } from "../../data/app-starter.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";

// build-get_starter — the build files for a NEW application, on the opt-in
// starter ADR-091 publishes. Nothing here reads a project or an ecosystem
// checkout and nothing is written: the answer is text the agent writes with its
// own tools, from the version triple the bridge vendored at pack time.
//
// What is returned is only what the starter modules make a consumer write. The
// generators emit no build file, so there is no second source for these shapes
// to drift from; and nothing is added that the starter already carries.

const VARIANTS = ["backend", "frontend", "both"] as const;
type Variant = (typeof VARIANTS)[number];

/** The npm package and the command it installs; the version is the tooling's. */
const CODEGEN_TS = "@exeris/codegen-ts";
const CODEGEN_COMMAND = "exeris-gen";

/** Stand-ins the agent replaces; named in the answer so none is mistaken for a default. */
const GROUP_ID = "com.example";
const ARTIFACT_ID = "my-app";

/** Where the frontend reads metadata when the backend is built beside it. */
const METADATA_DIR = "target/classes/exeris-metadata";

interface Supplied {
  readonly name: string;
  readonly for: Variant[];
  readonly scope?: string;
  readonly reason: string;
}

const SUPPLIED: readonly Supplied[] = [
  {
    name: "A JDBC driver",
    for: ["backend", "both"],
    scope: "runtime",
    reason:
      "exeris-app-starter declares no JDBC driver; the database is the application's choice. Add the driver dependency to the pom.xml, at the version you choose.",
  },
  {
    name: "JUnit 5 (junit-jupiter) and AssertJ (assertj-core)",
    for: ["backend", "both"],
    scope: "test",
    reason:
      "The starter carries no test library. Needed only if you set exeris.tests=true in the pom.xml properties, which emits tests for the generated code; they import JUnit 5 and AssertJ and nothing else.",
  },
  {
    name: "A logging backend",
    for: ["backend", "both"],
    reason:
      "Generated code logs through System.Logger and binds no logging facade; which backend routes it, if any, is the application's choice.",
  },
  {
    name: "The @ExerisDomain sources",
    for: ["backend", "both"],
    reason:
      "The generators emit everything else, but the annotated entities are yours: the build has nothing to generate until at least one exists.",
  },
  {
    name: "Node.js and an npm install",
    for: ["frontend", "both"],
    reason: `Run npm install, then npm run generate, to get ${CODEGEN_COMMAND} and the Angular application it writes under app/.`,
  },
  {
    name: "The backend's DomainMetadata",
    for: ["frontend"],
    reason: `${CODEGEN_COMMAND} reads DomainMetadata JSON, never Java sources. The generate script points at ../backend/${METADATA_DIR}; with no backend beside the frontend, point --input at the metadata of the backend's published contract (ADR-048), not at hand-written JSON.`,
  },
];

export function getStarterTool(starter: AppStarterState): RegisteredTool {
  return {
    definition: {
      name: "build-get_starter",
      description:
        "Return the build files for a NEW Exeris application and write none: for 'backend', a pom.xml whose parent is exeris-app-parent and which depends on exeris-app-starter; for 'frontend', a package.json with @exeris/codegen-ts and its exeris-gen generate script; for 'both', the two under backend/ and frontend/. Ask this BEFORE hand-writing a pom.xml or package.json for an Exeris application: the starter already wires the annotation processor, the codegen goals and the dependency set. Every version comes from the exeris-app-bom the bridge was released with, which names one tested tooling + kernel + SDK triple; the tool reports it as bomVersion and triple. `supplied` lists what the application still adds itself, starting with the JDBC driver. Needs no project: it reads bundled data only, and you write the files with your own tools.",
      inputSchema: {
        type: "object",
        properties: {
          variant: {
            type: "string",
            enum: [...VARIANTS],
            description:
              "Which application to start: 'backend' (Maven), 'frontend' (npm), or 'both' (a backend and a frontend that generates from the backend's build).",
          },
        },
        required: ["variant"],
      },
    },
    handler: guard("build", starter, async ({ starter: data, sourceArtifact }, args) => {
      const variant = args.variant;
      if (typeof variant !== "string" || !VARIANTS.includes(variant as Variant)) {
        return errorResult(`'variant' is required and must be one of: ${VARIANTS.join(", ")}.`);
      }
      const chosen = variant as Variant;
      const wantsBackend = chosen !== "frontend";
      const wantsFrontend = chosen !== "backend";
      const backendPath = chosen === "both" ? "backend/pom.xml" : "pom.xml";
      const frontendPath = chosen === "both" ? "frontend/package.json" : "package.json";

      const files = [
        ...(wantsBackend ? [{ path: backendPath, content: pomXml(data) }] : []),
        ...(wantsFrontend ? [{ path: frontendPath, content: packageJson(data) }] : []),
      ];

      return jsonResult({
        variant: chosen,
        bomVersion: data.bomVersion,
        triple: data.triple,
        sourceArtifact,
        files,
        supplied: SUPPLIED.filter((s) => s.for.includes(chosen)).map(({ for: _for, ...rest }) => rest),
        placeholders: {
          ...(wantsBackend ? { groupId: GROUP_ID, artifactId: ARTIFACT_ID } : {}),
          ...(wantsFrontend ? { npmName: `${ARTIFACT_ID}-frontend` } : {}),
          note: "Replace these stand-ins with the application's own names before writing the files.",
        },
      });
    }),
  };
}

/**
 * The consumer's POM. The tooling version appears once, in `<parent>`: the BOM
 * also manages exeris-app-starter, so the dependency carries no version. The
 * empty publication elements stop the application inheriting Exeris's own
 * `url`, `licenses`, `developers` and `scm`.
 */
function pomXml(data: AppStarter): string {
  const { parent, starter } = data.coordinates;
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <!-- exeris-app-parent runs the annotation processor, binds exeris:generate,
         exeris:verify-capabilities and exeris:verify-runtime, and puts the generated migrations and
         OpenAPI document on the classpath. It manages the starter's version. -->
    <parent>
        <groupId>${parent.groupId}</groupId>
        <artifactId>${parent.artifactId}</artifactId>
        <version>${parent.version}</version>
        <relativePath/>
    </parent>

    <groupId>${GROUP_ID}</groupId>
    <artifactId>${ARTIFACT_ID}</artifactId>
    <version>0.1.0-SNAPSHOT</version>
    <description>Replace with this application's description.</description>

    <!-- The parent carries Exeris's own publication metadata, and an element left out here is
         inherited. State yours in place of these empty ones. -->
    <url/>
    <licenses>
        <license/>
    </licenses>
    <developers>
        <developer/>
    </developers>
    <scm>
        <connection/>
        <developerConnection/>
        <tag/>
        <url/>
    </scm>

    <dependencies>
        <!-- Everything the generated code compiles and runs against: the SDK annotations, kernel
             SPI and Core, the community driver, the composition runtime and Jackson 3. -->
        <dependency>
            <groupId>${starter.groupId}</groupId>
            <artifactId>${starter.artifactId}</artifactId>
            <type>pom</type>
        </dependency>

        <!-- The application's database. The starter declares no JDBC driver: add yours here,
             with runtime scope. -->
    </dependencies>
</project>
`;
}

/**
 * The frontend's package.json. `@exeris/codegen-ts` is versioned with the
 * tooling release, so it takes the triple's tooling version.
 */
function packageJson(data: AppStarter): string {
  const manifest = {
    name: `${ARTIFACT_ID}-frontend`,
    version: "0.0.0",
    private: true,
    description: "Runs the Exeris TypeScript generator on the backend build's metadata; the Angular application it writes is under app/.",
    scripts: {
      generate: `${CODEGEN_COMMAND} generate --input ../backend/${METADATA_DIR} --output app --app-name ${ARTIFACT_ID}`,
    },
    devDependencies: { [CODEGEN_TS]: data.triple.tooling },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
