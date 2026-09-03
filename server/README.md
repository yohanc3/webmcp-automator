# Server

The server is the trusted boundary for recorded browser traces. It validates
frame order, strips sensitive evidence, stores the sanitized trace in PostgreSQL,
asks the selected AI provider to compile an action map, validates the model
output, and stores the result.

## Packages

```text
cmd/server/          Process entry point
internal/api/        HTTP routes and asynchronous discovery lifecycle
internal/trace/      learning-trace/3 validation and graph reconstruction
internal/privacy/    Pre-storage and pre-model sanitization
internal/learning/   Provider selection, discovery client, and prompt
internal/actionmap/  action-map/1 types, schema, and validation
internal/store/      PostgreSQL schema and persistence
internal/manifest/   Paused adapter-manifest contract
tests/               Server tests and fixtures
```

## Run

From the repository root:

Set one provider key in the local `server/.env` file:

```dotenv
CEREBRAS_API_KEY="your-key"
# OPENROUTER_API_KEY="your-key"
DB_URL="postgresql://user:password@host/database?sslmode=require"
```

Then run:

```bash
make run
```

Publish the reviewed owned-demo basket fixture into the configured database with:

```bash
make seed-demo
```

The command is idempotent after the fixture revision is published.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBMCP_LEARN_HOST` | `127.0.0.1` | Listen host |
| `WEBMCP_LEARN_PORT` | `4317` | Listen port |
| `DB_URL` | required | Neon PostgreSQL connection URL |
| `WEBMCP_DEMO_DIR` | `../workspace/demo` | Demo storefront files |
| `CEREBRAS_API_KEY` | unset | Enables Cerebras synthesis with `gemma-4-31b` |
| `OPENROUTER_API_KEY` | unset | Enables OpenRouter synthesis with `google/gemma-4-31b-it` |

`server/.env` is ignored by Git; `.env.example` documents the expected variable
without storing a secret. A non-empty `CEREBRAS_API_KEY` takes precedence;
otherwise the service uses `OPENROUTER_API_KEY`. Without either key, recording
and persistence remain available but synthesis cannot complete.

The Go process reads `.env` directly. Unquoted URL characters such as `&` are
treated literally, and variables already present in the process environment
take precedence over the file.

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
