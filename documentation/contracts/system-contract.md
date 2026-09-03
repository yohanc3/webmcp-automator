# WebMCP Automator system contracts

Status: implementation contract for the owned-demo MVP.

This document assigns one responsibility and one interface to each part of the
system. It is intentionally explicit so implementation can proceed in parallel
without each branch inventing a different meaning for an action, run, page
state, or successful result.

The machine-readable source of truth is:

- [`action-list.schema.json`](action-list.schema.json) for published runtime
  capabilities;
- [`run-message.schema.json`](run-message.schema.json) for ready-path events;
- [`ambient-parse-request.schema.json`](ambient-parse-request.schema.json) for
  each automatic semantic-layer parse;
- [`action-map-patch.schema.json`](action-map-patch.schema.json) and
  [`action-map-revision.schema.json`](action-map-revision.schema.json) for
  incremental, idempotent map updates;
- the existing `learning-trace/3` validator for historical batched trace and
  replay-fixture compatibility; and
- the existing `action-map/1` validator for the canonical action artifact.

## 1. Product boundary

The system has two pipelines joined by one publication gate:

```text
LEARN
eligible ambient browser activity
  -> sanitized semantic-ui/2 layer + causal observation when present
  -> ambient-parse-request/1 for every completed meaningful layer
  -> AI action-map-patch/1
  -> deterministic compare-and-append action-map/1 revision
  -> compile + validate + replay + review
  -> published action-list/1

READY
published action-list/1
  -> register WebMCP tools in a source page
  -> accept a typed invocation
  -> execute deterministic steps in a separate site tab
  -> verify postconditions
  -> return a typed result or structured error
```

The parser does not build a hidden learned model and does not receive a
user-supplied goal. It incrementally proposes changes to the visible,
versioned `action-map/1` artifact. Every proposed action already has at least one
executable step and evidence-bound targets; deterministic validation and
revision persistence still separate AI output from runtime authority. The ready
path consumes only a validated, immutable, published action-list revision.

### Required MVP invariants

1. Ready-path execution contains no LLM call and no arbitrary JavaScript from
   the registry.
2. Every run is pinned to one immutable list digest and action version.
3. Every target locator is resolved under explicit cardinality rules. Zero or
   multiple matches fail; the actor never silently chooses the first match.
4. A mutating step is successful only when its declared postcondition is true.
5. Navigation is successful only inside `runtime.allowedOrigins` and within the
   action's navigation budget.
6. Service-worker suspension must not lose the run. Persist state before every
   dispatch and resume from idempotent events.
7. External-state writes stop at a confirmation boundary unless the published
   safety contract explicitly permits that exact class of write.
8. A policy decision other than current, explicit `allowed` prevents tool
   registration and execution.
9. Raw DOM text, form values, credentials, and payment data do not cross the
   client/server boundary by default.
10. Failure is typed and observable. A timeout or uncertain side effect is
    never reported as success.
11. Policy is allowed before ambient observers attach, and privacy filtering
    occurs while semantic evidence is projected, before local persistence or
    model transfer.
12. Every completed meaningful semantic layer is parsed. Confidence, novelty,
    event count, and user intent do not gate parsing.
13. Universal DB stores action-map/list revisions and safe evidence metadata,
    never semantic XML or raw/sanitized browsing observations.

### Deliberate non-goals for the first integrated slice

- arbitrary sites, arbitrary DOM scripts, CAPTCHA solving, anti-bot bypasses;
- cross-origin iframe automation, file uploads, downloads, clipboard control;
- autonomous purchases or irreversible submission without confirmation;
- perfect locator healing after an unseen redesign;
- distributed workers or a cloud queue before one browser can finish one run;
- a custom action language. JSON remains canonical; readable text is a view.

## 2. Canonical artifacts

### 2.1 Ambient semantic layer: `ambient-parse-request/1`

Producer: policy-gated ambient capture plus the client sanitizer and compact
context projector.

Consumers: AI parser/compiler and deterministic patch validator.

Contract:

- one completed `semantic-ui/2` XML layer per request;
- the causal sanitized observation that led to it, absent only on the initial
  layer;
- a monotonically increasing site-scoped layer sequence;
- exact action-map base revision and digest;
- compact prior state/action semantics without expanded steps or locators;
- parser, policy, sanitizer, retry, and idempotency identity; and
- stable semantic node/evidence IDs with user values replaced by typed tokens.

