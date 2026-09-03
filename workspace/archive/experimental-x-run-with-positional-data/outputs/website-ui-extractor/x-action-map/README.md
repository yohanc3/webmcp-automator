# X Action Atlas

Two local, dependency-free views generated from the supplied `https://x.com/home`
XML snapshot:

- `index.html` maps every XML action to a human-readable action and outcome.
- `ui.html` reconstructs the visible interface using the original action geometry.

Open either HTML file directly, or serve this folder with any static file server.
Both pages consume `data.js` and the shared interpretation logic in `model.js`.

## Coverage

- 240 of 240 actions mapped
- 128 confirmed from exposed text, semantics, or hrefs
- 104 inferred from repeated X interface patterns and spatial position
- 8 marked unclear because the XML omitted their icons, aria labels, and destinations

The UI reconstruction is not a screenshot. Coordinates, sizes, node types, text,
and hrefs come from the XML; missing iconography and media surfaces are represented
with restrained placeholders.

## Regenerate the snapshot data

```bash
python3 generate-data.py /path/to/snapshot.xml data.js
```

The generated file retains the exact action attributes required by both views.
