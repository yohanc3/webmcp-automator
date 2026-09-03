# Architecture

## Product question

Action Mapper is currently testing one narrow question:

> Can continuous privacy-bounded semantic evidence produce a useful map of what
> a website can do and the deterministic steps required to do it?

Published actions are registered as WebMCP tools. Invocation crosses one named
source port into a durable coordinator, which opens an inactive execution tab,
supplies the pinned action and state definitions to the deterministic actor,
and returns one correlated result or typed error.

## Mental model

An action is not necessarily one DOM event. A search can be a sequence of fill,
submit, navigation, wait, and extraction operations. The result is a
state-conditioned directed graph:

- a **state** is a materially distinct page condition;
- a **primitive** is one deterministic operation: `fill`, `click`, `press`,
  `wait`, or `extract`;
- an **action** connects a starting state to a resulting state through ordered
  primitives;
- an **observed** action was directly demonstrated;
- a **resolvable** action has enough captured evidence for deterministic steps;
- an **unresolved** action is visible but still needs another observation.

The graph can branch and revisit states. `actionTree` remains the transport field
name, but its `kind` is `directed_action_graph`.

## Discovery pipeline

```text
eligible top-level page with current ambient policy
  -> extension captures one sanitized semantic-ui/2 layer
  -> trusted user interactions and resulting UI changes preserve causal order
  -> every completed layer is delivered once or kept in the encrypted local retry spool
  -> server builds a bounded parse request from that layer plus compact prior map context
  -> configured Cerebras or OpenRouter model proposes a typed action-map patch
  -> server validates, materializes, digests, and appends one immutable action-map revision
  -> executable actions become an exact action-list candidate
  -> actor replay, policy, and explicit review gates control publication
```

The model parses every accepted layer; there is no novelty threshold, goal, or
manual recording lifecycle. It receives only bounded current evidence and
compact accepted semantics from prior revisions. It does not receive permission
to invent DOM behavior, hidden APIs, locators, or transitions.

## Semantic evidence

The extension captures a bounded semantic projection rather than raw HTML. It
includes roles, accessible names, labels, values, stable attributes, visible
text, partial links, repeated-item signatures, fingerprints, and before/after
deltas. Geometry supports interpretation but is not used as a replay locator.

## Ready execution pipeline

```text
published action-list/1 revision
  -> source bridge registers the public WebMCP tool
  -> durable coordinator resolves the exact list, action version, digest, and policy
  -> actor bootstrap identifies the current learned state
  -> actor executes pinned steps without network or model access
  -> write/danger steps pause on an exact run confirmation
  -> coordinator stores the terminal observation and settles the source call once
```

The model participates in learning and compilation. It is never in the execution loop.

## Current limits

- A completed layer is evidence, not universal site understanding; prior context
  is deliberately compact and accepted revisions remain the authority.
- Generated CSS, A/B layouts, virtualized content, closed Shadow DOM, and
  cross-origin frames can weaken the evidence.
- Privacy stripping is heuristic and the local retry key is session-scoped.
- Candidate generation is automatic, but execution policy, actor replay, and
  publication review remain explicit safety gates.
- The owned demo has deterministic published search and basket actions; broader
  sites still require live-model evidence, replay coverage, and reviewed
  publication before tools appear.