Every completed meaningful layer is parsed immediately. There is no goal,
manual recording session, novelty threshold, or minimum-evidence gate. Exact
delivery duplicates are idempotent. A distinct user observation produces a new
layer even if its XML digest equals the previous layer.

The full normative contract is
[`ambient-learning.md`](ambient-learning.md). `learning-trace/3` remains an
accepted compatibility artifact for historical batched recordings and replay
fixtures, not the ambient parser's primary request.

### 2.2 Action map: `action-map/1`

Producer: deterministic application of accepted `action-map-patch/1` results.

Consumers: action-list compiler, review UI, provenance view, and compact-context
projector.

Contract:

- nodes represent inferred or observed page states;
- actions are executable state transitions or extractions with at least one
  step;
- page XML alone may yield `resolvable` actions;
- causal observations connect and upgrade actions to `observed` paths;
- flattened composite actions may include internal navigation steps;
- action evidence retains compact layer/node/step binding handles;
- parameter candidates distinguish demonstrated literals from inferred inputs;
- confidence is advisory metadata, never authority to execute.

The action map is the visible editable artifact, not an internal learned model.
The ambient parser profile does not emit unresolved zero-step actions. The map
may still contain unpublishable executable candidates pending replay, review,
or policy. It is not the object registered as WebMCP tools.

### 2.3 Action list: `action-list/1`

Producer: observed-plan compiler and publication service.

Consumers: registry API, WebMCP registrar, coordinator, actor runtime, review
UI, conformance tests.

Contract: [`action-list.schema.json`](action-list.schema.json).

An action list is a site-scoped capability bundle. Its major sections mean:

- `site`: exact origin and route scope on which tools can be offered;
- `publication`: candidate/reviewed/published lifecycle, immutable revision,
  digest, and validator identity;
- `policy`: independently evaluated permission to register and run;
- `states`: recognizable page states used by preconditions and effects;
- `actions[].tool`: the WebMCP-visible name, description, input schema, and
  annotations;
- `actions[].steps`: deterministic actor instructions;
- `actions[].output`: the typed result projection;
- `actions[].safety`: confirmation, repeatability, sensitive arguments, and
  external-state semantics;
- `actions[].runtime`: origin, duration, and navigation bounds;
- `actions[].provenance`: learning source and supporting evidence IDs.

The sample
[`examples/owned-storefront.action-list.json`](examples/owned-storefront.action-list.json)
is the executable conformance fixture, not merely illustrative pseudocode.

### 2.4 Run messages: `webmcp-run/1`

Producers/consumers: main-world registrar, isolated source bridge, MV3
coordinator, execution content script, confirmation UI.

Contract: [`run-message.schema.json`](run-message.schema.json).

Every message has a protocol, discriminated type, request ID, run ID, monotonic
sequence, timestamp, sender context, and typed payload. The message log is an
event ledger; it is not the run's only persistent state.

`run.request` carries the exact registered action-list identity as `listId`,
`listRevision`, and `listDigest`. The coordinator resolves the immutable
revision endpoint and verifies all three fields before policy evaluation or tab
creation. A later publication for the same list cannot replace an accepted
request's executable plan.

`page.ready` carries actor-evaluated `preconditionSatisfied` and
`pendingStepSatisfied` values in addition to URL, state identity, and a
document-local mutation revision. `step.completed` advances that page revision
alongside its effect. This keeps DOM checks inside the deterministic actor while
the coordinator retains the authoritative navigation, document, and
pending-step state machine.

A consequential `before_step` confirmation binds the action-list and policy
revision plus the execution document, URL, state, navigation sequence, and last
accepted actor sequence. Approval returns the run to `waiting_for_page`; the
coordinator requests a fresh actor attestation and dispatches only if that new
event advances the actor sequence while preserving the bound page identity and
entry precondition. Approve and deny are a single-use decision in the review UI.

The source replies to `run.result` or `run.error` with `run.ack`. Until that
acknowledgement names the exact terminal sequence, the durable coordinator
keeps the terminal envelope eligible for replay after a transient MV3 port or
service-worker disconnect.

### 2.5 Run observation: `run-observation/1`

Producer: coordinator after terminal status.

Consumers: local diagnostics, drift monitor, aggregate registry health.

