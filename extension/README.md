# Extension

This directory is the loadable Manifest V3 Chrome extension. Eligible pages are
observed through the policy-gated ambient lifecycle. The popup renders policy,
safe action-map revision metadata, candidate review, local retry custody, and
separate consequential confirmation.

## Load it

1. Start the server with `make run` from the repository root.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `extension/` directory.
5. Open `http://127.0.0.1:4317/demo/` and reload after extension changes.
6. Use the popup to inspect current eligibility and safe revision state. It does
   not expose learning lifecycle controls.

The extension expects the local service at `http://127.0.0.1:4317`.

## Modules

- `semantic.js` captures bounded semantic page evidence.
- `recorder-core.js` builds ordered recording state without Chrome dependencies.
- `content.js` is the thin content-context composition root.
- `background.js` is the thin service-worker composition root.
- `shared/` owns the versioned run-envelope protocol and public errors.
- `source/bootstrap.js` discovers published action lists and exposes their WebMCP tools.
- `actor/runtime.js` executes pinned deterministic action primitives without network access.
- `actor/bootstrap.js` binds normal and isolated replay documents to the same
  durable actor protocol; `actor/client.js` remains a compatibility-tested
  predecessor rather than the production replay transport.
- `learning/bootstrap.js` captures page interactions and semantic evidence.
- `coordinator/run-coordinator.js` persists runs, confirmations, navigation, and outcomes.
- `coordinator/ready-runtime.js` owns immutable registry resolution, exact
  confirmation DTOs, Chrome persistence, and restart recovery.
- `coordinator/bootstrap.js` composes ready-path execution with ambient learning and review.
- `runner.js` and `manifest-contract.js` remain only for learned-adapter compatibility tests.
- `popup.*` renders the ambient policy and review console.
- `ui/policy-review.js` renders fail-closed policy, candidate review, and exact
  confirmation state through injected coordinator and registry ports.
- `tests/test-harness.js` provides reusable browser assertions, fixtures, and fakes.

## Test

```bash
make test-node
make test-extension
```

The tests in `extension/tests/` run in headless Chrome or Chromium, the same
JavaScript environment targeted by the extension. Override the detected browser
path when needed:

```bash
make test-extension BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

The Node suites cover transport, durable state, recovery, and integration adapters. The
browser suite covers DOM execution and extension composition.

Candidate review uses a separate replay actor port backed by its own durable
coordinator. It executes exact candidate actions in fresh inactive tabs and
submits only complete step coverage to the server. Evidence links are resolved
by the server against the candidate's exact current action-map binding. Normal
durable-run observations are delivered to the server for confidence, selector
repair, quarantine, and candidate regeneration.
