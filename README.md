# Action Mapper

Action Mapper learns a website's state-conditioned actions from a demonstrated
browser workflow. A Chrome extension records semantic page evidence and a Go
service validates, sanitizes, stores, and classifies the resulting trace.

## Repository

```text
server/          Go service, persistence, and server tests
extension/       Loadable Chrome extension and browser-native tests
documentation/   Architecture, development, and privacy documentation
workspace/       Demos and standalone experimental scripts
```

Each durable component owns its code, README, and tests. Experimental material
is kept under `workspace/` so it cannot be mistaken for product code.

## Run

Requirements:

- Go 1.25 or newer;
- Chrome or Chromium;
- a Neon PostgreSQL connection URL;
- a Cerebras or OpenRouter API key when AI synthesis is needed.

Node.js and npm are not required.

Put one provider key in `server/.env`, then start the project:

```dotenv
CEREBRAS_API_KEY="your-key"
# OPENROUTER_API_KEY="your-key"
DB_URL="postgresql://user:password@host/database?sslmode=require"
```

```bash
make run
```

The service starts at `http://127.0.0.1:4317`. Its owned demo is available at
`http://127.0.0.1:4317/demo/`.

When both keys are present, Cerebras is selected. Cerebras uses
`gemma-4-31b`; OpenRouter uses `google/gemma-4-31b-it`. The models are fixed in
the server rather than configurable through environment variables.

## Test

Run everything from the repository root:

```bash
make test
```

Or run one boundary:

```bash
make test-server
make test-extension
make test-documentation
```

Use `make check` for the complete test suite plus Go static analysis. See
[`server/README.md`](server/README.md),
[`extension/README.md`](extension/README.md), and
[`documentation/README.md`](documentation/README.md) for the component details.
