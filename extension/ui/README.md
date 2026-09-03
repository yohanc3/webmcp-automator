# Policy and review UI

`policy-review.js` is a presentation and decision-capture boundary. It renders
current ambient policy, compact action-map provenance, candidate action-list
review, local retry-spool custody, and an exact pending confirmation. It does
not enforce policy, execute steps, delete local data, or write registry and
publication storage.

## Injected ports

`createController(...)` receives three interfaces. Integration owns their backing
messages and storage:

```js
const controller = WebMcpPolicyReview.createController({
  rootElement,
  coordinator: {
    getPolicyReviewState: async () => state,
    setOwnedDemoOverride: async (override) => response,
    submitCandidateReview: async (decision) => response,
    submitRunConfirmation: async (decision) => response,
    submitPolicyDecision: async (decision) => response,
  },
  registry: { openEvidence: async (reference) => response },
  retrySpool: {
    requestDeletion: async (request) => response,
  },
});
```

Rendering never submits a decision. Approve, deny, revoke, and deletion calls
happen only after a button click. Candidate review calls carry the exact list
ID plus both the source action-map and candidate action-list revision/digest
pointers. Confirmation calls carry the run ID, step ID, and separate binding:

```json
{
  "listDigest": "sha256:...",
  "stepId": "submit_order",
  "origin": "https://shop.example",
  "documentId": "document_1",
  "policyRevision": "policy_7"
}
```

The approval control becomes stale when any binding field changes or is absent.
Denial remains available because it cannot authorize execution. The coordinator
and registry must independently re-check all bindings and policy before acting.

## State adapter

`getPolicyReviewState()` returns a view model with these optional sections:

- `context`: current origin, requested scope, action-map/list digests, step ID,
  document ID, and policy revision;
- `policy`: the current policy-service result (`decision` or canonical `status`,
  explicit origin, optional revision, scopes, source/basis, checked/expiry
  times, and reason);
- `overrideAudit`: the current owned-demo override audit entry;
- `actionMap`: exact head revision/digest plus compact-context actions containing
  titles, semantics, `inferred`/`observed`/`verified` provenance, and safe
  evidence-handle IDs only;
- `candidate`: exact candidate identity, replay status/report, and canonical
  `actions[]` from `action-list/1`;
- `retrySpool`: local sanitized-envelope count and optional oldest/hard-expiry
  timestamps;
- `confirmation`: the pending run and step, argument preview, sensitive argument
  names, exact binding, and optional canonical step.

The popup currently adapts these ports to runtime messages. Until ready-path
integration handles those messages, the surface visibly reports `unknown` and
does not enable approval.

## Ambient-learning compatibility

`observationEligibility({ policy, origin, policyRevision, now })` is the small
integration hook for deciding whether automatic observation is eligible before
capture. It requests only the frozen `ambient_learn` scope and returns a frozen,
fail-closed view:

```js
{
  eligible: false,
  origin: 'https://shop.example',
  policyRevision: 'policy_7',
  reason: 'No policy decision exists.',
  state: 'unknown'
}
```

This is not a new recorder or learning protocol. Ambient-learning integration
can adapt its frozen contract to this function without changing the UI.

An allowed decision without its own valid origin fails closed; the active page
origin is never substituted for missing policy data. When both the policy and
current context supply a revision, those revisions must match. Revision remains
optional so the UI can consume the current canonical policy block, which does
not yet require one.

`revoked` is distinct from blocked, unknown, and expired, and is never eligible.
The popup exposes site-scope revocation but no goal, recording, or user-operated
learning lifecycle controls. Consequential ready-path confirmation remains a
separate section bound to its run, step, document, policy revision, and list
digest.

Candidate approval requires exact current action-map and action-list
digest/revision bindings, a passed replay, an eligible current policy, and both
authoritative `policyDecisionId` and `replayReportId` values. Rejection stays
available and never publishes on its own. The exact candidate payload is:

```json
{
  "decision": "approve | reject",
  "listId": "owned-storefront",
  "listRevision": 3,
  "listDigest": "sha256:...",
  "actionMapRevision": 2,
  "actionMapDigest": "sha256:...",
  "policyDecisionId": "policy_...",
  "replayReportId": "replay_..."
}
```

The trusted server assigns reviewer identity; the popup cannot assert it.

Run approval requires an exact current `runId`, `stepId`, `listDigest`,
`origin`, `documentId`, and `policyRevision`; denial stays available. G10 must
supply those current context fields (including `listRevision`,
`actionMapRevision`, and `runId`) alongside the pending candidate/confirmation,
and must re-check them authoritatively before publishing or executing. Compact
evidence rendering accepts identifier strings only and never renders raw
observations, semantic XML, URLs, or private history.

Retry-spool deletion sends the displayed count, normalized origin, scope ID, and
request time to the injected port. The authoritative adapter owns deletion and
must not delete accepted immutable revisions.

## Owned-demo override

The override control exists only for `http://127.0.0.1:4317`. Enabling it
requires checking an ownership acknowledgement and sends the exact origin,
scope, timestamp, and `OWNED_DEMO_EXPLICIT_OVERRIDE` reason to the coordinator.
The UI displays the returned audit record; it never creates an allow decision
for any other origin.