Minimum fields:

```json
{
  "schemaVersion": "run-observation/1",
  "runId": "run_demo_001",
  "listId": "owned-storefront",
  "listDigest": "sha256:...",
  "actionId": "search_products",
  "actionVersion": 1,
  "startedAt": "2026-09-03T01:00:00Z",
  "finishedAt": "2026-09-03T01:00:03Z",
  "status": "completed",
  "steps": [
    {
      "stepId": "fill_query",
      "status": "completed",
      "durationMs": 18,
      "locatorStrategyIndex": 0,
      "matchCount": 1,
      "postconditionSatisfied": true
    }
  ],
  "finalStateId": "search_results",
  "errorCode": null
}
```

It must contain no raw input values or extracted page content. Detailed results
remain local to the request unless the user explicitly exports them.

## 3. Action semantics

An action is a bounded partial state transition:

```text
execute(action, current_page, typed_arguments)
  -> typed_result | structured_error
```

It is defined only when all of the following are true:

```text
published(list)
AND policy_allows(list, origin, required_scope, now)
AND route_matches(list.site, current_url)
AND state_matches(action.precondition, current_page)
AND arguments_validate(action.tool.inputSchema)
AND confirmation_satisfied(action.safety)
```

### 3.1 Locator semantics

A locator contains an ordered list of strategies. Strategies are tried in
order; a later strategy is a fallback, not an additional filter.

Resolution for cardinality `one`:

1. resolve the strategy within the current document;
2. apply visibility and enabled filters;
3. if exactly one element remains, return it;
4. if zero remain, try the next strategy;
5. if more than one remain, fail `TARGET_AMBIGUOUS` immediately;
6. if all strategies produce zero, fail `TARGET_NOT_FOUND`.

Resolution for cardinality `many` returns the ordered matched set and applies
the declared limit. Collection order is DOM order unless an action explicitly
declares another stable order in a future schema version.

Role/name locators are preferred because they express user-visible semantics.
Stable attributes are second. CSS is a bounded fallback. Coordinates, XPath,
generated class chains, and model-authored scripts are outside version 1.

### 3.2 Primitive semantics

| Operation | Input | Required behavior | Success evidence |
|---|---|---|---|
| `fill` | locator + literal/argument value | use the native value setter where needed; dispatch input and change events | target value condition or explicit DOM/state condition |
| `click` | one locator | scroll into view; verify interactability; click once | URL, DOM, collection, or state condition |
| `press` | allowlisted key + optional locator | focus target if present; dispatch one key sequence | declared postcondition |
| `wait` | condition | observe until condition or timeout; no guessed fixed sleep as correctness | condition evaluates true |
| `extract` | output projection | read bounded fields from one page object or collection | result validates against the action output shape |

Each primitive receives an `AbortSignal`. Cancellation must stop future steps;
it cannot promise to undo a side effect that has already occurred.

### 3.3 Postcondition semantics

Postconditions are evaluated after the triggering operation. Multiple
conditions in an `all` set must all pass; multiple conditions in an `any` set
need one pass. A step completion event includes the before/after URL, before/
after state, navigation observation, and whether the condition passed.

An actor must not infer success from a click returning without an exception.
For example, clicking Search succeeds only when the declared results state or
URL appears. If the page remains unchanged, return `POSTCONDITION_FAILED`.

### 3.4 Output semantics

`none` returns only completion metadata. `page` projects named fields from one
page scope. `collection` resolves items first and then resolves each field
inside each item; it never queries a field globally and guesses association.

Missing required fields fail the extraction. Missing optional fields become
`null`. Items are JSON objects. URLs are normalized to absolute URLs before
return. The actor enforces the action's item limit before serializing results.

### 3.5 Confirmation and idempotency

- `never`: valid only for read-only or locally reversible operations approved
  by policy;
- `before_action`: pause before the first step;
- `before_step`: pause immediately before `confirmationStepId`;
- `always`: confirmation cannot be cached across invocations.

`safe` actions may be automatically replayed from the beginning after a known
pre-side-effect transport failure. `conditional` actions may retry only before
their first consequential effect. `unsafe` actions never retry automatically.

For an Amazon order demo, search may be `safe`; adding to cart is at least
`conditional`; placing the order is `unsafe` and must stop at confirmation.

## 4. Ready-path component contracts

