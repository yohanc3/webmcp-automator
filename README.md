# Action Mapper

Action Mapper is an experiment in learning a website's actions from normal browser use.

The Chrome extension observes a demonstrated path, records semantic page states and the changes caused by each event, and sends a privacy-scrubbed trace to a Go service. GPT-OSS classifies the evidence into an inspectable map of page states, actions, deterministic steps, outputs, confidence, and missing evidence. SQLite preserves the sanitized observation and resulting map.

WebMCP registration and generalized execution are intentionally paused. The current question is narrower:

> Can one demonstrated workflow plus semantic UI evidence produce a useful map of what a website can do and the steps required to do it?

## Mental model

An action is not necessarily one DOM event.

- Opening a link may be one click.
- Searching may be fill → submit → navigation → wait → read a result collection.
- Comparing may connect several search and read actions.
- Ordering is a dangerous write path that needs more observation and an explicit confirmation boundary.

The result is a **state-conditioned action map**:

- A **state** is a materially distinct page condition, such as a catalog or search results page.
- A **primitive** is one deterministic operation: `fill`, `click`, `press`, `wait`, or `extract`.
- An **action** connects a starting state to a resulting state through ordered primitives.
- An **observed action** was directly demonstrated.
- A **resolvable action** was not demonstrated end to end, but the captured UI contains enough evidence to specify it safely.
- An **unresolved action** is visible but still needs another observation before deterministic steps can be claimed.

This is a directed action graph, not strictly a tree: several actions can leave the same page state, and a workflow can return to a state it has already seen. `actionTree` remains the transport field name, while its `kind` explicitly identifies a `directed_action_graph`. Each individual discovered action still contains a linear primitive step list.

## Discovery pipeline

```text
user starts recording
  → extension captures the initial semantic page map
  → clicks, fills, Enter presses, navigation, and UI deltas become causal frames
  → user stops recording
  → extension normalizes focus clicks and repeated fills
  → trace is serialized as page → action → update → resulting page
  → Go validates that ordering and independently rebuilds the directed action graph
  → Go removes typed values, URL parameters, duplicate XML, and obvious identifiers
  → sanitized trace is stored in SQLite
  → the API returns immediately while discovery continues independently
  → sanitized trace and strict action-map schema are sent to GPT-OSS through OpenRouter
  → Go validates state references, action statuses, locators, parameters, steps, and outputs
  → validated map is stored in SQLite
  → extension renders the state rail and action/step ledger
```

Discovery is automatic. The user does not name or manually configure a capability.

The extension produces `learning-trace/3` before involving AI. Its `frames` are deliberately stepped: a compact page map is followed by the action observed on that page, the exact URL/DOM/collection update caused by the action, and the resulting page. A previously seen page can be sent as a small reference instead of duplicating its entire semantic map. The extension builds an initial `actionTree`; the Go boundary discards and reconstructs that structure from validated frame order before storage or model access. GPT-OSS is responsible only for grouping this deterministic evidence into meaningful higher-level actions.

## Action-map contract

The structured result uses `action-map/1` and contains:

- site origin and sanitized observed URLs;
- distinct page states with URL patterns, fingerprints, and evidence;
- actions with category, status, safety, confidence, start state, and destination state;
- generalized input parameters;
- ordered deterministic steps and completion expectations;
- page or collection output contracts;
- evidence and explicitly missing evidence;
- warnings and a privacy-redaction summary.

A discovered action is not silently upgraded to executable. `observed` and `resolvable` actions must contain valid steps. `unresolved` actions identify what is missing instead of inventing behavior.

## Semantic evidence and shape

The extension records a bounded semantic projection rather than raw HTML. Evidence includes:

- native elements, roles, accessible names, labels, names, and placeholders;
- stable IDs and selected `data-*` attributes;
- visible text and partial link destinations;
- structural CSS only as a fallback;
- repeated item and collection signatures;
- page URL, title, viewport, fingerprints, and geometry;
- before/after deltas for each observed interaction.

“Shape” means a repeated semantic structure: for example, product-card siblings that each contain a title, price, rating, and link. This allows discovery to identify a `read_results` action and describe its item fields without asking the model to interpret the page again at execution time.

Geometry is supporting evidence, not a replay locator. It helps identify headers, sidebars, modals, grids, and repeated groups, but coordinates are too fragile across responsive layouts and experiments.

The extension's side-effect-free capture module now uses the important core from [`semantic-ui-extractor.js`](./semantic-ui-extractor.js): composed-tree traversal, open Shadow DOM traversal, accessible-name evidence, and an explicit distinction between confirmed controls and lower-confidence inferred candidates. The standalone script remains useful as the richer human-readable XML projection; `yohance_testing_script.js` is historical test material and is not part of the discovery runtime.

## Privacy boundary

The raw browser trace is not written to SQLite or sent to OpenRouter unchanged.

Before persistence or transmission, the Go sanitizer:

- removes the duplicate `semanticXml` snapshot;
- replaces demonstrated typed strings and numbers with a user-input marker;
- removes query strings and fragments from URLs;
- replaces long URL identifiers;
- redacts emails, phone numbers, payment-number shapes, credentials, street-address shapes, account greetings, and long numeric identifiers.

