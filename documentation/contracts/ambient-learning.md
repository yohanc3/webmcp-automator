# Ambient WebMCP learning contract

Status: frozen implementation boundary for fully automatic learning.

This contract replaces the earlier goal-led recording flow. The extension learns
continuously from eligible browser activity without asking the user to name a
goal or operate a recording control. `start` and `stop` remain internal
lifecycle primitives used for document attachment, policy changes, extension
suspension, and teardown. They are not product actions exposed to the user.

The contract introduces three envelopes without changing either executable
artifact schema:

- [`ambient-parse-request.schema.json`](ambient-parse-request.schema.json)
  carries one completed semantic layer, its causal observation when present,
  and compact prior parsed context;
- [`action-map-patch.schema.json`](action-map-patch.schema.json) is the strict
  AI response for that layer;
- [`action-map-revision.schema.json`](action-map-revision.schema.json) records
  deterministic compare-and-append application of the patch.

The materialized map remains `action-map/1`. Its published runtime projection
remains `action-list/1`. There is no learned internal model, latent goal object,
session objective, or second action representation.

## 1. Source material and authority

The only semantic source material available to the parser is:

1. the current sanitized `semantic-ui/2` XML page map;
2. the sanitized, causally ordered user observation that produced the current
   layer, when one exists; and
3. compact parsed context derived from accepted prior action-map revisions.

Page text is untrusted content. The parser receives no raw HTML, screenshots,
cookies, storage, headers, form values, private browsing history, user-supplied
goal, or runtime secrets. The parser may interpret visible semantics, but it may
not invent a DOM target, event, transition, field, hidden API, or page state.

Authority is ordered as follows:

1. policy and privacy gates decide whether capture is allowed at all;
2. semantic XML establishes visible nodes, labels, structure, fields, and
   evidence IDs;
3. an observation establishes that a user event caused a resulting semantic
   update or navigation;
4. verification evidence establishes that an executable action succeeded;
5. AI supplies only the semantic interpretation and incremental proposal;
6. deterministic validators and compare-and-append persistence decide whether
   the proposal becomes the next action-map revision.

AI output is never accepted as evidence about what happened.

## 2. Ambient lifecycle

For each top-level document, the extension implements this internal lifecycle:

```text
policy_check(origin, route, ambient_learn)
  -> denied: do not attach capture
  -> allowed: attach privacy-filtered semantic observer
  -> complete initial semantic layer
  -> enqueue parse immediately
  -> observe eligible user event
  -> causally settle its semantic update/navigation
  -> complete resulting semantic layer
  -> enqueue parse immediately
  -> repeat until document teardown, policy revocation, or extension shutdown
```

`start(document)` may run only after a current `allowed` decision. `stop(reason)`
disconnects observers, clears incomplete raw event material, and preserves only
already sanitized retry envelopes under the retention rules below. Neither
primitive appears in the popup as a learning button and neither creates a
user-visible “recording session.”

Synthetic events emitted by the deterministic actor are marked before event
dispatch and excluded from ambient capture. Background tabs opened by the actor
are excluded unless a separate policy explicitly allows learning there.

## 3. Completed meaningful semantic layers

A layer is complete and meaningful when any one deterministic boundary occurs:

- the initial top-level document reaches semantic readiness;
- a captured user event reaches mutation quiet and yields its resulting page
  map, including a same-URL update;
- a captured user event completes a top-level navigation and the destination
  page reaches semantic readiness; or
- a captured user event completes a same-document route transition and the
  resulting page map reaches semantic readiness.

Every such layer is parsed. There is no novelty score, confidence threshold,
minimum event count, “enough evidence” gate, timer batch, or user goal gate.
Mutation quiet is only a causal completion mechanism; it is not a decision
about whether a layer deserves parsing.

Exact duplicate delivery may be deduplicated only by the complete idempotency
tuple. A new user observation still creates and parses a new layer even when
its semantic XML digest equals the prior layer. Lifecycle noise with no user
observation, the same layer ID, the same sequence, and the same digest is a
retry, not a new layer.

Layer sequences are monotonically increasing within one normalized site scope.
The initial layer has no observation. Every later layer includes the one
sanitized observation whose outcome completed that layer. Causal order is:

```text
prior layer -> user event -> semantic update/navigation -> current layer
```

## 4. Parse request

An `ambient-parse-request/1` is immutable. Its minimum semantic content is:

```json
{
  "schemaVersion": "ambient-parse-request/1",
  "requestId": "parse_orders_002",
  "idempotencyKey": "sha256:<request-key>",
  "attempt": 1,
  "retryOf": null,
  "siteScope": {
    "scopeId": "amazon_account",
    "origin": "https://www.amazon.com",
    "routePatterns": ["^/$", "^/gp/your-account/order-history"]
  },
  "layer": {
    "layerId": "layer_orders_002",
    "sequence": 2,
    "url": "https://www.amazon.com/gp/your-account/order-history",
    "semanticXmlVersion": "semantic-ui/2",
    "semanticXmlDigest": "sha256:<xml-digest>",
    "semanticXml": "<semantic-ui>...</semantic-ui>",
    "evidenceIds": ["node_orders_heading", "node_order_list"]
  },
  "observation": {
    "observationId": "obs_open_orders",
    "eventSequence": 1,
    "fromLayerId": "layer_orders_001",
    "kind": "click",
    "targetEvidenceId": "node_orders_link",
    "argumentTokens": [],
    "outcome": {
      "kind": "navigation",
      "evidenceIds": ["update_orders_navigation"]
    }
  },
  "mapBase": {
    "revision": 1,
    "digest": "sha256:<map-digest>",
    "previousLayerSequence": 1
  },
  "context": {
    "states": [],
    "actions": []
  },
  "parser": {
    "parserId": "ambient_action_parser",
    "parserVersion": "1.0.0",
    "promptVersion": "ambient-v1",
    "outputSchemaVersion": "action-map-patch/1"
  },
  "policy": {
    "decisionId": "policy_amazon_ambient",
    "status": "allowed",
    "scope": "ambient_learn",
    "checkedAt": "2026-09-03T12:00:00Z"
  },
  "privacy": {
    "sanitizerVersion": "semantic-sanitizer/1",
    "redactionCount": 4,
    "redactionDigest": "sha256:<redaction-digest>",
    "categories": ["form_values", "account_identifiers"],
    "rawPersisted": false
  }
}
```

The idempotency key is the SHA-256 digest of the RFC 8785 canonical JSON array
containing these values in this order:

```text
siteScope.scopeId
layer.sequence
layer.url
layer.semanticXmlDigest
canonical sanitized observation or null
mapBase.revision
mapBase.digest
parser.parserId
parser.parserVersion
parser.promptVersion
```

`attempt` is transport metadata and is excluded from that tuple. An exact retry
keeps the request ID and idempotency key and increments `attempt`. A reparse
after a base conflict creates a new request ID and key, sets `retryOf` to the
conflicted request, and supplies the current map base and compact context.

### Compact context

Context is a projection, not a history replay. For each retained action it
contains only:

- action identity and human title;
- semantic precondition and effect;
- input names/types/requiredness;
- output mode and field names;
- safe evidence handles; and
- current provenance: `inferred`, `observed`, or `verified`.

It contains no expanded steps, locators, literal target labels, semantic XML,
or raw observations. The complete steps, locators, and target evidence IDs stay
on the stored action-map entry and its revision evidence bindings. The parser
service may retrieve one expanded prior entry only when resolving an explicit
conflict or composing that named entry, and must record that retrieval in the
revision validator log. Expanded entries are never sprayed across all future
prompts.

## 5. AI patch and executable-action rule

The parser returns exactly one `action-map-patch/1` document. `decision: patch`
may upsert states and actions. `decision: no_change` has an empty operations
array, a reason, and citations proving the layer was parsed even though it
changed no accepted semantics. The parser may not delete history, publish an
action list, change policy, or execute a step.

Every `upsert_action` contains a complete action that can be materialized into
the existing `action-map/1` shape. The ambient parser profile is stricter than
the broad action-map schema:

1. `steps` contains at least one executable primitive;
2. status is `resolvable` or `observed`, never `unresolved`;
3. every click step has a `target` binding to a semantic XML node/evidence ID;
4. every extraction output field has an evidence-backed locator and `output`
   binding;
5. every effect or navigation expectation cites current or prior evidence;
6. every evidence binding resolves to the current layer, its observation,
   prior compact evidence handles, or separately accepted verification data;
7. the action's existing `evidence` array retains compact binding tokens such
   as `layer_orders_001:node_orders_link:step_0_target`; and
8. `missingEvidence` is empty. If no executable action can be supported, the
   parser emits state updates only, or `no_change` when even the state is already
   represented; it does not emit a speculative action.

