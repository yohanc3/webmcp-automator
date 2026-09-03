# MVP system contract

This document defines the overnight contract for learning and executing WebMCP
tools. It is deliberately narrower than a production automation platform.

## Decision

The product has two paths with one executable contract between them:

- the **learn path** automatically parses every eligible completed semantic
  page layer and incrementally revises a visible action map;
- the **ready path** exposes executable actions as WebMCP tools and interprets
  their deterministic steps in a separate browser tab.

There is no user-supplied learning goal and no hidden learned internal model.
The source material is the current sanitized semantic XML page map, the causal
sanitized user observation that led to it when present, and compact semantics
from prior accepted action-map revisions. AI incrementally proposes the visible
map; deterministic validation and persistence remain authoritative. AI is not
part of ready-path execution.

For this MVP, `action-map/1` is the canonical editable learning representation.
Published runtime capabilities are immutable `action-list/1` projections. The
paused `learned-adapter/1` representation is a migration format, not a second
source of truth; it must not evolve independently.

The detailed machine-readable schemas and component boundaries are in
[`contracts/`](contracts/), and the branch/worktree sequence is in
[`parallel-worktrees.md`](parallel-worktrees.md).
The automatic learning lifecycle, incremental request/patch/revision protocol,
and retention rules are normative in
[`contracts/ambient-learning.md`](contracts/ambient-learning.md).

## Current baseline

The repository baseline already has:

- a stepped `learning-trace/3` recorder;
- deterministic `page -> action -> update -> page` ordering;
- server-side trace validation, graph reconstruction, and sanitization;
- AI-assisted batched `action-map/1` discovery with strict output validation;
- a deterministic runner for `fill`, `click`, `press`, `wait`, and `extract`;
- an owned storefront for repeatable tests.

The ambient request/patch/revision contract is implemented alongside the
historical batched `learning-trace/3` compatibility and replay-fixture path.
Published action lists are discovered and registered directly by the source
bridge. Invocation is event-driven through the durable coordinator, isolated
execution actor, exact confirmation boundary, terminal acknowledgement, and
privacy-safe runtime feedback. Candidate replay uses a separate actor port and
private coordinator while sharing the same pinned execution protocol.

## Ready-path architecture

```mermaid
flowchart LR
  A[WebMCP-aware agent] -->|discover and invoke| W[WebMCP registration\nin source document]
  W -->|run.request| B[Source content bridge]
  B -->|validated extension message| C[MV3 job coordinator]
  C -->|load published plans| D[(Action map registry)]
  C -->|create inactive site tab| T[Execution tab]
  C -->|step.command| R[Deterministic actor runtime]
  R -->|step.event or page.ready| C
  C -->|run.result or run.error| B
  B -->|settle execute promise| W
```

### Ownership

1. **WebMCP registration** owns only tool lifecycle, input-schema exposure,
   cancellation, and promise settlement. It does not inspect or operate the
   target page.
2. **Source content bridge** is the trusted extension boundary in the calling
   tab. Prefer direct registration from the isolated content-script world when
   Chrome exposes `document.modelContext` there. If that is not discoverable by
   the WebMCP inspector, inject only a small main-world registration shim and
   treat every page-world message as untrusted.
3. **MV3 job coordinator** owns the persistent run state machine, execution-tab
   lifecycle, policy checks, cancellation, and result routing. It is an
   event-driven coordinator, not a long-lived worker process.
4. **Execution tab** is a real site document opened inactive in the user's
   browser profile. It owns page state and receives one deterministic command
   at a time.
5. **Actor runtime** resolves targets, executes primitives, verifies effects,
   and emits bounded observations. It does not call an LLM.
6. **Registry** stores versioned plans, policy decisions, provenance, and
   aggregate run health. It never sends arbitrary executable JavaScript to the
   extension.

An offscreen extension document is not the website execution surface. Chrome's
offscreen API is suitable for extension-owned DOM work, but the target site's
DOM, cookies, and application runtime belong in a real tab.

## Run state machine

The coordinator persists each transition before dispatching the next command:

```text
created
  -> policy_checked
  -> opening_tab
  -> waiting_for_page
  -> running_step[n]
  -> waiting_for_effect | waiting_for_navigation
  -> running_step[n + 1]
  -> extracting
  -> completed | failed | cancelled | awaiting_confirmation
```

