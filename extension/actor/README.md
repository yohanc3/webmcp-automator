# Deterministic actor runtime

`runtime.js` implements `action-list/1` steps and returns `webmcp-run/1`
`step.completed` or `step.failed` payloads. It has no package, WebMCP,
service-worker, registry, server, network, or AI dependency.

## Direct API

Load `extension/actor/runtime.js` as a classic script to get `WebMcpActor`,
or use its CommonJS export in a DOM-capable test host.

```js
const actionStartedAt = Date.now(); // once per action, reused for every step
const outcome = await WebMcpActor.executeStep({
  action,                         // validated, pinned action-list/1 action
  command,                        // step.command envelope or its payload
  document,
  signal: abortController.signal,
  actionStartedAt,
  states: actionList.states,
});
```

The return value is `{ type, payload }`; the integration layer supplies the
standard protocol envelope. An optional `arguments` argument must equal the
command arguments. Commands must match the entire pinned step, independent of
JSON property order. Envelope inputs must use `webmcp-run/1` and `step.command`.

State definitions live on the list, so supply them separately. Trusted
integration code may instead supply `getStateId(document)`, synchronous or
asynchronous. Its wait is bounded by cancellation and the command deadline.

Other exports are `ActorError`, `resolveLocator`, `extractOutput`,
`validateArguments`, `accessibleName`, `roleFor`, `isVisible`, and `isEnabled`.
Use `executeStep` for validated outcomes, timeouts, and observation cleanup;
helper functions may throw `ActorError` directly.

## Semantics

- Try locator strategies in their published order, failing immediately on
  ambiguity. Supported strategies: role/name, label, placeholder, text, stable
  attribute (including test ID), href, CSS, and active element.
- `zero_or_one` can resolve an empty set; mutations still require exactly one
  interactable element. `many` never permits silently selecting a mutation
  target. All item field lookups, including associated labels, remain scoped.
- Fill uses native setters and input/change events. Click scrolls, checks
  visibility, enabled state and obstruction, then clicks once. Press focuses
  the target and dispatches an allowlisted keyboard sequence; Space has the
  native DOM key value and a cancelled keydown suppresses keypress.
- URL, element, collection, state, target value, DOM change and stability
  conditions support `all` and `any`. A click alone is never success.
- Extraction returns typed fields, absolute URLs, optional missing values as
  null, and at most the published item limit. Invalid typed values fail.
- Step deadlines, shared action deadlines, and aborts stop future work.
  Observers, listeners, and wait timers are cleaned up on every terminal path.
  Postcondition expiry after mutation is `POSTCONDITION_FAILED`; action expiry
  and wait expiry are `TIMEOUT`. No mutation is retried.
- Effects contain only the frozen URL/state/boolean fields. Failure evidence
  contains bounded counts or a navigation flag, never DOM dumps or arguments.

## Navigation and integration responsibilities

SPA URL/DOM updates can complete in the current document, with
`navigationObserved: false`. A real `pagehide` interrupts the current command
with `TRANSPORT_DISCONNECTED` and `error.observed.navigationObserved: true`.
The old document cannot verify the destination. `beforeunload` alone is not
proof of navigation and is not treated as success.

The execution client/coordinator must persist the pending command before
execution, observe the replacement document's `page.ready`, verify its origin
and destination conditions, and reconcile the pending effect without replaying
the click. Unload may destroy the message channel before any actor outcome can
be delivered, so lifecycle recovery cannot depend on receiving this failure.

Integration also owns full schema/semantic validation, policy, confirmation,
entry preconditions, digest selection, navigation counts across documents,
one active command per document, duplicate-command suppression, and the
surrounding run envelope. Supply the same `actionStartedAt` across steps.
No manifest, background, content, coordinator, or shared test-loader edits
are included in this branch.

## Browser tests

From the repository root:

```sh
python3 extension/actor/tests/serve.py
```

Open `http://127.0.0.1:4317/extension/actor/tests/index.html`. Port 4317 is
required by the unchanged owned-storefront fixture. The local server disables
script caching. The test page shows results, the extracted fixture product,
and all protocol outcomes. Tests restore their entry URL after SPA cases.

The suite includes a real same-origin iframe document replacement, alongside
positive and negative primitive/condition tests. The storefront fixture is
loaded before execution; fetch, XHR and WebSocket are then disabled for all
four actor steps. Its DOM handler supplies local product data.

For independent JSON Schema validation, save the text of the page's
`#outcomes` element as a JSON file, then run:

```sh
npm install --prefix /tmp/webmcp-actor-validation ajv@8 ajv-formats@3
NODE_PATH=/tmp/webmcp-actor-validation/node_modules \
  node extension/actor/tests/verify-contract.cjs /path/to/outcomes.json
```

This validates every captured envelope against the actual frozen schemas and
checks that the runtime has no network or dynamic-code entry points.
Development dependencies are not runtime dependencies and are not vendored.

## Limits

The accessible-name/implicit-role implementation covers common HTML controls,
labels and ARIA names; it is not the entire browser accessibility algorithm.
Shadow-root traversal and cross-origin frames are outside this runtime.
Keyboard events are synthetic and do not create trusted browser default
behavior, such as native Enter submission; declared postconditions still
must pass. A synchronous page handler or regular expression cannot be
preempted by a JavaScript timer; input plans must already satisfy the shared
validator's bounded-regex policy. The actor never interpolates executable code.