`stepEvidence` in the patch is the normalized sidecar index for deterministic
validation. `action.evidence` is the compatible representation retained inside
the `action-map/1` entry. The sidecar is stored as safe evidence metadata with
the revision; it does not change `action-map/1`.

The patch schema deliberately validates only the shared minimum of an action
candidate. After applying operations to a copy of the base map, the complete
result must pass the canonical `action-map/1` schema and Go semantic validator.
This avoids copying and drifting the action-map schema into the patch contract.

### Page-only inference

A page layer may produce actions without a preceding user observation:

- a semantic link with `ref="node_orders_link"`, accessible name `Orders`, and
  a same-origin `href` can produce an executable `Open orders` click action;
- an Orders page with a repeated semantic order collection can produce an
  executable `Get recent orders` extraction action; and
- an X Posts page with repeated semantic articles can produce an executable
  `Get recent posts` extraction action.

These actions have `inferred` provenance even though their steps are executable.
They become `observed` only when causal evidence connects the event to its
effect. They become `verified` only after deterministic replay or a successful
ready-path run validates their declared postconditions and output.

Confidence is advisory and never blocks parsing. Durable ready-path outcomes
adjust it on the exact action version. A successful fallback locator can repair
the next map revision, while repeated target or postcondition failures make the
action unresolved. Each applied observation produces a newly bound candidate
for review when at least one action remains runtime eligible. Confidence is not
a substitute for provenance or evidence.

## 6. Observed paths and composition

An observation may upgrade an existing inferred action, connect state nodes,
or support a new composite action. Composition copies the ordered executable
steps into a normal action-map entry; runtime never recursively invokes one
learned action from another.

For example:

```text
account_home
  -- inferred Open orders / click node_orders_link --> unknown

observed click node_orders_link + navigation + orders_page
  => Open orders becomes observed: account_home -> orders
  => Orders page yields inferred Get recent orders / extract node_order_list
  => ordered path can yield observed composite Get recent orders:
       click Orders -> wait for Orders -> extract order collection
```

`componentActionIds` records composition lineage in the patch/revision sidecar.
The composed action itself contains the complete flattened steps and evidence
tokens required by `action-map/1`. The compiler may later project either the
page-local extraction or the higher-level composed action into `action-list/1`
according to route/precondition coverage. Internal navigation may therefore be
hidden under the higher-level user-facing action without becoming hidden
execution logic.

## 7. Provenance transitions

Provenance is monotonic for the same semantic action and evidence lineage:

```text
inferred -> observed -> verified
```

- `inferred`: executable entirely from one or more semantic XML layers, with no
  causal observation proving the effect;
- `observed`: a causally ordered sanitized observation connects the action's
  source, event, update/navigation, and destination layer;
- `verified`: deterministic replay or a ready-path run satisfies the exact
  action version's preconditions, postconditions, and output contract.

An AI parse may propose `inferred` or `observed`. It may preserve `verified`
from compact prior context. It may not create `verified` unless a cited
verification record was supplied outside ordinary ambient source material.
A changed step, locator, effect, or output starts a new action version at no
higher than `observed`; verification does not transfer automatically.

The existing action map represents execution readiness through `status`:

| Revision provenance | `action-map/1` status |
|---|---|
| inferred executable | `resolvable` |
| observed executable | `observed` |
| verified executable | `observed`, plus verified revision metadata |

The existing action list represents review/publication through `lifecycle` and
its existing provenance block. No schema change is required.

## 8. Compatibility proof for existing action schemas

No `action-map/1` or `action-list/1` field is changed by this contract:

1. `action-map/1` already expresses the supported primitives, locator evidence,
   expectations, output mode/fields, source/destination states, parameters, and
   at least one step for `resolvable`/`observed` actions. The ambient patch
   profile simply forbids its legacy zero-step `unresolved` option.
2. Stable semantic target IDs fit in the existing action `evidence` strings.
   The normalized `stepEvidence` index and inferred/observed/verified state are
   revision metadata, not new action-map fields.
3. The deterministic action-list compiler assigns existing step IDs,
   cardinality, condition sets, safety/runtime blocks, and typed tool metadata;
   it does not need a new primitive or locator shape for the X/Orders examples.
4. A page-only inferred map action is executable but is not publishable until
   deterministic verification supplies step effects and outputs. Verification
   emits an evidence trace using the existing transition reference shape. A
   read/extract verification may use a same-page transition whose update is
   `no_visible_change`; it is still a factual executed step, not fabricated
   user evidence.
