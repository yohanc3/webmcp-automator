# Architecture

## Product question

Action Mapper is currently testing one narrow question:

> Can one demonstrated workflow plus semantic UI evidence produce a useful map
> of what a website can do and the steps required to do it?

WebMCP registration and generalized background execution are intentionally
paused while that question is evaluated.

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
  -> OpenRouter groups deterministic evidence into meaningful actions
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

## Current limits

- One recording is evidence, not universal site understanding.
- Several observations are not yet merged into one durable graph.
- Generated CSS, A/B layouts, virtualized content, closed Shadow DOM, and
  cross-origin frames can weaken the evidence.
- Privacy stripping is heuristic.
- Dangerous workflows still need an explicit confirmation design.
