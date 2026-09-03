# Server

The server is the trusted boundary for recorded browser traces. It validates
frame order, strips sensitive evidence, stores the sanitized trace in PostgreSQL,
asks OpenRouter to compile an action map, validates the model output, and stores
the result.

## Packages

```text
cmd/server/          Process entry point
internal/api/        HTTP routes and asynchronous discovery lifecycle
internal/trace/      learning-trace/3 validation and graph reconstruction
internal/privacy/    Pre-storage and pre-model sanitization
internal/learning/   OpenRouter discovery client and prompt
internal/actionmap/  action-map/1 types, schema, and validation
internal/store/      PostgreSQL schema and persistence
internal/manifest/   Paused adapter-manifest contract
tests/               Server tests and fixtures
```

## Run

From the repository root:

Set the key in the local `server/.env` file:

```dotenv
OPENROUTER_API_KEY="your-key"
DB_URL="postgresql://user:password@host/database?sslmode=require"
```

Then run:

```bash
make run
```

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBMCP_LEARN_HOST` | `127.0.0.1` | Listen host |
| `WEBMCP_LEARN_PORT` | `4317` | Listen port |
| `DB_URL` | required | Neon PostgreSQL connection URL |
| `WEBMCP_DEMO_DIR` | `../workspace/demo` | Demo storefront files |
| `OPENROUTER_MODEL` | `openai/gpt-oss-20b:nitro` | Discovery model |
| `OPENROUTER_API_KEY` | unset | Enables AI synthesis |

`server/.env` is ignored by Git; `.env.example` documents the expected variable
without storing a secret. Without an API key, recording and persistence remain
available but synthesis cannot complete.

## HTTP API

- `GET /health` reports server, model, key, and database readiness.
- `POST /api/discover` validates and stores a trace, then starts discovery.
- `GET /api/discover/{sessionId}` returns discovery progress and results.
- `POST /api/learn` is a compatibility alias for `/api/discover`.
- Adapter publication and run-history routes are retained for the paused replay
  experiment.

## Test

```bash
make test-server
```

The server keeps tests under `server/tests/`, grouped by the package boundary
they exercise. The test packages consume exported behavior and verify the HTTP
behavior and PostgreSQL query contract without writing to the configured Neon
database.