### R0. Contract validator library

Responsibility: provide one JS validator and one Go validator for the canonical
schemas and semantic rules.

Inputs: action-list JSON, run-message JSON, current time, supported versions.

Outputs: typed object or `{code, path, message}` validation failures.

Invariants:

- validation has no network dependency;
- unknown major versions fail closed;
- runtime registration never bypasses semantic checks because JSON shape passed;
- fixture parity tests prove JS and Go accept and reject the same corpus.

Primary implementation ownership: a new `contracts/` package at repository
root, consumed by `extension/` and `server/`. Generated artifacts must include
their source digest and must not be hand-edited.

Acceptance tests: valid owned-storefront list passes in JS and Go; each broken
invariant in `documentation/contracts/README.md` has a rejection fixture.

### R1. Policy eligibility service

Responsibility: determine whether a list may be discovered, registered, and
executed for an origin.

Inputs: normalized origin, list policy block, local user override, current
time, requested capability scope.

Output:

```json
{
  "decision": "allowed",
  "scopes": ["discover", "execute.read"],
  "reasonCode": "OWNED_DEMO_ALLOWLIST",
  "source": "local_override",
  "checkedAt": "2026-09-03T01:00:00Z",
  "expiresAt": "2026-09-04T01:00:00Z"
}
```

Invariants: deny on missing/stale/unknown; a local override is visible and
auditable; policy is checked before registration and again before execution;
read permission does not imply external-write permission.

Errors: `POLICY_BLOCKED` with reason code safe to show to the user.

Acceptance tests: allow owned demo; reject absent, expired, mismatched-origin,
and insufficient-scope decisions.

### R2. Action-list registry and API

Responsibility: store immutable list revisions, serve the latest eligible
published revision, and preserve provenance and publication history.

Inputs: candidates from compiler, publication decisions, origin-scoped reads,
aggregate run observations.

Outputs: exact action-list revision and digest; never arbitrary code.

Target API:

```text
GET  /v1/action-lists?origin=<origin>&url=<absolute-url>
GET  /v1/action-lists/{listId}/revisions/{revision}
POST /v1/action-lists/{listId}/revisions/{revision}/publish
POST /v1/run-observations
```

Publication request:

```json
{
  "expectedDigest": "sha256:...",
  "reviewDecision": "approve",
  "reviewer": "local-user",
  "policyDecisionId": "policy_owned_demo_001",
  "replayReportId": "replay_owned_demo_001"
}
```

Registry response rules:

- list lookup is exact-origin first and route-filtered;
- only `published` revisions are returned to runtime;
- digest is computed over canonical JSON excluding the digest field itself;
- revisions are append-only; publication never mutates a prior revision;
- compare-and-publish fails if `expectedDigest` is not current;
- current `/api/*` routes may remain during migration but are not the target
  inter-worktree contract.

Acceptance tests: publish valid reviewed candidate; reject invalid schema,
failed replay, stale digest, blocked policy, and attempted revision overwrite.

### R3. WebMCP registrar

Responsibility: expose eligible action-list actions as tools in the source
website and settle tool invocation promises.

Inputs: published lists from the isolated bridge; invocation arguments from
the WebMCP host API; cancellation signal.

Outputs: registered tools and promise result/error.

Invariants:

- one tool registration per `{listDigest, actionId, actionVersion}`;
- tool description and JSON input schema are copied from the published list;
- registrar cannot choose a different action or alter arguments;
- duplicate injection is idempotent;
- navigation/unload rejects or cancels outstanding source requests;
- if main-world injection is required, the shim receives only an allowlisted
  public tool projection and communicates through correlated messages.

The main-world page is untrusted. A page-authored message cannot supply a plan,
change a digest, choose an execution tab, or impersonate coordinator output.

Acceptance tests: register once, invoke valid arguments, reject invalid
arguments, correlate concurrent requests, cancel one request, survive duplicate
initialization, and settle every promise exactly once.

### R4. Source content bridge

Responsibility: connect the registrar in the calling tab to the extension
service worker using an event-driven channel.

Inputs: allowlisted `run.request`/`run.cancel` from registrar; coordinator
events for this source tab.

Outputs: validated extension messages and validated registrar results.

Invariants:

