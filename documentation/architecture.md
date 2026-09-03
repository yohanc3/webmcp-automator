# Architecture

## Product question

Action Mapper is currently testing one narrow question:

> Can one demonstrated workflow plus semantic UI evidence produce a useful map
> of what a website can do and the steps required to do it?

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
user starts recording
  -> extension captures the initial semantic page map
  -> interactions and their UI changes become ordered causal frames
  -> extension normalizes focus clicks and repeated fills
  -> server validates frame order and rebuilds the directed graph
  -> server removes typed values, URL parameters, duplicate XML, and identifiers
  -> sanitized evidence is stored in PostgreSQL
  -> API returns while discovery continues asynchronously
  -> the configured Cerebras or OpenRouter model groups evidence into meaningful actions
  -> server validates and stores the action-map/1 result
  -> extension renders states, actions, steps, evidence, and missing evidence
```

The model groups already captured evidence. It does not receive permission to
invent DOM behavior, hidden APIs, locators, or transitions.

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
  -> execution client identifies the current learned state
  -> actor executes pinned steps without network or model access
  -> write/danger steps pause on an exact run confirmation
  -> coordinator stores the terminal observation and settles the source call once
```

The model participates in learning and compilation. It is never in the execution loop.

## Current limits

- One recording is evidence, not universal site understanding.
- Several observations are not yet merged into one durable graph.
- Generated CSS, A/B layouts, virtualized content, closed Shadow DOM, and
  cross-origin frames can weaken the evidence.
- Privacy stripping is heuristic.
- The owned demo has a deterministic published basket action; broader sites still need
  more demonstrations, replay coverage, and reviewed publication before tools appear.
