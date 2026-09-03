# Deterministic actor runtime

`runtime.js` implements the `action-list/1` step semantics and returns
`webmcp-run/1` `step.completed` or `step.failed` payloads. It has no WebMCP,
extension-service-worker, registry, server, network, or AI dependency.

## Direct API

```js
const outcome = await WebMcpActor.executeStep({
  action,
  command, // a step.command envelope or its payload
  arguments: command.payload.arguments,
  document,
  signal: abortController.signal,
  actionStartedAt: Date.now(),
  states: actionList.states,
});
```

The returned value is `{ type, payload }`. `type` is `step.completed` or
`step.failed`; `payload` has exactly the corresponding frozen run-message
payload shape. The integration layer owns the surrounding protocol envelope.

State definitions are supplied separately because they live on the action
list, not on an individual action. An execution client that already recognizes
page states may instead pass `getStateId(document)`.

## Browser tests

Serve the repository root, then open `/extension/actor/tests/index.html`.
The test page is independent of the integration-owned extension test loader.

