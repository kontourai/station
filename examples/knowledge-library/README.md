# Knowledge Library

Knowledge Library is Station's generic, read-only recall surface for registered
Knowledge Kit roots. It is deliberately separate from Meeting Notes: the plugin
does not capture, compile, mutate, index, or synchronize records. It reads the
published Station Knowledge Store SDK only.

## What it shows

- personal roots and roots for the active project
- the root-derived record graph
- canonical record detail resolved from the selected root's adapter
- explicit lifecycle, expiry, and provenance fields
- navigable record links

The graph is a derived navigation aid. The selected record endpoint remains the
authority for body, provenance, lifecycle, and freshness fields.

## Install locally

```bash
cd examples/knowledge-library
npm install
npm run build
cd ../..
./station plugin install examples/knowledge-library
```

Register a personal or project knowledge root in **Settings → Knowledge**, then
enable the Knowledge Library pane for a Project. If no relevant root exists, the
plugin links back to that setup surface.

## Boundaries

- read-only: the plugin calls only root, graph, and record GET contracts
- no legacy `KnowledgeService` namespace projection
- no dependency from Knowledge Kit to Station
- no inferred freshness when the canonical record declares no expiry
