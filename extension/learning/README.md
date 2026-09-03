# Ambient learning capture boundary

`ambient-capture.js` is the automatic capture owner. It accepts injected
eligibility, document-observer, delivery, and local-spool ports and emits the
frozen `CompletedLayer { siteScope, layer, observation, policy, privacy }`
handoff. Attachment and every queued transfer require a current
`ambient_learn` allowance. The initial layer has no observation; every later
settled layer has exactly one causal, sanitized user observation. XML equality
does not suppress a layer.

Integration supplies a site-scope layer-sequence port backed by extension-local
state so sequences remain monotonic across top-level document replacement. The
included in-memory implementation is deterministic for focused tests and
single-process fixtures.

`retry-spool.js` defines the local encrypted-storage boundary. It enforces the
24-hour maximum retention, removes source after `applied`, `duplicate`, or
`no_change`, and quarantines a conflict only for explicit reparse. It exposes
no Universal DB synchronization surface.

The ambient controller's `start` and `stop` methods are internal document and
policy lifecycle mechanics. It defines no extension message types, goal,
recording control, indicator, or other user-operated learning-session surface.

The retained compatibility module records explicit user demonstrations as
sanitized `learning-trace/3` evidence. Its privacy boundary is before recorder
state, extension messages, session storage, debug downloads, and server intake.

## Integration boundary

Learning-capable content contexts load these files in order:

1. `learning/privacy.js`
2. `learning/semantic.js`
3. `learning/recorder-core.js`
4. `learning/session.js`
5. `learning/bootstrap.js` or the test-only `learning/harness.js`

`extension/manifest.json`, the service-worker import list, and shared test
indexes are integration-owned. This branch intentionally does not edit them.
For content capture, integration adds privacy, learning semantic, retry spool,
and ambient capture before replacing the existing bootstrap. The learning
modules expose the frozen `WebMcpSemantic` and `ActionMapperRecorder`
compatibility globals for the still-separate historical trace path. Until that
wiring lands, `learning/bootstrap.js` retains the prior semantic-capture
compatibility path; this owner branch does not put ambient behavior behind its
recording messages.

## Privacy invariants

- Semantic evidence uses an explicit element and attribute allowlist.
- URL query strings, fragments, and embedded credentials are removed.
- Sensitive URL path segments and stable DOM IDs are replaced or rejected
  using the same identifier policy before they can become URLs or locators.
- Demonstrated input values become typed tokens such as `{{arg.query}}` before
  recorder state is saved.
- When a value becomes an argument, earlier in-memory evidence is tokenized
  before the next session-storage write.
- Sensitive text shapes are replaced with `[redacted]`.
- Synthetic/untrusted actor events and events observed while the actor or
  legacy runner marker is active are excluded.
- Native anchor/form navigation is replayed exactly once only after the
  coordinator positively acknowledges durable event-start persistence.
- Debug downloads contain the sanitized trace plus category/count summaries;
  the redaction ledger stores no source values or hashes.

The observable session state is also reflected in
`document.documentElement.dataset.webMcpLearning`. An on-page status pill is
present only while recording and is excluded from semantic capture.

## Focused validation

The same ambient contract suite runs in Node and a browser:

```bash
node --test extension/learning/tests/ambient-contract-tests.js

chrome --headless=new --allow-file-access-from-files \
  --dump-dom extension/learning/tests/ambient.html
```

The historical hardened-capture regression remains available directly; its
shared extension test index is integration-owned:

```bash
chrome --headless=new --allow-file-access-from-files \
  --dump-dom extension/learning/tests/index.html
```

With the owned storefront available at `http://127.0.0.1:4317/demo/`, run:

```bash
python3 extension/learning/tests/live_storefront.py
```

The live script writes sanitized evidence to `/tmp/g6-owned-trace.json` and
`/tmp/g6-owned-debug.json` for local inspection and Go-validator checks. Its
sensitive-path regression writes `/tmp/g6-privacy-path-trace.json` and
`/tmp/g6-privacy-path-debug.json`.

The server remains a defense-in-depth consumer of already-sanitized evidence.
This branch does not modify `server/**`, so integration should separately make
the server privacy scanner mirror the client sensitive-path and locator policy
before recording is expanded beyond owned test sites.
