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
- `shared/` owns legacy message compatibility and future run-envelope helpers.
- `source/bootstrap.js` adapts the paused registration and execution path.
- `learning/bootstrap.js` captures page interactions and semantic evidence.
- `coordinator/bootstrap.js` preserves recording, discovery, and job coordination.
- `runner.js` contains the paused deterministic replay path.
- `manifest-contract.js` validates the paused adapter contract.
- `popup.*` renders the ambient policy and review console.
- `ui/policy-review.js` renders fail-closed policy, candidate review, and exact
  confirmation state through injected coordinator and registry ports.
- `tests/test-harness.js` provides reusable browser assertions, fixtures, and fakes.

## Test

```bash
make test-extension
```

The tests in `extension/tests/` run in headless Chrome or Chromium, the same
JavaScript environment targeted by the extension. Override the detected browser
path when needed:

```bash
make test-extension BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

No Node.js test runner is used.
