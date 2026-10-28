import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

import type { DocsConfig, Unavailable } from "../config/env.js";
import {
  readAdrContent,
  readAdrIndexMarkdown,
  readHla,
  readTemplate,
  readWhitepaper,
  TEMPLATE_KINDS,
  type DocsContent,
  type TemplateKind,
} from "../tools/docs/content.js";

// The exeris://docs/* resources: the registry tier of docs:* addressed by URI.
// Content is read through the same functions as the docs-* tools, so a
// checkout, the bundled snapshot and the public-scope policy decide what a
// resource returns exactly as they decide what a tool returns.
//
// The lists are fixed. They do not depend on the docs configuration, on which
// ADRs exist, or on the mode, for the reason tools/list does not: a client
// caches them at connect time and the surface is frozen under semver. Whether
// a URI can be read is answered by resources/read.

const MIME_TYPE = "text/markdown";
const URI_PREFIX = "exeris://docs/";

/** JSON-RPC code the MCP specification assigns to "resource not found". */
export const RESOURCE_NOT_FOUND = -32002;

const ADR_INDEX_URI = `${URI_PREFIX}adr-index`;
const HLA_URI = `${URI_PREFIX}hla`;
const WHITEPAPER_URI = `${URI_PREFIX}whitepaper`;

const ADR_URI_RE = /^exeris:\/\/docs\/adr\/(\d{3})$/;
const TEMPLATE_URI_RE = /^exeris:\/\/docs\/template\/([A-Z]+)$/;

export const DOCS_RESOURCES: readonly Resource[] = [
  {
    uri: ADR_INDEX_URI,
    name: "adr-index",
    title: "ADR registry index",
    description:
      "The ecosystem ADR registry: number, title, owning repo, scope, visibility, status and link of every record. " +
      "Subscribable: from an exeris-docs checkout a notification follows each change to the file; " +
      "from the bundled snapshot the content is immutable for the process, so a subscription is accepted and never fires.",
    mimeType: MIME_TYPE,
  },
  {
    uri: HLA_URI,
    name: "hla",
    title: "High-Level Architecture",
    description: "The canonical narrative of the three-tier model.",
    mimeType: MIME_TYPE,
  },
  {
    uri: WHITEPAPER_URI,
    name: "whitepaper",
    title: "B2B technical whitepaper",
    description: "The B2B technical whitepaper.",
    mimeType: MIME_TYPE,
  },
];

export const DOCS_RESOURCE_TEMPLATES: readonly ResourceTemplate[] = [
  {
    uriTemplate: `${URI_PREFIX}adr/{NNN}`,
    name: "adr",
    title: "ADR by number",
    description:
      "One ADR by its three-digit registry number (e.g. 025). A record whose repository is not served publicly answers with its owning repository and GitHub URL.",
    mimeType: MIME_TYPE,
  },
  {
    uriTemplate: `${URI_PREFIX}template/{kind}`,
    name: "template",
    title: "Decision-doc template",
    description: `A decision-doc template; kind is one of ${TEMPLATE_KINDS.join(", ")}.`,
    mimeType: MIME_TYPE,
  },
];

type DocsUri =
  | { readonly kind: "adr-index" | "hla" | "whitepaper" }
  | { readonly kind: "adr"; readonly number: number }
  | { readonly kind: "template"; readonly template: TemplateKind };

/**
 * Classify a URI against the closed set above. The only parts of the URI that
 * survive are a member of a fixed enum and three digits, so nothing a client
 * sends is ever joined into a path.
 */
function parseDocsUri(uri: string): DocsUri {
  switch (uri) {
    case ADR_INDEX_URI:
      return { kind: "adr-index" };
    case HLA_URI:
      return { kind: "hla" };
    case WHITEPAPER_URI:
      return { kind: "whitepaper" };
  }
  const adr = ADR_URI_RE.exec(uri);
  if (adr) return { kind: "adr", number: Number.parseInt(adr[1], 10) };
  const template = TEMPLATE_URI_RE.exec(uri);
  if (template && TEMPLATE_KINDS.includes(template[1] as TemplateKind)) {
    return { kind: "template", template: template[1] as TemplateKind };
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `Unknown resource URI. Expected exeris://docs/adr-index, exeris://docs/adr/{NNN} (three digits), ` +
      `exeris://docs/hla, exeris://docs/whitepaper or exeris://docs/template/{${TEMPLATE_KINDS.join("|")}}.`,
  );
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Read one docs resource. A URI outside the closed set is invalid params;
 * content that does not exist is the MCP "resource not found" error; docs being
 * unavailable, or content that exists and cannot be read, is an internal error
 * whose data says which.
 */
export function readDocsResource(docs: DocsConfig | Unavailable, uri: string): ResourceContents[] {
  const target = parseDocsUri(uri);
  if (docs.state === "unavailable") {
    throw new McpError(
      ErrorCode.InternalError,
      `The docs-* tool family is not available in this environment. ${docs.reason} ${docs.remedy}`,
      { error: "family_unavailable", family: "docs", reason: docs.reason, remedy: docs.remedy },
    );
  }
  const content = readTarget(docs, target);
  if (!content.ok) {
    throw new McpError(
      content.kind === "not_found" ? RESOURCE_NOT_FOUND : ErrorCode.InternalError,
      content.message,
      { uri },
    );
  }
  return [{ uri, mimeType: MIME_TYPE, text: content.text }];
}

function readTarget(docs: DocsConfig, target: DocsUri): DocsContent {
  switch (target.kind) {
    case "adr-index":
      return readAdrIndexMarkdown(docs);
    case "hla":
      return readHla(docs);
    case "whitepaper":
      return readWhitepaper(docs);
    case "adr":
      return readAdrContent(docs, target.number);
    case "template":
      return readTemplate(docs, target.template);
  }
}