5. `action-list/1` step evidence cites that observed or verification trace.
   `publication.sourceMapId` points to the exact map revision, while Universal
   DB revision metadata preserves the more precise ambient provenance. The
   action-list provenance `source` remains the existing coarse evidence-source
   category.

Therefore page-only inference, observed linkage, verification, composition,
and publication are expressible without changing either schema. If a future
action cannot compile without inventing an evidence transition, it remains an
action-map candidate; that is a publication blocker, not permission to weaken
the schema.

## 9. Idempotent patch application and conflicts

Persistence applies a patch with compare-and-append semantics:

For a new site scope, revision 0 is a deterministic in-memory seed, not a
stored valid map: `schemaVersion` is `action-map/1`; `site.origin` comes from
the request; `site.observedUrls` is empty; `summary` is `Ambient actions for
<scopeId>`; states/actions/warnings are empty; and privacy contains zero
redactions, no categories, and the fixed policy text `Policy-gated semantic
sanitization before model transfer.` Each applied layer appends its normalized
`layer.url` to `site.observedUrls` if absent (keeping the 12 most recent), adds
its `privacy.redactionCount`, and unions its redaction categories. These root
updates are deterministic and are not AI patch operations.

Canonical map and request digests use RFC 8785 JSON Canonicalization Scheme
bytes encoded as UTF-8, then SHA-256 rendered as lowercase
`sha256:<64-hex-digits>`. XML digests use the exact UTF-8 sanitized XML string
carried in `layer.semanticXml`; producers do not reformat it after hashing.

1. validate the request/patch binding, parser versions, site scope, layer
   sequence, and idempotency key;
2. load the exact base revision and digest;
3. resolve every citation and step evidence binding;
4. apply operations in canonical order to an in-memory copy;
5. validate every AI action against the ambient executable-action rules;
6. validate the complete materialized map as `action-map/1`;
7. run privacy and literal-value scanning;
8. canonicalize JSON, calculate the result digest, and append one immutable
   revision transactionally; and
9. return `action-map-revision/1`.

The canonical operation order is states by `entityId`, then actions by
`entityId`. Before digesting, the materialized map's `states` and `actions`
arrays are also sorted by `id`, `site.observedUrls` is in first-observed order,
and privacy categories are sorted lexicographically. Duplicate entity IDs or
two operations for the same entity in one patch are rejected.

Outcomes:

- `applied`: a new revision was appended;
- `duplicate`: the same idempotency key and canonical request digest already
  produced the same patch/result; return the original receipt;
- `no_change`: the layer was parsed and accepted, no operations were proposed,
  and the current revision/digest are returned without appending a revision;
  `storage.actionMapRevisionStored` is false, while the safe idempotency receipt
  may be retained;
- `conflict`: the site scope's current revision/digest differs from the base;
  no operation is applied and the caller reparses the same layer against fresh
  compact context; or
- `rejected`: shape, evidence, privacy, executable-action, provenance, or
  action-map validation failed; no revision is appended.

Reusing an idempotency key with different canonical input is
`IDEMPOTENCY_KEY_REUSED`, not a retry. A stale layer sequence is
`LAYER_SEQUENCE_STALE`. Conflicts never perform a blind last-write-wins merge.

## 10. Storage and Universal DB boundary

The shared Universal DB may store only:

- immutable `action-map/1` revisions and canonical digests;
- immutable `action-list/1` revisions and publication metadata;
- parser/validator version identifiers;
- site scope IDs and normalized origin/route scope;
- action/state provenance transitions;
- evidence IDs, layer sequence, content digests, binding roles, and redaction
  category counts; and
- privacy-safe aggregate verification/run health.

It must not store semantic XML, raw or sanitized event streams, page text,
typed values, full URLs with query/fragment, DOM snapshots, screenshots,
cookies, storage, headers, account/order identifiers, private browsing history,
or model prompts/responses containing page material.

Retention is explicit:

| Material | Location | Retention |
|---|---|---|
| raw DOM/event/value material | extension memory only | never persisted; discard immediately after sanitized projection, or within 30 seconds if a layer cannot complete |
| sanitized semantic XML + sanitized observation | local encrypted retry spool | delete after an applied/duplicate/no-change receipt and safe metadata extraction; hard TTL 24 hours |
| parser request/response body | in-flight parser process memory | do not log or persist; discard after receipt/rejection |
| safe evidence metadata | Universal DB | revision retention policy |
| action-map/list revisions | Universal DB | immutable revision retention policy |

