# Development

## Root interface

The repository intentionally has one small command surface:

```bash
make run
make test
make check
```

`make run` starts the Go service. `make test` runs server, Node, browser, actor,
and documentation tests. `make check` adds `go vet`. Node.js is required, but
npm is not.

## Demo walkthrough

The owned storefront lives in `workspace/demo/` and is served by the Go service
at `http://127.0.0.1:4317/demo/`.

1. Run `make seed-demo`, start the server, and load the unpacked extension.
2. Open the demo and enable the popup's audited owned-demo ambient policy.
3. Browse normally. Each completed sanitized semantic layer is parsed without a
   goal, start button, stop button, or evidence threshold.
4. Inspect the current action-map revision and any exact candidate in the popup.
   Resolve evidence, run isolated actor replay, and explicitly review only the
   candidate bound to that revision and digest.
5. Use a WebMCP client to invoke `search_products`; confirm that it returns the
   structured product collection. Invoke the seeded basket action separately to
   exercise exact consequential-step confirmation.

The decisive manual test is the full automatic learn-to-candidate chain plus a
published tool invocation. The seeded search and basket lists make the ready
half reproducible even when no live model key is configured.

## Workspace

`workspace/` is deliberately outside the product boundaries. It contains:

- `demo/`, the functional storefront used for controlled experiments;
- `scripts/browser-recorder-harness.js`, a browser-injection test harness;
- `scripts/discovery-smoke.js`, an optional live-model smoke client;
- `scripts/semantic-ui-extractor.js`, the standalone semantic XML extractor;
- `scripts/yohance_testing_script.js`, retained historical experiment material.
- `sqlite-data/`, the ignored pre-Neon local database archive.

These scripts are not root commands and are not dependencies of the server or
extension. Promote an experiment into a product boundary only when it gains a
clear owner and contract.