- use a named `chrome.runtime.Port`; no 200 ms result polling;
- bind each request to the actual sender tab/document;
- enforce protocol, message type, schema, origin, sequence, and size limits;
- reconnect after service-worker suspension and replay only unacknowledged
  idempotent messages;
- no API key, full list, or raw trace enters the page world.

Acceptance tests: disconnect/reconnect, duplicate delivery, forged request ID,
wrong origin, stale document, out-of-order sequence, oversized payload.

### R5. MV3 run coordinator

Responsibility: own durable run state, policy checks, list resolution, execution
tab lifecycle, one-step-at-a-time dispatch, cancellation, confirmation, and
result routing.

Inputs: validated source requests, actor events, tab lifecycle events,
confirmation decisions.

Outputs: persisted run transitions and `webmcp-run/1` events.

Persisted record:

```json
{
  "runId": "run_demo_001",
  "requestId": "request_demo_001",
  "source": {"tabId": 12, "documentId": "doc-source"},
  "execution": {"tabId": 18, "documentId": "doc-exec"},
  "listId": "owned-storefront",
  "requestedListRevision": 1,
  "requestedListDigest": "sha256:...",
  "listDigest": "sha256:...",
  "actionId": "search_products",
  "actionVersion": 1,
  "status": "waiting_for_page",
  "stepIndex": 1,
  "lastAcceptedSequenceBySender": {},
  "confirmation": null,
  "createdAt": "2026-09-03T01:00:00Z",
  "updatedAt": "2026-09-03T01:00:01Z"
}
```

State machine:

```text
created
 -> policy_checked
 -> opening_tab
 -> waiting_for_page
 -> dispatching_step[n]
 -> waiting_for_effect | waiting_for_navigation
 -> dispatching_step[n+1]
 -> awaiting_confirmation
 -> extracting
 -> completed | failed | cancelled
```

Persist the next state before performing the associated external action. A
restarted worker reconstructs pending runs from storage and reconciles them
with actual tabs/documents before dispatching anything.

Acceptance tests: happy run; worker suspension at every state; tab closed;
source page closed; cancellation; navigation; wrong document; step timeout;
confirmation approve/deny; duplicated completion event; concurrent independent
runs; terminal events emitted once.

### R6. Execution-tab client

Responsibility: announce each loaded document, execute commands only for its
bound tab/document/run, and report bounded effects.

Inputs: `step.command`, cancellation, and a published action projection already
validated by the coordinator.

Outputs: `page.ready`, `step.completed`, or `step.failed`.

Invariants:

- one active command per document;
- command ID is idempotent within a run;
- a document never executes a command addressed to an earlier document;
- page readiness is semantic/document readiness, not an arbitrary sleep;
- it cannot fetch registry credentials or select its own next step.

Acceptance tests: duplicate command, navigation replacing the document,
command for wrong run, cancellation during wait, command after terminal run.

### R7. Actor runtime

Responsibility: implement locator resolution, primitives, conditions, output
projection, bounded observations, and structured failures.

Inputs: one validated step, typed invocation arguments, current page, abort
signal.

Outputs: one step effect/result or one structured actor error.

Invariants: deterministic; no LLM/network planning; no `eval`; no arbitrary
selectors outside the contract; no retry of clicks unless the coordinator has
proved no consequential effect occurred.

Acceptance tests cover every primitive, every condition, locator fallback,
zero/one/many cardinality, disabled/hidden elements, SPA update, full
navigation, extraction scoping, timeout, abort, and all public error codes.

### R8. Confirmation and review UI

Responsibility: explain what will happen, show redacted argument previews, and
capture an explicit decision for consequential actions.

Inputs: `run.awaiting_confirmation`, local policy and list metadata.

Outputs: `run.confirm` bound to run ID and step ID.

Invariants: no pre-checked approval; approval expires when page, plan digest, or
step changes; sensitive arguments are masked; denial terminates the run; the UI
does not execute steps itself.

Acceptance tests: approve, deny, stale prompt, changed digest, closed tab,
masked sensitive fields.

## 5. Learn-path component contracts

### L1. Policy-gated ambient capture and privacy

Responsibility: automatically attach semantic capture on an eligible top-level
document, construct sanitized semantic XML and causal observations, and complete
layers in deterministic order.

Inputs: current origin/route policy, user-generated events, DOM mutations,
same-document routes, and top-level navigation.

