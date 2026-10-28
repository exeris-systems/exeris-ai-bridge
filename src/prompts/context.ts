import type { PromptMessage } from "@modelcontextprotocol/sdk/types.js";

import type { DocsRoots } from "../config/env.js";
import {
  readAdrContent,
  readAdrIndexMarkdown,
  readDriftPatterns,
  readHla,
  readSandboxedFile,
  readTemplate,
  type DocsContent,
  type TemplateKind,
} from "../tools/docs/content.js";
import { collectDeprecations, loadAstSchema, loadCatalog, resolveSdkHandle } from "../tools/sdk/index.js";
import { findScopingRules } from "../tools/sdk/rules.js";
import type { PromptContext } from "./types.js";

// Context for a prompt. A prompt embeds what it needs by one of two routes
// only: the docs-* shared reads that the exeris://docs/* resources use, or
// bundled SDK data read through the functions the sdk-* tools use. Neither
// spawns a process or touches the network, and every docs read goes through the
// path sandbox, so a prompt cannot read what a resource could not.

const MIME_MARKDOWN = "text/markdown";

export const text = (value: string): PromptMessage => ({
  role: "user",
  content: { type: "text", text: value },
});

/**
 * An embedded resource when `read` produced content, else a text instruction to
 * read the URI. The fallback carries the reason so the agent can tell "not
 * served here" from "docs unavailable".
 */
export function embedded(uri: string, read: DocsContent): PromptMessage {
  if (read.ok) {
    return {
      role: "user",
      content: { type: "resource", resource: { uri, mimeType: MIME_MARKDOWN, text: read.text } },
    };
  }
  return text(
    `Context not pre-loaded: read the MCP resource ${uri} yourself before continuing. ` +
      `The bridge could not embed it: ${read.message}`,
  );
}

function withDocs(ctx: PromptContext, uri: string, read: (docs: DocsRoots) => DocsContent): PromptMessage {
  const docs = ctx.config.docs;
  if (docs.state === "unavailable") {
    return embedded(uri, { ok: false, kind: "failed", message: `${docs.reason} ${docs.remedy}` });
  }
  return embedded(uri, read(docs));
}

export const adrIndexMessage = (ctx: PromptContext): PromptMessage =>
  withDocs(ctx, "exeris://docs/adr-index", readAdrIndexMarkdown);

export const hlaMessage = (ctx: PromptContext): PromptMessage => withDocs(ctx, "exeris://docs/hla", readHla);

/**
 * The drift-patterns policy, embedded only. Its URI is not a listed resource and
 * `resources/read` does not serve it; the prompt is its one reader.
 */
export const driftPatternsMessage = (ctx: PromptContext): PromptMessage => {
  const docs = ctx.config.docs;
  const uri = "exeris://docs/policy/drift-patterns";
  if (docs.state === "unavailable") {
    return driftFallback(uri, `${docs.reason} ${docs.remedy}`);
  }
  const read = readDriftPatterns(docs);
  return read.ok ? embedded(uri, read) : driftFallback(uri, read.message);
};

function driftFallback(uri: string, reason: string): PromptMessage {
  return text(
    `Context not pre-loaded: the drift-patterns policy (${uri}) could not be embedded: ${reason} ` +
      "Read exeris-docs/.agents/policies/drift-patterns.md from an exeris-docs checkout before scanning, " +
      "and if you cannot, say so instead of scanning from memory.",
  );
}

export const adrMessage = (ctx: PromptContext, number: number): PromptMessage =>
  withDocs(ctx, `exeris://docs/adr/${String(number).padStart(3, "0")}`, (d) => readAdrContent(d, number));

export const templateMessage = (ctx: PromptContext, kind: TemplateKind): PromptMessage =>
  withDocs(ctx, `exeris://docs/template/${kind}`, (d) => readTemplate(d, kind));

/**
 * The ecosystem's top-level CLAUDE.md, only from a checkout. A snapshot has no
 * ecosystem of its own, so it cannot carry routing data and the prompt says so
 * rather than inventing a source.
 */
