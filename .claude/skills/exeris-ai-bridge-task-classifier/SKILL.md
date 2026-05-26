---
name: exeris-ai-bridge-task-classifier
description: Router/Planner triage skill for exeris-ai-bridge. Classifies task type (architecture / implementation / tool-family / transport / cross-repo / docs), scope, severity, and recommends primary agent based on primary risk against ADR-025.
---

# Exeris AI Bridge Task Classifier

## Purpose
Classify incoming work before execution starts. Triage only — no implementation.

## Output Contract
Return exactly:
1. `task_class` (`ARCHITECTURE` | `IMPLEMENTATION` | `TOOL_FAMILY` | `TRANSPORT` | `CROSS_REPO` | `DOCS_ADR` | `MULTI_DOMAIN`)
2. `scope` (single-family | cross-family | cross-repo | transport-internal)
3. `severity` (low | medium | high | critical)
4. `primary_risk`
5. `recommended_primary_agent`

## Classification Heuristics
- `ARCHITECTURE`: ADR-025 alignment, Wall by construction, license, not-a-capability.
- `IMPLEMENTATION`: TS code in `src/server.ts`, `src/tools/{docs,lsp,kernel}/`, helpers.
- `TOOL_FAMILY`: tool naming, namespace, family scope, new family proposal.
- `TRANSPORT`: stdio / SSE / JSON-RPC client / kernel adapter wire layer.
- `CROSS_REPO`: requires companion PR in `exeris-platform-lsp` / `exeris-kernel` / `exeris-docs`.
- `DOCS_ADR`: ADR-025 amendment, ROADMAP, README, link stubs.
- `MULTI_DOMAIN`: at least two classes above are first-order concerns.

## Guardrails
- Preserve The Wall (TS/Node process; no Java classpath link).
- Preserve no-model-API rule.
- Preserve read-only-tools rule.
- Preserve not-a-capability rule.
- Preserve `docs:* / lsp:* / kernel:*` family discipline.
- If uncertain between two classes, emit `MULTI_DOMAIN` and state both.

## Completion Criteria
All five output fields present and each justified in 1-2 concise bullets.