Outputs: `CompletedLayer {siteScope, layer, observation, policy, privacy}` in a
local queue. The initial layer has no observation; every later layer contains
the one observation that caused it.

Invariants:

- policy is `allowed` for `ambient_learn` before observers attach;
- privacy exclusions apply during semantic projection, before serialization;
- every completed meaningful layer is enqueued, with no novelty, confidence,
  event-count, evidence-volume, or user-goal gate;
- internal `start`/`stop` primitives are lifecycle operations, not UI controls;
- synthetic actor events and actor-owned background tabs are excluded;
- raw DOM/event/value material is memory-only and expires within 30 seconds if
  a sanitized layer cannot complete; and
- the local encrypted retry spool deletes a delivered layer after an applied,
  duplicate, or no-change receipt and always before its 24-hour hard TTL.

Acceptance tests: initial page, same-URL update, same-document route, full
navigation, equal XML digest after two distinct observations, event races,
policy revocation, synthetic events, and seeded privacy canaries.

### L2. Parse request and compact context projector

Responsibility: combine one completed layer with the exact current action-map
base and a bounded semantic projection of prior accepted revisions.

Inputs: `CompletedLayer`, `GET .../head`, and `GET .../context`.

Outputs: one immutable `ambient-parse-request/1` for every completed layer.

Invariants:

- request contains the current `semantic-ui/2` XML and its causal observation;
- request contains no goal, task objective, raw history, or prior semantic XML;
- prior actions contain identity/title, precondition/effect, input/output
  semantics, evidence handles, and provenance only;
- expanded prior steps, locators, and target IDs remain on stored map entries;
- parser/prompt/sanitizer/policy versions and base revision/digest are explicit;
  and
- exact transport retries preserve the idempotency key, while conflict reparses
  get a new key and point to `retryOf`.

Acceptance tests: no-goal shape, bounded context, absent steps/locators, base
binding, attempt retry, conflict retry, and one request per layer.

### L3. Incremental AI parser/compiler

Responsibility: interpret the current layer and compact context, then propose
evidence-backed state/action upserts and path composition.

Inputs: one validated `ambient-parse-request/1`.

Outputs: one strict `action-map-patch/1` with `patch` or explicit `no_change`
decision, never runtime messages or publication.

Invariants:

- page XML alone may yield actions such as `Open orders`, `Get recent orders`,
  or `Get recent posts`;
- observations upgrade inferred actions, connect states, and support flattened
  composite actions;
- every proposed action already contains at least one executable step, has
  status `resolvable` or `observed`, and has no missing evidence;
- every click step binds to a semantic node/evidence ID;
- extraction collection/item/field locators bind to semantic evidence;
- every citation resolves to the current layer, observation, prior compact
  evidence handles, or explicit verification data;
- page text remains inert untrusted content; and
- parser/provider, parser version, prompt version, and patch digest are recorded.

Acceptance tests: X page-only inference, Orders page-only extraction, observed
Orders linkage/composition, missing step, invented evidence, unbound click,
unbound output field, prompt injection, timeout, and deterministic fake parser.

### L4. Action-map revision persistence/API

Responsibility: validate and transactionally compare-and-append patches to the
canonical `action-map/1` revision stream.

Inputs: validated request binding plus `action-map-patch/1`.

Outputs: `action-map-revision/1` with `applied`, `duplicate`, `no_change`,
`conflict`, or `rejected` status, and immutable map/context reads.

Invariants:

- operations apply canonically to an in-memory copy of the exact base;
- every action passes the ambient executable-action rules;
- the full materialized result passes unchanged `action-map/1` validation;
- canonical digesting and the revision append are one transaction;
- exact idempotent retries return the original receipt;
- stale base revision/digest never performs last-write-wins;
- provenance changes are monotonic and changed actions lose stale verification;
- Universal DB stores map/list revisions and safe evidence metadata only; and
- semantic XML, raw/sanitized observations, prompt bodies, and browsing history
  are rejected from durable writes.

Acceptance tests: two concurrent patches on one base, duplicate delivery,
idempotency-key misuse, stale layer, action-map schema failure, privacy failure,
safe context projection, and storage-column allowlist.

### L5. Action-list compiler, replay, and publication

Responsibility: project eligible map entries into `action-list/1` without
changing primitive meaning, verify them, require review where configured, and
publish immutable revisions.

