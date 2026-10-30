# Brief fixtures

The briefs here are the SDK's own planted-gap fixtures, copied unchanged from `exeris-sdk`, path
`exeris-sdk-source-model/src/test/resources/briefs/`. The verdicts the bridge's tests expect for them
are the ones `BriefSchemaContractTest` asserts there.

- Nine come from tag `v0.13.1`.
- `gap-repeated-question-id`, `gap-undeclared-workflow-actor` and `gap-unknown-concern-hint` come from
  exeris-sdk#258 (branch `fix/brief-rules-outside-schema`, ADR-106 amendment of 2026-10-30); they are
  to be pinned to tag `v0.13.2` when it is released.
