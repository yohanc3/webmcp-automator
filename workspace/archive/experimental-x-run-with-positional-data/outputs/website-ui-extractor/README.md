# Semantic UI Extractor

A dependency-free browser-console script that turns the rendered page into
compact semantic XML for an AI agent. The output describes what the interface
says, how content is grouped, and which controls are currently available. It is
not intended to reconstruct the page visually.

## Run it

1. Open the target page and its browser developer console.
2. Paste the complete contents of `extract-ui.js` and press Enter.
3. The XML is copied to the clipboard, returned, and logged.

Run it again after the page changes:

```js
extractSemanticUI()
```

The previous function name remains available for compatibility:

```js
extractWebsiteUI()
```

## Output model

The output is a pruned semantic DOM:

```xml
<page schema="semantic-ui/1" url="https://example.com" title="Example">
  <nav role="navigation" accessible-name="Primary" layout="row">
    <a
      ref="c1"
      role="link"
      accessible-name="Home"
      href="https://example.com/home"
      current="page"
    >Home</a>
  </nav>

  <main role="main">
    <article role="article">
      <div>Complete visible article text.</div>
      <div grouping="visual" layout="row">
        <button ref="c2" role="button" accessible-name="Reply">11</button>
        <button ref="c3" role="button" accessible-name="Bookmark" />
      </div>
    </article>
  </main>
</page>
```

- Real HTML tag names are used instead of generic `<node>` or `<action>` tags.
- `role` is the effective ARIA or native HTML role.
- `accessible-name` says what a control or named region means. This can describe
  icon-only controls that contain no readable text.
- XML text content is normalized rendered text. Standalone prose, headings,
  labels, timestamps, article text, status messages, and control text are kept.
- `href` is resolved to an absolute URL.
- `ref` is a snapshot-local control identifier. It is not a DOM ID or selector.
- Form values, placeholders, selected options, and meaningful control states are
  retained. Password contents are never exposed; only `value-present="true"` is
  reported.
- Native semantic parents such as `nav`, `main`, `article`, `form`, `dialog`,
  lists, tables, headings, and labels are preserved.
- Empty and redundant `div`/`span` wrappers are collapsed.

## Visual grouping without reconstruction data

Element geometry is used internally to recognize useful row or grid
relationships. Coordinates and dimensions are discarded. A non-semantic
container retained only for this purpose is explicit:

```xml
<div grouping="visual" layout="row">
  ...
</div>
```

Semantic structure always takes priority over inferred visual grouping.

## Controls and confidence

Native controls and ARIA controls are emitted directly. The script can also
retain likely custom controls identified through `onclick`, explicit focusability,
`draggable="true"`, or a pointer cursor. These are never assigned an invented
role:

```xml
<div
  ref="c8"
  accessible-name="Open card"
  interaction="inferred"
  interaction-source="pointer"
>Open card</div>
```

Disable the weakest pointer-cursor heuristic when maximum precision matters:

```js
extractSemanticUI({ pointerHeuristic: false })
```

## State and current availability

The extractor retains relevant values such as:

- `disabled`, `unavailable`, and `blocked-by-modal`
- `expanded`, `pressed`, `checked`, and `selected`
- `current`, `focused`, `required`, `readonly`, and `invalid`
- `haspopup`, `open`, `modal`, `live`, and `orientation`

When an active modal dialog is detected, controls outside it receive
`blocked-by-modal="true"` so the agent does not treat background controls as
currently usable.

## Options

Only inspect the current viewport:

```js
extractSemanticUI({ viewportOnly: true })
```

Return the XML without copying it:

```js
extractSemanticUI({ copyToClipboard: false })
```

Disable CSS-generated readable text:

```js
extractSemanticUI({ includeGeneratedText: false })
```

Raise or lower the safety limits:

```js
extractSemanticUI({
  maxNodes: 20000,
  maxTextCharacters: 500000,
})
```

If either limit is reached, the root receives `truncated="true"` and the output
ends with a `<truncated reason="configured-output-limit" />` marker.

## Browser limits

The snapshot includes the current document, rendered off-screen content already
present in the DOM, open shadow roots, and the choices inside native `<select>`
controls. Iframes are retained as named `<iframe>` elements, but their embedded
documents are not traversed. Closed shadow roots, virtualized content not yet in
the DOM, and lazy-loaded content not yet created cannot be reported.

Text painted into an image, video, or `<canvas>` requires OCR and is intentionally
not included. Image elements and image URLs are omitted, but their alternative
text can still contribute to the accessible name of a containing control.
