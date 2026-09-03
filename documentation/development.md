# Development

## Root interface

The repository intentionally has one small command surface:

```bash
make run
make test
make check
```

`make run` starts the Go service. `make test` runs server, extension, and
documentation tests. `make check` adds `go vet`. None of these commands requires
Node.js or npm.

## Demo walkthrough

The owned storefront lives in `workspace/demo/` and is served by the Go service
at `http://127.0.0.1:4317/demo/`.

1. Start the server and load the unpacked extension.
2. Open the demo and start recording.
3. Demonstrate a path such as search, product inspection, basket, and checkout.
4. Stop the recording and inspect the state rail and action ledger.
5. Copy the complete action-map JSON when deeper inspection is needed.

The decisive manual test is a real extension recording that produces a useful
multi-action map from this owned flow.

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
