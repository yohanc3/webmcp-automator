# Learning capture boundary

The learning module records explicit user demonstrations as sanitized
`learning-trace/3` evidence. Its privacy boundary is before recorder state,
extension messages, session storage, debug downloads, and server intake.

## Module order

Learning-capable content contexts load these files in order:

1. `learning/privacy.js`
2. `learning/semantic.js`
3. `learning/recorder-core.js`
4. `learning/session.js`
5. `learning/bootstrap.js` or the test-only `learning/harness.js`

`extension/manifest.json`, the service-worker import list, and shared test
indexes are integration-owned. This branch intentionally does not edit them.
For content capture, integration adds privacy and learning semantic before the
existing bootstrap. For the service worker, it replaces the root semantic and
recorder imports with privacy, learning semantic, and learning recorder in that
order. The learning modules expose the frozen `WebMcpSemantic` and
`ActionMapperRecorder` compatibility globals, so the coordinator does not need
to change. Until that wiring lands, `learning/bootstrap.js` retains the prior
semantic-capture compatibility path.

## Privacy invariants

- Semantic evidence uses an explicit element and attribute allowlist.
- URL query strings, fragments, and embedded credentials are removed.
- Demonstrated input values become typed tokens such as `{{arg.query}}` before
  recorder state is saved.
- When a value becomes an argument, earlier in-memory evidence is tokenized
  before the next session-storage write.
- Sensitive text shapes are replaced with `[redacted]`.
- Synthetic/untrusted actor events and events observed while the actor or
  legacy runner marker is active are excluded.
- Debug downloads contain the sanitized trace plus category/count summaries;
  the redaction ledger stores no source values or hashes.

The observable session state is also reflected in
`document.documentElement.dataset.webMcpLearning`. An on-page status pill is
present only while recording and is excluded from semantic capture.

## Focused validation

Run the browser suite directly because the shared extension test index is
integration-owned:

```bash
chrome --headless=new --allow-file-access-from-files \
  --dump-dom extension/learning/tests/index.html
```

With the owned storefront available at `http://127.0.0.1:4317/demo/`, run:

```bash
python3 extension/learning/tests/live_storefront.py
```

The live script writes sanitized evidence to `/tmp/g6-owned-trace.json` and
`/tmp/g6-owned-debug.json` for local inspection and Go-validator checks.