No correctness rule may depend on an in-memory timer surviving service-worker
suspension. Navigation resumes from `PAGE_READY`; same-document operations
return a `STEP_COMPLETED` event; persisted state makes either event idempotent.

Every run has:

- `runId`, `requestId`, `planId`, and immutable `planVersion`;
- `sourceTabId`, `executionTabId`, and current `documentId`;
- `stepIndex`, status, timestamps, and cancellation state;
- a redacted event ledger and either a typed result or structured error.

## Messaging contract

Use events rather than 200 ms job polling. Extension-owned contexts use a named
`chrome.runtime.Port`; a main-world shim, if required, uses a minimal
`window.postMessage` bridge. Messages are JSON-serializable envelopes:

```json
{
  "protocol": "webmcp-run/1",
  "type": "run.request",
  "requestId": "req_...",
  "runId": "run_...",
  "sequence": 1,
  "sentAt": "2026-09-03T00:00:00Z",
  "payload": {}
}
```

Allowed message types are:

- `run.request`, `run.accepted`, `run.ack`, `run.cancel`;
- `page.ready`;
- `step.command`, `step.completed`, `step.failed`;
- `run.awaiting_confirmation`, `run.result`, `run.error`.

Receivers reject unknown protocol versions, message types, stale document IDs,
duplicate sequence numbers with different payloads, and payloads that do not
match their schema. Duplicate identical events are acknowledged without
repeating the action.

Every `run.request` pins the registered `listId`, `listRevision`, and
`listDigest`. The coordinator resolves that immutable registry revision rather
than whichever revision is newest when execution begins. Each `page.ready`
also reports deterministic actor evaluation of the entry precondition and any
pending navigation-step condition; the coordinator remains responsible for
binding those results to the current execution document.

Before dispatching a confirmed consequential step, the coordinator requires a
new `page.ready` sequence that matches the confirmation-bound URL, state, and
navigation sequence. A same-document SPA or DOM transition therefore cannot
reuse an approval that was presented for an earlier page attestation.

The bridge carries no API keys, database credentials, raw action maps, or
unredacted traces. The host page can observe and forge main-world messages, so
the isolated content script and service worker remain authoritative.

## Action-step representation

JSON is the canonical format for the MVP because it provides schema validation,
stable versioning, diffable review, and direct WebMCP input-schema projection.
Do not build a custom parser tonight. A compact language may later be generated
from JSON for reading and editing, but it must round-trip through the same JSON
schema.

An executable action is a partial state transition:

```text
plan(current_page, typed_arguments) -> typed_result | structured_error
```

It may run only when its site, route, state, policy, and safety guards hold.
Each mutating primitive must be followed by evidence that distinguishes success
from an unchanged or wrong page.

### Recommended shape

The existing `action-map/1` action is close. The execution projection should
retain the following semantics:

```json
{
  "schemaVersion": "action-plan/1",
  "id": "demo.search_products",
  "version": 1,
  "site": {
    "origin": "http://127.0.0.1:4317",
    "routePatterns": ["^/demo/?$"]
  },
  "tool": {
    "name": "search_products",
    "description": "Search the catalog and return matching products.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Catalog search text" }
      },
      "required": ["query"],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "untrustedContentHint": true
    }
  },
  "precondition": {
    "stateId": "catalog",
    "urlPattern": "^http://127\\.0\\.0\\.1:4317/demo/?$"
  },
  "steps": [
    {
      "id": "s1",
      "op": "fill",
      "target": {
        "cardinality": "one",
        "role": "searchbox",
        "name": "Search the catalog",
        "cssFallback": "#catalog-search"
      },
      "value": { "fromArgument": "query" },
      "expect": { "kind": "value_set" },
      "timeoutMs": 5000
    },
    {
      "id": "s2",
      "op": "click",
      "target": {
        "cardinality": "one",
        "role": "button",
        "name": "Search"
      },
      "expect": {
        "kind": "navigation",
        "urlPattern": "^http://127\\.0\\.0\\.1:4317/demo/search"
      },
      "timeoutMs": 10000
    },
    {
      "id": "s3",
      "op": "wait",
      "expect": {
        "kind": "collection",
        "target": { "role": "list", "name": "Search results" }
      },
      "timeoutMs": 10000
    }
  ],
  "output": {
    "mode": "collection",
    "item": { "role": "article" },
    "limit": 25,
    "fields": [
      { "name": "name", "locator": { "role": "heading" }, "required": true },
      { "name": "price", "locator": { "css": "[data-price]" }, "required": true },
      { "name": "url", "locator": { "role": "link" }, "attribute": "href", "required": true }
    ]
  },
  "safety": {
    "class": "read",
    "confirmation": "never",
    "idempotency": "safe"
  },
  "provenance": {
    "source": "demonstration",
    "observationCount": 1,
    "evidenceIds": ["transition_1", "transition_2"]
  }
}
```

