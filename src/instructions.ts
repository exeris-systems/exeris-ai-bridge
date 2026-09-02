import type { BridgeConfig } from "./config/env.js";

/**
 * What the client hands the model at connect time, before it has called
 * anything.
 *
 * This exists because of an observed failure, not as decoration: an agent whose
 * training is overwhelmingly Spring/JPA will design a Spring application on an
 * Exeris codebase unless something corrects it *first*. A tool cannot do that
 * — the agent has to already suspect it needs one to call it — and by then the
 * shape of the answer is usually decided.
 *
 * So this deliberately stays a ROUTE, not a cheat sheet. Everything below is
 * either a property of this server (which cannot go stale here) or a pointer at
 * the tool that answers authoritatively. Framework facts belong in the docs the
 * tools serve; copied here they would be a second, unversioned copy that drifts
 * and that nothing tests.
 */
export function buildInstructions(config: BridgeConfig): string {
  const families = [
    `docs=${config.docs.state}`,
    `lsp=${config.lsp.state}`,
    `kernel=${config.kernel.state}`,
    `build=${config.project.state}`,
    `caps=${config.project.state}`,
  ].join(" ");
  return `exeris-ai-bridge publishes the Exeris ecosystem to you as read-only tools. Every
tool is a read. Nothing here writes a file, edits a project, or changes kernel
state — when a change is decided, you make it with your own tools.

Before writing Exeris code, correct one default: Exeris is not Spring. The kernel
is Spring-free as an architectural invariant (ADR-006), and there is no Spring
application context, no dependency-injection container, and no JPA or Hibernate
anywhere in the kernel, SDK or build tooling. Applications are declared with
\`@ExerisDomain\` and the SDK annotation set, and the build generates the runtime
artefacts from that declaration — handlers, repositories, SQL migrations, clients.
Two failure modes follow, and both are common:
  - transferring a Spring/Jakarta/Hibernate idiom by analogy. It will look
    plausible and be wrong. Check it with \`docs-search\` or \`docs-get_adr\` first.
  - hand-writing something the build already generates (schema DDL is the usual
    one). Check what is generated before writing it by hand.

Tool names are \`family-tool\`:
  docs-*    ADR registry, high-level architecture, whitepaper, per-repo docs
  lsp-*     the \`@ExerisDomain\` source model — domains, fields, relations, actions
  kernel-*  read-only introspection of a RUNNING kernel (providers, bootstrap
            DAG, subsystem detail, resolved JVM ergonomics)
  build-*   what YOUR OWN project's last build emitted — the DomainMetadata AST
            the code generators consume, per entity
  caps-*    the capability composition of YOUR OWN project, from the build-time
            cap-manifest.json — modules, provided services, init order, stamp
  bridge-*  this server itself; never unavailable

Resolved for this session: ${families}.

A family whose dependency did not resolve still answers: every call returns
\`{"error": "family_unavailable"}\` with a reason and a remedy. That is an answer to
relay, not a transport fault to retry. \`bridge-health\` reports the whole picture.
`;
}
