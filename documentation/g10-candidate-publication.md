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
bound to that candidate digest. It cannot make a foreign, revoked, expired, or
non-ambient policy allowed.

Replay is an intentionally narrow injected `action-list/1` executor seam. CI
uses a deterministic owned-demo executor and stores only a compact report
status, identifiers, and privacy-safe summary. It never stores page content,
arguments, semantic XML, or evidence payloads.

An explicit `approve` requires the current candidate digest, a nonblank
reviewer, a server-issued allowed policy record, and a server-issued passed
replay record. The transactional publication store checks all bindings again.
An explicit `reject` stores a rejection and returns `published: false`.
Duplicate approval, stale digests/revisions, forged IDs, failed replay, and
blocked policy fail closed.

`OPEN_CANDIDATE_EVIDENCE` remains explicitly unavailable. It must not resolve a
compact evidence handle until a resolver can prove that handle against this
same server-owned action-map revision and digest. G9 run confirmation remains
unavailable for the same reason: no run or step binding is fabricated.

After publication, ordinary registry discovery still returns only published
lists whose exact origin and route match. Candidate revisions never escape the
ready path.
