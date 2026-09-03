# Extension

This directory is the loadable Manifest V3 Chrome extension. It captures
semantic page states, records user-driven transitions, serializes a stepped
`learning-trace/3`, sends the trace to the local server, and renders the returned
action map.

## Load it

1. Start the server with `make run` from the repository root.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `extension/` directory.
5. Open `http://127.0.0.1:4317/demo/` and reload after extension changes.
6. Use the extension popup to start and stop a recording.

The extension expects the local service at `http://127.0.0.1:4317`.

## Modules

- `semantic.js` captures bounded semantic page evidence.
- `recorder-core.js` builds ordered recording state without Chrome dependencies.
- `content.js` observes page interactions.
- `background.js` owns recording and discovery coordination.
- `runner.js` contains the paused deterministic replay path.
- `manifest-contract.js` validates the paused adapter contract.
- `popup.*` renders recording and discovery state.

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