The compiler prompt adds a second boundary. It forbids personal names, contact details, addresses, account/order/payment identifiers, credentials, and literal typed values in every output field. It must generalize those values into parameters and describe evidence semantically.

This is still an experimental heuristic, not a guarantee that arbitrary page text contains no personal information. Test with the owned storefront before recording signed-in account or checkout pages.

## SQLite history

SQLite lives at `backend/data/webmcp.db` by default.

| Table | Purpose |
| --- | --- |
| `sites` | Canonical website origins. |
| `learning_sessions` | Sanitized recordings, model metadata, and failure history. |
| `action_maps` | Immutable validated `action-map/1` discovery results. |
| `adapters`, `adapter_versions`, `adapter_runs` | Paused WebMCP/replay experiment retained for later work. |

The local API is intentionally permissive during this experiment and should not be deployed as-is.

## Repository layout

```text
extension/                       Loadable Manifest V3 Chrome extension
backend/internal/actionmap/      Action-map types, schema, and validation
backend/internal/privacy/        Pre-storage and pre-model trace sanitizer
backend/internal/learning/       OpenRouter GPT-OSS discovery client and prompt
backend/internal/trace/          Stepped trace validation and action-graph reconstruction
backend/internal/store/          SQLite schema and persistence
backend/internal/api/            Local HTTP API
demo/                            Functional miniature commerce site for discovery experiments
test/                            Browser-side contract tests
scripts/browser-recorder-harness.js Test-only Codex Browser recorder injection
```

## Run it

Requirements:

- Go with CGO support;
- Chrome;
- an OpenRouter API key.

`npm start` loads `OPENROUTER_API_KEY` from a repository-root `.env` file when present. You can alternatively use Go's native process environment:

```bash
export OPENROUTER_API_KEY="your-key"
npm start
```

`npm start` runs `go run ./cmd/server` from the `backend` directory. The default is `openai/gpt-oss-20b:nitro` with low reasoning effort. The 20B model supports Structured Outputs and is much faster for this classification-shaped task; Nitro asks OpenRouter to prefer its highest-throughput provider. Use 120B as a quality comparison or fallback, not the interactive default:

```bash
OPENROUTER_MODEL="openai/gpt-oss-120b" npm start
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository's `extension` folder.
4. Open `http://127.0.0.1:4317/demo/` and reload it after installing or updating the extension.
5. Open the extension and click **Start recording**.
6. Demonstrate a path such as search → open product → add to basket → checkout.
7. Open the extension and click **Stop and discover actions**.
8. Inspect the state rail, observed/resolvable/unresolved action cards, steps, evidence, and missing evidence.
9. Use **Copy action map JSON** when you need the complete structured result.

## Local API

- `GET /health` — backend, model, key, and database readiness.
- `POST /api/discover` — validate, sanitize, and store a stepped trace, then start discovery asynchronously.
- `GET /api/discover/{sessionId}` — poll the durable discovery session until it is `candidate` or `failed`.
- `POST /api/learn` — temporary compatibility alias for `/api/discover`.
- paused adapter/replay routes remain available but are not part of this experiment's success criteria.

## Validation

```bash
npm test
npm run check
```

With a keyed, current backend running, exercise the exact tracked storefront fixture through the live model:

```bash
npm run smoke:discover
```

That script sends `test/fixtures/storefront-search-trace.json` through the same `/api/discover` privacy, model, validation, and SQLite path used by the extension, then prints only the resulting state/action summary.

For a real browser walkthrough without installing the extension, `scripts/browser-recorder-harness.js` can be injected into the owned demo together with `extension/semantic.js` and `extension/recorder-core.js`. It is deliberately not loaded by the demo application: the harness exists only for Codex Browser testing, preserves an in-progress recording across demo navigations in session storage, and emits the same `learning-trace/3` contract as the extension.

The automated suite covers:

- action-map reference and step validation;
- trace privacy stripping;
- stepped page/action/update/page serialization, repeated-page references, event normalization, and out-of-order event reconciliation;
- server-side trace-order validation and action-graph reconstruction;
- owned-storefront routing for search, product, comparison, basket, checkout, and confirmation states;
- OpenRouter Structured Outputs request and response handling;
- API sanitization before model access;
- SQLite action-map persistence;
- the older browser manifest contract.

The decisive manual test is a real extension recording that produces a useful multi-action map from the demo storefront. The storefront intentionally offers several paths: search, read results, compare products, inspect a product, change the basket, and complete a fake checkout. Amazon is the next experiment after these owned flows are repeatable.

## Current limits

- One recording provides evidence, not universal site understanding.
- The system does not yet merge several maps into one durable multi-observation graph.
- Generated CSS and A/B layouts can still weaken locators.
- Cross-origin frames, closed Shadow DOM, and virtualized content need deeper capture support.
- Privacy stripping is heuristic.
- WebMCP registration, background replay, repair, reputation, and public sharing are paused.
- Ordering and other destructive workflows require an explicit confirmation design before execution work resumes.