The local retry spool is not the Universal DB and is never synchronized. Debug
export requires a separate explicit user action and is outside ambient default
behavior.

## 11. Policy and privacy order

The order is fail-closed:

```text
current policy decision
  -> attach capture with structural allowlist
  -> remove/exclude private fields during projection
  -> sanitize URL/text/attributes and tokenize input values
  -> validate sanitized layer and observation
  -> create local retry envelope
  -> transfer to parser
```

Policy is checked before observer attachment and again before parser transfer.
Revocation stops capture, deletes incomplete raw state, and prevents queued
transfer. Privacy is applied while constructing the semantic projection, not
after serializing a raw DOM snapshot. The server/parser boundary repeats
validation and redaction scanning as defense in depth.

## 12. Independent owner interfaces

### Capture owner

Produces ordered, sanitized `ambient-parse-request/1` source fields through a
local queue. Owns policy-before-attach, structural privacy, causal settlement,
layer sequence, internal start/stop, raw-memory deletion, and local spool TTL.
Does not call persistence directly or construct action-map actions.

Handoff: `CompletedLayer {siteScope, layer, observation, policy, privacy}`.

### AI parser/compiler owner

Combines the completed layer with the exact map base and compact context,
invokes the model once per completed layer, validates `action-map-patch/1`, and
submits the patch. Owns evidence binding, page-only inference, observed linkage,
composition, and the compact-context projection. Does not skip layers based on
novelty/confidence and does not publish action lists.

Handoff: `ParseRequest -> Patch | typed rejection`.

### Persistence/API owner

Owns compare-and-append, canonical digesting, immutable revisions, duplicate
receipts, conflicts, safe evidence metadata, and compact-context reads. It
never accepts page history or semantic XML for durable storage.

Minimum API:

```text
GET  /v1/action-maps/{scopeId}/head
GET  /v1/action-maps/{scopeId}/context?revision=<n>
POST /v1/action-maps/{scopeId}/patches
GET  /v1/action-maps/{scopeId}/revisions/{revision}
```

### Policy UI owner

Shows whether ambient learning is allowed, blocked, or paused by policy and
allows site-scope review/revocation. It does not expose goal, record, start, or
stop controls. It may expose local spool deletion and provenance/revision
inspection without showing private event history.

### Integration owner

Wires queues, API adapters, schema registries, and tests. It does not redefine
layer completion, evidence semantics, retention, or conflict behavior. The
integration branch owns shared bootstraps and test indexes.

## 13. Deterministic acceptance tests

Independent implementations are compatible only if these pass:

1. initial page XML with no observation is parsed and yields executable
   page-inferred actions;
2. every completed layer creates one parse request and one receipt, including
   equal XML digests after distinct user observations; a `no_change` parse does
   not create a revision;
3. no request has a goal field or expanded prior action steps/locators;
4. every AI action contains at least one step and no `unresolved` status;
5. each click step binds to a semantic node/evidence ID retained on the action;
6. each extraction field resolves to evidence-backed output locators;
7. Orders link XML yields `Open orders`; Orders page XML yields page-local
   `Get recent orders`;
8. the observed Orders navigation upgrades provenance and produces a flattened
   higher-level `Get recent orders` composite;
9. an invented node, missing step, missing output field binding, or private
   literal rejects the entire patch;
10. an exact retry returns the original receipt without adding a revision;
11. a stale base returns a conflict and applies nothing;
12. two concurrent patches on one base have one winner and one conflict;
13. raw/sanitized history and XML are absent from Universal DB writes; and
14. accepted map/list fixtures continue to validate as `action-map/1` and
    `action-list/1` without schema changes.

Conformance examples:

- [`examples/x-posts.layer-001.parse-request.json`](examples/x-posts.layer-001.parse-request.json)
  and
  [`examples/x-posts.layer-001.patch.json`](examples/x-posts.layer-001.patch.json)
  show actions inferred from a page layer alone;
- [`examples/orders.layer-001.parse-request.json`](examples/orders.layer-001.parse-request.json)
  through
  [`examples/orders.layer-002.patch.json`](examples/orders.layer-002.patch.json)
  show compact context propagation, observed linkage, and composition; and
- the matching revision receipts show compare-and-append and the no-history
  Universal DB boundary.
