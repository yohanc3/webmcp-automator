# Policy and review UI

`policy-review.js` is a presentation and decision-capture boundary. It renders
current policy, candidate action-list review, and an exact pending confirmation.
It does not enforce policy, execute steps, or write registry/publication storage.

## Injected ports

`createController(...)` receives two interfaces. Integration owns their backing
messages and storage:

```js
const controller = WebMcpPolicyReview.createController({
  rootElement,
  coordinator: {
    getPolicyReviewState: async () => state,
    setOwnedDemoOverride: async (override) => response,
    submitConfirmation: async (decision) => response,
  },
  registry: {
    openEvidence: async (reference) => response,
    submitCandidateDecision: async (decision) => response,
  },
});
```

Rendering never submits a decision. Approve and deny calls happen only after a
button click. Candidate review calls carry the exact list ID, revision, and
digest. Confirmation calls carry the run ID, step ID, and binding:

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

- `context`: current origin, requested scope, list digest, step ID, document ID,
  and policy revision;
- `policy`: the current policy-service result (`decision` or canonical `status`,
  scopes, source/basis, checked/expiry times, and reason);
- `overrideAudit`: the current owned-demo override audit entry;
- `candidate`: exact candidate identity, replay status/report, and canonical
  `actions[]` from `action-list/1`;
- `confirmation`: the pending run and step, argument preview, sensitive argument
  names, exact binding, and optional canonical step.

The popup currently adapts these ports to runtime messages. Until ready-path
integration handles those messages, the surface visibly reports `unknown` and
does not enable approval.

## Ambient-learning compatibility

`observationEligibility({ policy, origin, policyRevision, now })` is the small
integration hook for deciding whether automatic observation is eligible before
capture. It requests only the existing `learn` scope and returns a frozen,
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

## Owned-demo override

The override control exists only for `http://127.0.0.1:4317`. Enabling it
requires checking an ownership acknowledgement and sends the exact origin,
scope, timestamp, and `OWNED_DEMO_EXPLICIT_OVERRIDE` reason to the coordinator.
The UI displays the returned audit record; it never creates an allow decision
for any other origin.
