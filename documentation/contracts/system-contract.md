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
- the existing `learning-trace/3` validator for captured evidence;
- the existing `action-map/1` validator for the learned graph.

## 1. Product boundary

The system has two pipelines joined by one publication gate:

```text
LEARN
observed browser session
  -> learning-trace/3
  -> deterministic transition graph
  -> action-map/1 candidate
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

The publication gate is the trust boundary. AI output may propose labels,
arguments, locators, and action boundaries on the learn side. No AI output is
directly executable. The ready path consumes only a validated, immutable,
published action-list revision.

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

### Deliberate non-goals for the first integrated slice

- arbitrary sites, arbitrary DOM scripts, CAPTCHA solving, anti-bot bypasses;
- cross-origin iframe automation, file uploads, downloads, clipboard control;
- autonomous purchases or irreversible submission without confirmation;
- perfect locator healing after an unseen redesign;
- distributed workers or a cloud queue before one browser can finish one run;
- a custom action language. JSON remains canonical; readable text is a view.

## 2. Canonical artifacts

### 2.1 Learning trace: `learning-trace/3`

Producer: recorder and client sanitizer.

Consumers: trace intake, graph builder, semanticizer, replay diagnostics.

Contract:

- ordered `page -> action -> update -> page` frames;
- stable frame and evidence IDs;
- URLs reduced to approved structure;
- semantic element metadata rather than a raw DOM snapshot;
- user-entered values replaced by typed placeholders before upload;
- deterministic chronology independent of the later AI interpretation.

The trace is evidence. It is append-only after session finalization. A model may
refer to evidence IDs but may not rewrite the evidence.

### 2.2 Action map: `action-map/1`

Producer: graph builder plus optional semanticizer.

Consumers: observed-plan compiler, review UI, learning visualizer.

Contract:

- nodes represent observed page states;
- edges represent observed actions and subsequent updates;
- each edge points to the exact evidence that supports it;
- parameter candidates distinguish demonstrated literals from inferred inputs;
- confidence is advisory metadata, never authority to execute.

The action map is the editable learning model. It may contain unpublishable
candidates. It is not the object registered as WebMCP tools.

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

### L1. Browser recorder

Responsibility: deterministically capture page/action/update/page chronology and
stable semantic evidence IDs from direct user activity.

Inputs: user-generated browser events and DOM/navigation observations.

Outputs: local trace frames awaiting sanitization.

Invariants:

- capture happens only in an explicit learning session;
- recorder labels observed facts, never invents action intent;
- event order is deterministic even when MutationObserver and navigation events
  race;
- synthetic events generated by replay are marked and excluded from learning.

Acceptance tests: input, click, Enter submit, SPA mutation, full navigation,
repeated actions, session stop, and required frame ordering.

### L2. Client privacy filter

Responsibility: remove or tokenize sensitive values before evidence can leave
the browser.

Inputs: local trace frames and explicit session consent.

Outputs: sanitized `learning-trace/3` plus a local-only redaction ledger.

Default removals:

- input/textarea/content-editable values;
- cookies, storage values, authorization headers, and hidden inputs;
- email, phone, address, payment, account, and credential-like literals;
- DOM attributes not on the semantic allowlist;
- page text outside the bounded target/context allowlist.

The filter replaces demonstrated inputs with typed placeholders such as
`{{arg.query}}`; it does not send the original value to enable later naming.

Acceptance tests: seeded secrets in text, attributes, URL parameters, forms,
and mutation payloads are absent from serialized traces.

### L3. Trace intake and server privacy filter

Responsibility: authenticate the local client if enabled, enforce size and
schema limits, repeat sanitization, and store immutable accepted evidence.

Inputs: sanitized trace.

Outputs: accepted session ID or field-addressed rejection.

Invariants: server filtering is defense in depth; invalid chronology fails;
unknown fields fail; raw rejected bodies are not logged; model requests receive
only the accepted minimized trace.

Acceptance tests: malformed order, oversized trace, unknown version, injected
secret, invalid URL, duplicate evidence ID.

### L4. Deterministic graph builder

Responsibility: reconstruct observed page states and action transitions without
an LLM.

Inputs: accepted learning trace.

Outputs: evidence-backed graph skeleton.

Invariants: every node and edge references source evidence; action precedes its
update; uncertain boundaries are preserved as uncertainty instead of guessed;
identical normalized states may be merged only under documented rules.

Acceptance tests: known owned-storefront trace produces expected nodes and
edges; shuffled or missing frames fail; repeated visits preserve transition
counts.

### L5. Semanticizer

Responsibility: propose human-readable state/action names, argument boundaries,
descriptions, and locator rankings from minimized evidence.

Inputs: graph skeleton and approved semantic evidence only.

Outputs: candidate `action-map/1`, never executable runtime messages.

Invariants:

- structured model response is schema validated;
- every proposal cites existing evidence IDs;
- it cannot add an unobserved external-state effect;
- guardrails forbid requesting or reconstructing redacted values;
- model/provider, prompt version, and response digest are recorded.

Acceptance tests: invalid JSON, invented evidence, invented state, prompt
injection in page text, provider timeout, and deterministic fixture response.

### L6. Observed-plan compiler

Responsibility: compile an action-map candidate into `action-list/1` without
changing primitive meaning.

Inputs: action map, policy template, supported runtime profile.

Outputs: candidate action list or compilation diagnostics.

Compiler checks:

- each action has a recognizable entry state and terminal success condition;
- parameter sources map to declared tool inputs;
- locator fallbacks are supported and reject generated-selector patterns;
- every mutating step has a postcondition;
- output fields remain scoped to their item;
- safety class is at least as restrictive as observed effects;
- provenance links survive compilation.

Acceptance tests: owned search compiles; missing effect, unknown argument,
unsupported primitive, ambiguous locator, and unsafe classification fail.

### L7. Candidate replay and publication gate

Responsibility: execute candidates on the owned demo, compare actual effects to
the evidence contract, require review where configured, and publish immutable
revisions.

Inputs: candidate action list, typed fixture arguments, expected state/result
assertions, policy decision.

Outputs: replay report and reviewed/published revision.

Minimum publication predicate:

```text
schema_valid
AND semantic_rules_valid
AND policy_allowed
AND privacy_scan_clean
AND replay_successful
AND required_review_approved
```

Replay failure never silently patches and publishes a locator. It creates a new
candidate revision with the failure evidence attached.

Acceptance tests: stable demo success; locator ambiguity; wrong output; stale
candidate digest; policy revoked during review; confirmation boundary absent.

### L8. Drift monitor and quarantine

Responsibility: aggregate privacy-safe run health and disable a revision whose
observed behavior no longer satisfies its contract.

Inputs: run observations and explicit user reports.

Outputs: health state `healthy | degraded | quarantined`, reason, and candidate
relearning request.

Invariants: no extracted result content in telemetry; failures are grouped by
list digest/action/error code; quarantine stops new registration; no autonomous
republish after relearning.

Acceptance tests: repeated target-not-found crosses configured threshold;
isolated user cancellation does not; a new revision starts with independent
health.

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

1. User starts an explicit learning session on an allowed owned/test site.
2. Recorder emits deterministic local frames while the user demonstrates the
   task.
3. Client filter sanitizes each frame before serialization.
4. Trace intake validates chronology and sanitizes again.
5. Graph builder produces observed states and transitions.
6. Semanticizer proposes names, parameter boundaries, and tool descriptions,
   each tied to evidence.
7. Compiler produces a candidate action list.
8. Contract validator and privacy scanner reject unsupported or unsafe plans.
9. Replay executes the candidate against the owned demo with fixture arguments.
10. Review UI displays readable steps, safety boundary, evidence, and replay
    result.
11. Publication service writes an immutable published revision and digest.
12. Ready-path discovery can now expose its tools.

This sequence is the presentation's live learning map: show the evidence graph
being built first, then the candidate action becoming publishable only after
validation and replay.

## 8. Trust boundaries and data classes

| Boundary | Trusted side | Untrusted side | Allowed crossing |
|---|---|---|---|
| page world ↔ isolated content | extension bridge | host page/main-world shim | public tool metadata, arguments, correlated redacted result/error |
| content ↔ service worker | extension-owned validated channel | stale/forged sender context | schema-valid run messages bound to tab/document |
| service worker ↔ execution tab | coordinator | mutable site DOM | one validated step command; bounded effect/result |
| browser ↔ registry | local extension | network/server compromise | published JSON plans and redacted observations; no secrets |
| learning evidence ↔ model | sanitizer/validator | model provider and page text | minimized semantic evidence IDs/labels only |

Data classes:

- **public contract**: tool names, descriptions, input schema, supported origin;
- **execution-sensitive**: invocation arguments and extracted result; local to
  run unless explicitly returned to the caller;
- **secret**: credentials, cookies, payment data, tokens; never collected or
  transported;
- **diagnostic**: IDs, timings, error codes, match counts; may be aggregated;
- **learning evidence**: sanitized semantic frames, retained only under the
  session's explicit retention policy.

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
9. seeded secrets never appear in traces, model payloads, messages, logs, or
   run observations;
10. one demonstration produces trace -> graph -> candidate -> replay ->
    published action list -> registered tool;
11. the event ledger is visible in the demo so the audience can see how a tool
    call becomes actor steps and verified effects;
12. all existing repository tests continue to pass.

Amazon and Devpost are compatibility targets after the owned-demo vertical
slice. They may expose missing primitives or locators, but they must not weaken
policy, confirmation, privacy, or deterministic execution contracts.
