# Contract kernel

These files are the shared boundary between independently developed worktrees.
They must be reviewed and frozen before runtime, learning, registry, or UI
branches begin.

## Schemas

- `action-list.schema.json` defines a site-scoped, policy-gated list of
  deterministic actions that can be projected into WebMCP tools.
- `run-message.schema.json` defines events exchanged by the source bridge,
  extension service worker, execution tab, and confirmation UI.
- `examples/owned-storefront.action-list.json` is the first shared conformance
  fixture.
- `examples/owned-storefront.run-messages.json` is a complete positive message
  lifecycle fixture from request through structured result.
- `system-contract.md` assigns every producer, consumer, invariant, failure,
  and acceptance boundary surrounding these schemas.

The existing `learning-trace/3` and `action-map/1` remain the learning-side
contracts. `action-list/1` is the runtime projection of executable actions from
an action map. Runtime code never consumes a model response directly.

## Validation layers

JSON Schema validates shape and local constraints. Implementations must also run
the following semantic checks because they require cross-object knowledge:

1. State IDs, action IDs, tool names, step IDs, field names, and evidence
   references are unique in their scopes.
2. Every `precondition.allowedStateIds` and every `state` condition references a
   declared state.
3. Every `value.fromArgument` and `safety.sensitiveArguments` entry exists in
   `tool.inputSchema.properties`.
4. Every name in `tool.inputSchema.required` exists in its `properties` object.
5. `safety.confirmationStepId` exists and is non-null exactly when confirmation
   is `before_step`.
6. `readOnlyHint` is true exactly when `writesExternalState` is false.
7. The site origin appears in `runtime.allowedOrigins`; all observed navigation
   remains in the allowlist.
8. All regexes compile under the runtime's bounded regular-expression policy.
9. CSS locator strategies parse successfully and do not use selectors rejected
   by the generated-selector heuristic.
10. A `one` locator resolves to exactly one visible, enabled target. Runtime
    execution never silently picks the first of several matches.
11. An action with a non-`none` output has one final `extract` step. A `none`
    output has no `extract` step.
12. Each consequential step has at least one postcondition and one evidence
    reference. An action-frame sequence precedes its update-frame sequence.
13. A `published` action belongs to a `published` list with a verified content
    digest and an unexpired `allowed` policy decision containing the required
    scope.
14. Read actions are safe to repeat. Conditional or unsafe actions are never
    automatically replayed after an uncertain result.
15. Literal values are scanned for credentials, payment data, contact details,
    account identifiers, and demonstrated user input before publication.

## Compatibility rule

Consumers reject unknown major versions. Additive optional fields may be added
within a major version only when older consumers safely ignore them. Any new
operation, changed operation semantics, changed default, or relaxed trust
boundary requires a new schema version.

## Change rule

After implementation worktrees branch from the contract commit, schema changes
require:

1. a focused contract pull request or integration commit;
2. an updated conformance fixture;
3. JS and Go validator tests;
4. explicit notification to each active worktree owner;
5. rebasing or merging the contract commit before dependent code changes.

Do not make an uncoordinated copy of a schema inside a feature branch.