The readable view is generated, for example:

```text
search_products(query) on catalog
  fill searchbox "Search the catalog" <- query
  click button "Search"
  expect navigation to /demo/search
  wait for collection "Search results"
  return each article { name, price, url }
```

### Primitive semantics

Keep the first execution profile small:

- `fill`: set a text, textarea, select, or content-editable value through the
  native setter and dispatch the expected input/change events;
- `click`: scroll one uniquely resolved target into view and invoke it;
- `press`: dispatch one allowlisted key to one target or the active element;
- `wait`: wait for a declared condition, never merely sleep for a guessed
  duration;
- `extract`: return a page object or repeated collection according to an output
  projection.

Add `select`, `check`, and `uncheck` only when a real target requires semantics
that `fill` cannot represent reliably. Keep uploads, downloads, clipboard,
cross-origin frames, and screenshots out of the first profile.

`send results` is a transport responsibility, not an actor primitive. `get
values` and `get items` are both `extract` with different output projections.

The screenshot experiment should return an opaque extension or server asset ID,
not a page-owned `blob:` URL. It needs an explicit capture boundary, short TTL,
access control, and a privacy review before it can leave the browser.

### Locator rules

- Resolve semantic evidence as a conjunction: role plus accessible name, label,
  placeholder, or stable attribute.
- CSS is an ordered fallback, not an automatic first choice when it looks
  generated.
- Every single-target operation requires exactly one visible, enabled match.
- Zero matches and ambiguous matches are different typed failures.
- Geometry may break ties only during learning; it is not a published locator.
- A model may select captured locator evidence by ID. It may not invent a
  selector string.

### Result and failure contract

Successful tools return JSON with `ok`, `runId`, `planVersion`, `data`, and a
bounded `evidence` summary. Failures return a code such as `POLICY_BLOCKED`,
`PRECONDITION_FAILED`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`,
`POSTCONDITION_FAILED`, `CONFIRMATION_REQUIRED`, `CANCELLED`, or
`EXECUTION_TAB_CLOSED`, plus `stepId` and redacted observations.

Do not silently choose the first target, retry a state-changing step after an
uncertain result, or claim success from the absence of an exception.

## Learn-path architecture

```mermaid
flowchart TD
  G[Policy gate before capture] --> R[Automatic privacy-filtered semantic observer]
  R --> L[Completed semantic XML layer]
  L --> O[Causal sanitized observation when present]
  O --> C[Current map base plus compact prior context]
  C --> P[AI incremental parser]
  P --> Q[Evidence and executable-action validation]
  Q --> A[Idempotent action-map revision]
  A --> X[Action-list compiler]
  X --> V[Replay, safety, and review]
  V --> U[Versioned publication]
  U --> M[Run health and provenance signals]
