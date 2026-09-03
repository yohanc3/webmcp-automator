# G10 automatic candidate publication

Ambient learning remains fully automatic only through proposal. Every completed
sanitized semantic layer is parsed once, and accepted action-map revisions
project append-only `action-list/1` candidates. Nothing in that path publishes
a runtime tool.

## Authoritative review lifecycle

The coordinator never invents a digest, policy decision ID, replay report ID,
or action-map binding. It reads the candidate and its exact server-owned
binding, then uses these endpoints:

```text
GET  /v1/action-lists/{listId}/revisions/{revision}/candidate-review
POST /v1/action-lists/{listId}/revisions/{revision}/candidate-review/policy
POST /v1/action-lists/{listId}/revisions/{revision}/candidate-review/replay
POST /v1/action-lists/{listId}/revisions/{revision}/candidate-review
```

The state endpoint verifies the candidate digest against a durable binding to
one action-map scope, revision, and digest. A policy endpoint accepts the
current origin policy only to materialize a new server-generated policy record
bound to that candidate digest. Ambient collection consent produces only a
`learn` scope; it cannot authorize injection or execution. A separate
authoritative execution policy must cover `inject` and every action safety
class before publication.

Replay is an intentionally narrow injected `action-list/1` executor seam. The
production default is unavailable and therefore fails; it never reports a
structural validation as replay. CI injects a deterministic owned-demo executor
and the API accepts only an explicit `candidate-replay/1` passed result that
enumerates every candidate action ID/version with exact step and postcondition
coverage. It rejects partial, duplicate, or foreign action coverage and
reconstructs the stored report from that allowlist. It never stores
executor-supplied page content, arguments, semantic XML, evidence payloads, or
arbitrary summary text.

An explicit `approve` requires the current candidate digest, a nonblank
reviewer, a server-issued allowed policy record, and a server-issued passed
replay record. The transactional publication store checks all bindings again.
An explicit `reject` stores a terminal, idempotent rejection and returns
`published: false`. Rejection and approval serialize on the same candidate row,
so a rejected candidate cannot later publish. Duplicate approval, stale
digests/revisions, forged IDs, failed replay, and blocked policy fail closed.
For map-bound ambient candidates, the publication transaction also locks the
action-map scope and requires the bound revision/digest to remain the current
head, closing the check-to-publish race.
The generic registry publication route rejects map-bound ambient candidates;
they must pass through the authoritative candidate-review route, and the server
assigns reviewer identity.

`OPEN_CANDIDATE_EVIDENCE` remains explicitly unavailable. It must not resolve a
compact evidence handle until a resolver can prove that handle against this
same server-owned action-map revision and digest.

Run confirmation is served from the durable coordinator record. The popup
receives the exact run ID, list digest, step ID, origin, execution document ID,
and policy revision. Approval or denial is accepted only when every field still
matches the awaiting run; the coordinator then appends a typed `run.confirm`
event and resumes or terminates that exact run. The candidate-review policy
gate and the run-confirmation gate therefore remain separate authorities.

`make seed-demo` publishes only the repository-owned deterministic storefront
fixture. That fixture has no ambient action-map binding and exists to exercise
the ready path. Map-bound learned candidates still cannot use this path: their
publication transaction requires the authoritative candidate-review policy,
replay, reviewer, and current action-map head checks described above.

After publication, ordinary registry discovery still returns only published
lists whose exact origin and route match. Candidate revisions never escape the
ready path. Candidate insertion, exact candidate reads, action-map reads,
candidate review state, and run-observation writes require the extension
boundary; exact published reads remain public.