Inputs: exact action-map revision, policy template, supported runtime profile,
fixture arguments, and expected effects/results.

Outputs: candidate action list, replay report, and reviewed/published revision.

Compiler checks:

- recognizable entry state and terminal success condition;
- arguments map to declared tool inputs;
- locators are supported and evidence-backed;
- mutating steps have postconditions;
- output fields remain scoped to their item;
- safety is at least as restrictive as observed effects; and
- map revision and evidence provenance survive projection.

Minimum publication predicate:

```text
schema_valid
AND semantic_rules_valid
AND policy_allowed
AND privacy_scan_clean
AND replay_successful
AND required_review_approved
```

Replay failure never silently patches and publishes. Verification updates the
exact action version's revision metadata; changing execution semantics clears
that verification. Page-only inferred actions remain map candidates until
verification produces factual step evidence in the existing transition
reference shape, including a same-page no-visible-change transition for a pure
read. Both `action-map/1` and `action-list/1` schemas remain unchanged.

Acceptance tests: owned read action compiles and verifies; missing effect,
unknown argument, unsupported primitive, ambiguous locator, unsafe
classification, stale digest, revoked policy, and missing review fail.

### L6. Drift monitor and quarantine

Responsibility: aggregate privacy-safe run health and disable a published
revision whose behavior no longer satisfies its contract.

Inputs: run observations and explicit user reports.

Outputs: health state `healthy | degraded | quarantined`, reason, and an
ambient re-verification signal.

Invariants: no extracted result content in telemetry; failures are grouped by
list digest/action/error code; quarantine stops new registration; ambient
parsing may produce a new candidate revision but never autonomously republishes
it.

Acceptance tests: repeated target-not-found crosses the configured runtime
health threshold; isolated cancellation does not; a new revision has independent
health. This runtime threshold never suppresses ambient layer parsing.

## 6. End-to-end ready sequence

1. Source bridge normalizes the current origin and URL.
2. Policy service resolves discovery permission.
3. Registry returns only eligible published action-list revisions.
4. Both bridge and coordinator validate schema, semantic rules, policy, and
   digest.
5. Registrar projects `actions[].tool` into WebMCP registrations.
6. A tool invocation validates arguments locally and emits `run.request`.
7. Coordinator persists `created`, resolves exact digest/version, rechecks
   policy, and persists `policy_checked`.
8. Coordinator creates or selects an inactive execution tab for the exact site
   origin and persists its identity.
9. Execution client emits `page.ready` for its current document.
10. Coordinator verifies preconditions and dispatches exactly one step.
11. Actor resolves the target, executes once, observes the postcondition, and
    emits exactly one terminal step event.
12. Navigation creates a new document, which emits a fresh `page.ready`; the
    coordinator resumes from persisted state.
13. At a confirmation boundary, the coordinator pauses and waits for an exact
    run/step decision.
14. The final extract validates and returns structured JSON.
15. Coordinator persists terminal status, sends `run.result` or `run.error`,
    and stores a redacted run observation.
16. Source bridge settles the original WebMCP promise exactly once.

## 7. End-to-end learning sequence

1. Policy approves `ambient_learn` for the normalized site scope before capture
   attaches.
2. The extension completes a privacy-sanitized initial semantic XML layer.
3. Request assembly reads the current map base and compact prior context.
4. The parser receives that layer immediately, with no observation on the
   initial page and no goal.
5. AI proposes a strict patch containing only executable evidence-backed
   actions and state upserts.
6. Persistence validates, materializes, digests, and appends one immutable
   action-map revision or returns a duplicate/conflict/rejection receipt.
7. An eligible user event is causally joined to its semantic update/navigation
   and resulting layer.
8. That completed layer is parsed immediately with the observation and compact
   context from the accepted revision.
9. The patch may upgrade inferred actions to observed, connect states, and add
   flattened composite paths.
10. Eligible map entries compile to candidate `action-list/1` revisions.
11. Deterministic replay, privacy/safety checks, and configured review establish
    verification and publication eligibility.
12. Publication writes an immutable action-list revision and ready-path
    discovery can expose its tools.

Exact request retries do not add revisions. A stale base causes a reparse of
the same source layer against the new head; no browsing history is replayed into
the prompt.

## 8. Trust boundaries and data classes

