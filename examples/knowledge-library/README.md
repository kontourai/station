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
# From the Station repository root; use its managed dependencies.
npm run dependencies:ci
npm run build --prefix examples/knowledge-library
./station target
./station plugin preview ./examples/knowledge-library
./station plugin install ./examples/knowledge-library
```

Use **Settings → Knowledge** to create or connect a personal store, then add
the Knowledge Library layout to a Project. The current Settings card manages
personal roots; a Project root registered through the store API also appears
when that Project is active. If no relevant root exists, the plugin links back
to Settings. A Project's older document/namespace surface is a separate API;
see the [Knowledge guide](../../docs/guides/knowledge.md).

The [component](src/KnowledgeLibrary.tsx) calls the public root, graph, and
record query hooks and renders the SDK's
[Knowledge Recall components](../../packages/sdk/src/components/KnowledgeRecall.tsx).
It does not need an embedding model or a rebuilt semantic index to browse
records. This differs from the Meeting Notes Ask tab, which searches the
derived index. A personal read-only conversation root may also appear; the
library never attempts to write to it.

Root selection is explicit and is filtered to personal + active-Project roots.
That filter is a UI convenience, not proof of server authorization. Changing
or removing the selected root clears the applicable selection; canonical detail
is keyed to the root incarnation rather than relabeling an old record with a
new root. If a graph references a missing record, the detail surface reports it
instead of treating the graph node as canonical content.

## Boundaries

- read-only: the plugin calls only root, graph, and record GET contracts
- no legacy `KnowledgeService` namespace projection
- no dependency from Knowledge Kit to Station
- no inferred freshness when the canonical record declares no expiry

Expiry and lifecycle labels report record fields; they do not certify that a
claim remains true or that its external source was checked recently. Component
tests cover graph/detail navigation and root replacement using SDK fixtures.
A successful build does not qualify a real vault, multi-person authorization,
or an installed native/mobile journey. The broader root-scope and integration
limits remain in the [Knowledge guide](../../docs/guides/knowledge.md).