export function ecosystemRoutingMessage(ctx: PromptContext): PromptMessage {
  const docs = ctx.config.docs;
  if (ctx.config.ecosystemRoot === null || docs.state !== "available" || docs.source !== "checkout") {
    return text(
      "Routing data is not available: the top-level routing rules live in the ecosystem's CLAUDE.md, " +
        "which is read only from an ecosystem checkout, and this bridge has none. Remedy: set " +
        "EXERIS_DOCS_ROOT to an exeris-docs checkout that sits beside the other Exeris repositories " +
        "(its parent directory is the ecosystem root), or install the bridge as a sibling of " +
        "exeris-docs, then request this prompt again. Until then, do not guess the owning " +
        "repository; say that routing needs a checkout.",
    );
  }
  const read = readSandboxedFile(docs, docs.ecosystemRoot, "CLAUDE.md", "the ecosystem CLAUDE.md");
  if (!read.ok) {
    return text(
      `Routing data could not be read from the ecosystem checkout: ${read.message}. ` +
        "Do not guess the owning repository.",
    );
  }
  return {
    role: "user",
    content: {
      type: "resource",
      resource: { uri: "exeris://ecosystem/CLAUDE.md", mimeType: MIME_MARKDOWN, text: read.text },
    },
  };
}

type Produced = { readonly value: unknown } | { readonly error: string };

/** Embed bundled SDK data as a JSON text block, or say how to get it. */
function sdkJsonMessage(label: string, tool: string, produce: () => Produced): PromptMessage {
  const result = produce();
  if ("error" in result) {
    return text(
      `Context not pre-loaded: ${label} could not be read from the bundled SDK data (${result.error}). ` +
        `Call ${tool} to read it, and if that is unavailable too, say so instead of answering from memory.`,
    );
  }
  return text(`${label} (bundled SDK data):\n\n${fenced(JSON.stringify(result.value, null, 2), "json")}`);
}

function failureText(errorResult: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const first = errorResult.content[0];
  return first && first.type === "text" && first.text ? first.text : "unreadable";
}

export function scopingRulesMessage(ctx: PromptContext): PromptMessage {
  return sdkJsonMessage("The scoping rules (sdk-get_scoping_rules)", "sdk-get_scoping_rules", () => {
    const handle = resolveSdkHandle(ctx.bundle);
    if (handle.state === "unavailable") return { error: handle.reason };
    const loaded = loadCatalog(handle.bundle, ctx.bundleRoot);
    if ("errorResult" in loaded) return { error: failureText(loaded.errorResult) };
    return { value: { sdkVersion: loaded.catalog.sdkVersion, rules: findScopingRules(undefined) } };
  });
}

export function astSchemaMessage(ctx: PromptContext): PromptMessage {
  return sdkJsonMessage("The DomainMetadata AST schema (sdk-get_ast_schema)", "sdk-get_ast_schema", () => {
    const handle = resolveSdkHandle(ctx.bundle);
    if (handle.state === "unavailable") return { error: handle.reason };
    const loaded = loadAstSchema(handle.bundle, ctx.bundleRoot);
    if ("errorResult" in loaded) return { error: failureText(loaded.errorResult) };
    return { value: loaded.schema.envelope };
  });
}

export function deprecationsMessage(ctx: PromptContext): PromptMessage {
  return sdkJsonMessage("The deprecated annotations and attributes (sdk-list_deprecations)", "sdk-list_deprecations", () => {
    const handle = resolveSdkHandle(ctx.bundle);
    if (handle.state === "unavailable") return { error: handle.reason };
    const loaded = loadCatalog(handle.bundle, ctx.bundleRoot);
    if ("errorResult" in loaded) return { error: failureText(loaded.errorResult) };
    return { value: { sdkVersion: loaded.catalog.sdkVersion, ...collectDeprecations(loaded.catalog, false) } };
  });
}

/**
 * Wrap untrusted text in a code fence longer than any backtick run inside it,
 * so the text cannot close the fence and pass for instructions.
 */
export function fenced(body: string, info = ""): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

export const NEEDS_LOCAL_SERVER =
  "This step needs a local server: on the hosted endpoint the tool answers `family_unavailable`; " +
  "if it does, say so rather than skipping the step.";