```

### Learning invariants

1. Capture chronology is deterministic. AI does not decide what happened.
2. Policy and privacy gates run before capture/model transfer; raw DOM and event
   values are never serialized for a later sanitizer.
3. Every completed meaningful layer is parsed. There is no novelty threshold,
   evidence-count threshold, user-operated recording flow, or goal gate.
4. Each parse receives the current sanitized semantic XML layer, the causal
   observation that produced it when present, and compact accepted context.
5. Page XML alone may yield actions. A semantic Orders link may yield `Open
   orders`; an Orders collection may yield `Get recent orders`.
6. Every AI-produced action is already executable with at least one step. Click
   targets and extracted fields bind to semantic node/evidence IDs retained on
   the map entry.
7. Observations connect inferred actions into reachable paths and may produce a
   flattened higher-level action whose internal navigation is an ordinary step.
8. Exact base revision/digest, parser version, evidence citations, provenance,
   retries, and conflicts are explicit and deterministically validated.
9. Read-only plans may be replay-tested automatically on owned fixtures. Write
   and danger plans require a sandbox or a human confirmation boundary.
10. Publication is versioned and reversible. Runtime failures can degrade or
   quarantine a version but cannot silently rewrite it.

The state model is a labeled directed multigraph. A node is a materially
distinct semantic page state. An action is an inferred, observed, or verified
executable transition/extraction with ordered primitives and postconditions.
Multiple actions may connect the same states, loops are valid, and an observed
path may be flattened into a composite action. A published action plan is a
guarded path through that graph, not free-form browser control.

## Privacy, terms, and safety gates

### Privacy

Do not remove all node values and attributes indiscriminately. That would also
remove accessible names, stable labels, result fields, and state evidence needed
to learn or execute the tool.

Use an allowlist instead:

- typed values become parameter placeholders in the browser before upload;
- passwords, payment fields, tokens, account identifiers, and form values stay
  local;
- only semantic attributes needed for resolution are retained;
- policy is allowed before capture attaches, and privacy exclusion occurs while
  the semantic projection is built;
- server-side sanitization repeats the checks before model calls;
- model-provider guardrails are defense in depth, not the privacy boundary;
- regression fixtures test that private values cannot cross either boundary.

Raw DOM/events are memory-only and never persisted. Sanitized semantic XML and
its one causal observation may remain in a local encrypted retry spool until an
applied/duplicate/no-change receipt, with a 24-hour hard TTL. Universal DB
stores only action-map/list revisions and safe evidence metadata; it never
stores semantic XML, raw or sanitized browsing observations, or private
history.

### Terms policy

A single `termsDoesNotDisallow` boolean is insufficient. Use a fail-closed,
versioned decision:

```json
{
  "status": "allowed | denied | unknown",
  "scope": ["learn", "inject", "read", "write", "danger"],
  "basis": "site_owner | written_permission | reviewed_terms | local_fixture",
  "evidenceUrl": "https://example.com/terms",
  "checkedAt": "2026-09-03T00:00:00Z",
  "expiresAt": "2026-10-03T00:00:00Z"
}
```

Unknown and expired decisions do not inject or learn. The overnight build uses
an explicit owned-origin allowlist; a universal reviewed registry can follow.

### Safety

- `read`: may execute without a product-level confirmation, though returned
  content remains untrusted;
- `write`: must show the exact intended mutation before the first committing
  step;
- `danger`: must hand off at the final boundary and require an explicit human
  confirmation immediately before purchase, deletion, submission, payment, or
  message sending.

## Overnight cut line

The credible target is one owned-site vertical slice, not Amazon and Devpost.

### Must work

1. Deterministically project one observed `action-map/1` action into the runtime
   adapter shape while preserving expectations.
2. Enable WebMCP registration on the owned demo and verify it with the inspector.
3. Replace source-page polling with run result events, or keep polling only as a
   temporary fallback behind the same message contract.
4. Execute `search_products(query)` in an inactive demo tab across navigation.
5. Return structured product JSON to the WebMCP caller.
6. Emit the run event ledger and one precise failure when a target or
   postcondition is wrong.
7. Demonstrate eligible page -> automatic semantic layer -> incremental map
   revision -> review -> publish -> invoke -> result on the owned storefront.

### Parallel tracks after this contract freezes

- **Track A — registration and transport:** WebMCP lifecycle, cancellation,
  run-event channel, and promise settlement.
- **Track B — actor and execution:** primitive semantics, target cardinality,
  postconditions, navigation resume, and structured extraction.
- **Track C — compiler and registry:** action-map-to-runtime projection,
  action-map compare-and-append, publication, origin/route matching, policy
  gate, safe evidence metadata, and versioning.
- **Track D — ambient capture:** policy-before-attach, semantic projection,
  causal observations, internal lifecycle, client sanitizer, and local retry
  retention.
- **Track E — incremental parser:** one parse per completed layer, compact
  context, executable evidence-bound patches, provenance upgrades, and path
  composition.
- **Track F — policy/review UI:** site-scope allow/block/revoke and revision
  review, with no goal, record, start, or stop control.
- **Track G — integration:** one fixed demo plan and the full browser smoke test.

The detailed dependency order and non-overlapping ownership are in
[`parallel-worktrees.md`](parallel-worktrees.md). All learning owners consume
`ambient-parse-request/1`, `action-map-patch/1`, and
`action-map-revision/1`; none may invent a parallel session/goal contract.

### Explicitly deferred

- Amazon search and ordering;
- Devpost automation;
- screenshots or temporary image URLs;
- multi-user universal publication;
- cross-device merging of private browsing observations;
- self-healing selectors;
- arbitrary-site write or danger actions.

These are later validations of the architecture, not prerequisites for proving
the architecture.
