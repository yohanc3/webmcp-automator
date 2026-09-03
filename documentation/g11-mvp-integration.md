# G11 MVP integration

G11 joins the automatic learning and deterministic ready paths without merging
their authority. Ambient capture may propose an action-list candidate; only an
exact reviewed and published revision can become a WebMCP tool.

## Integrated flow

```text
eligible page
 -> sanitized semantic layer plus causal observation
 -> incremental AI action-map patch
 -> immutable action-map revision
 -> exact action-list candidate
 -> isolated durable actor replay
 -> explicit policy and publication review
 -> published list discovery in the source page
 -> exact revision and digest pinned run request
 -> inactive execution tab and deterministic actor
 -> structured result or typed error
 -> terminal acknowledgement and detached privacy-safe feedback
```

The source request carries `listId`, `listRevision`, and `listDigest`. The
registry resolves that immutable revision and rejects any digest or action
mismatch. Normal execution and candidate replay use separate named ports and
coordinators, but the same actor binding, page attestation, step execution, and
postcondition protocol.

Consequential approval is bound to the current run, step, list digest, policy,
document, URL, learned state, navigation sequence, page revision, and actor
sequence. Restart recovery replays persisted intent rather than repeating an
already observed effect. Source settlement and execution-tab cleanup happen
before optional run-feedback delivery can delay them.

## Reproducible ready-path demo

With `DB_URL` configured:

```bash
make seed-demo
make run
```

`make seed-demo` idempotently publishes two repository-owned fixtures:

- `owned_storefront` revision 1 exposes `search_products` and returns a
  structured product collection;
- `owned_storefront_basket` revision 2 exposes
  `add_field_h1_to_basket` and exercises exact step confirmation.

Load `extension/` unpacked, visit `http://127.0.0.1:4317/demo/`, and reload the
page after extension changes. The source bridge discovers only published lists
matching the current origin and route.

## Verification boundary

`make check` covers server storage and API contracts, ambient capture and retry,
candidate review and replay, source registration, immutable resolution,
durable recovery, actor DOM behavior, extension composition, documentation,
and Go static analysis. The component integration test executes the published
search action through source, coordinator, and actor bridges and verifies its
structured result.

A live AI and Neon walkthrough remains an environment-dependent manual smoke
test: it requires real credentials and a loaded browser extension. The test
suite does not claim that external-provider run.
