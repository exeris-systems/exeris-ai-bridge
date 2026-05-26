---
name: exeris-ai-bridge-routing-planner
description: Router/Planner skill for exeris-ai-bridge. Produces primary agent, secondary handoffs, execution order, validation gates, and minimal next action for an MCP server task.
---

# Exeris AI Bridge Routing Planner

## Purpose
Given a classified task (see `exeris-ai-bridge-task-classifier`), produce a minimal, risk-aware execution order across `exeris-ai-bridge-{router,architect,implementer,tool-family-discipline,docs-adr}`.

## Output Contract
1. `primary_agent`
2. `secondary_handoffs` (ordered list with reason)
3. `execution_plan` (3–5 steps)
4. `validation_gates` (must-pass list)
5. `minimal_next_action`

## Routing Patterns
- `ARCHITECTURE` → `exeris-ai-bridge-architect` primary; `docs-adr` secondary when ADR-025 amendment needed.
- `IMPLEMENTATION` → `exeris-ai-bridge-implementer` primary; `tool-family-discipline` if new tool surface; `architect` if new dep.
- `TOOL_FAMILY` → `exeris-ai-bridge-tool-family-discipline` primary; `implementer` secondary for actual code.
- `TRANSPORT` → `exeris-ai-bridge-architect` primary (Wall risk); `implementer` secondary.
- `CROSS_REPO` → `exeris-ai-bridge-architect` primary; `docs-adr` for link stubs; companion PR in target repo is owned by that repo.
- `DOCS_ADR` → `exeris-ai-bridge-docs-adr` primary; `architect` secondary if amendment.
- `MULTI_DOMAIN` → start with `architect`, list all dominant handoffs.

## Default Validation Gates
- Wall / process-boundary integrity (always; cheap to scan).
- Read-only audit when handler added/changed.
- Path-sandbox enforcement when filesystem read added.
- Tool family namespace correctness.
- `npm run typecheck` + `npm run build` green.
- ADR-025 amendment when adding family / license / dep that changes posture.

## Completion Criteria
All five contract fields present and gates tied to the specific risk surface.