| Boundary | Trusted side | Untrusted side | Allowed crossing |
|---|---|---|---|
| page world ↔ isolated content | extension bridge | host page/main-world shim | public tool metadata, arguments, correlated redacted result/error |
| content ↔ service worker | extension-owned validated channel | stale/forged sender context | schema-valid run messages bound to tab/document |
| service worker ↔ execution tab | coordinator | mutable site DOM | one validated step command; bounded effect/result |
| browser ↔ registry | local extension | network/server compromise | published JSON plans and redacted observations; no secrets |
| ambient capture ↔ parser | sanitizer/validator | model provider and page text | current sanitized semantic XML, one causal observation, compact prior semantics |
| parser ↔ Universal DB | revision validator | model output and network | validated action-map patch/revision plus safe evidence metadata only |

Data classes:

- **public contract**: tool names, descriptions, input schema, supported origin;
- **execution-sensitive**: invocation arguments and extracted result; local to
  run unless explicitly returned to the caller;
- **secret**: credentials, cookies, payment data, tokens; never collected or
  transported;
- **diagnostic**: IDs, timings, error codes, match counts; may be aggregated;
- **ambient source material**: current sanitized semantic XML and one causal
  observation, held only in the local retry spool for at most 24 hours and never
  stored in Universal DB;
- **safe learning metadata**: scope/layer IDs, digests, evidence handles,
  binding roles, parser/validator versions, and provenance; may be retained with
  immutable revisions.

## 9. Error contract

All public failures include `code`, human-readable `message`, nullable `stepId`,
`retryable`, and bounded `observed` metadata. Meanings are stable:

- `POLICY_BLOCKED`: registration or execution is not currently authorized;
- `PLAN_NOT_FOUND`: exact list/action revision cannot be resolved;
- `PLAN_VERSION_MISMATCH`: digest/version differs from the request;
- `INVALID_ARGUMENTS`: invocation failed the tool input schema;
- `PRECONDITION_FAILED`: route/state/page did not match the action domain;
- `TARGET_NOT_FOUND`: no locator fallback resolved;
- `TARGET_AMBIGUOUS`: a one-target locator resolved multiple elements;
- `TARGET_NOT_INTERACTABLE`: unique target is hidden, disabled, or obstructed;
- `POSTCONDITION_FAILED`: operation occurred but declared success did not;
- `NAVIGATION_OUT_OF_SCOPE`: page crossed the origin allowlist;
- `CONFIRMATION_REQUIRED`: run cannot advance without explicit decision;
- `CONFIRMATION_DENIED`: user denied the exact pending effect;
- `CANCELLED`: cancellation was observed before another step began;
- `TIMEOUT`: bounded readiness, locator, effect, or action duration expired;
- `EXECUTION_TAB_CLOSED`: required tab no longer exists;
- `TRANSPORT_DISCONNECTED`: channel could not recover inside its budget;
- `INTERNAL_ERROR`: implementation defect or unclassified failure.

Only these retry cases are automatic: a safe action before any consequential
effect, or an idempotent message delivery whose matching command/event digest
is already known. `POSTCONDITION_FAILED` on an external-state write is uncertain
and requires user inspection, not an automatic click replay.

## 10. Integration acceptance contract

The overnight MVP is complete only when all of these pass from a clean checkout:

1. contract schemas and positive/negative fixtures validate in JS and Go;
2. owned-demo search appears as a WebMCP tool after injection;
3. invocation opens an inactive execution tab and returns structured products;
4. there is no 200 ms polling in the run result path;
5. service-worker restart during navigation resumes the run or returns one
   typed failure without repeating the click;
6. ambiguous and missing locators fail with the correct code;
7. cancellation settles the tool promise and stops future steps;
8. a consequential demo action pauses at confirmation;
9. seeded secrets never appear in semantic XML, observations, model payloads,
   messages, logs, Universal DB writes, or run observations;
10. an initial semantic layer produces executable inferred actions without a
    goal or user-operated recording flow;
11. an observed event/result layer upgrades and composes actions through an
    idempotent action-map revision;
12. the event ledger is visible in the demo so the audience can see how a tool
    call becomes actor steps and verified effects;
13. all existing repository tests continue to pass.

Amazon and Devpost are compatibility targets after the owned-demo vertical
slice. They may expose missing primitives or locators, but they must not weaken
policy, confirmation, privacy, or deterministic execution contracts.
