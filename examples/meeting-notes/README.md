# Meeting Notes

Knowledge K5's first live consumer of the K1–K4 Knowledge architecture: an
installable Station plugin that captures a meeting transcript, compiles it
into a note with a visible provenance link back to the raw transcript, and
recalls it via a wikilink graph pane and a retrieval-grounded Q&A pane. See
[docs/guides/knowledge.md](../../docs/guides/knowledge.md)'s "Meeting notes:
capture and recall" section for the user-facing walkthrough this README
complements, and
[docs/design/knowledge-foundation.md](../../docs/design/knowledge-foundation.md)'s
"K5 — Meeting notes app" callout for the full landed-file/deviation record.

## The three tabs

- **Capture** (`src/CaptureModal.tsx`) — a root picker (personal + active-
  project roots, manual choice only, per R3), a paste/upload/live-capture
  transcript textarea, **Save transcript** (writes a `raw` Kit record) and
  **Compile** (invokes the plugin-contributed `compile` agent, then writes a
  `compiled` Kit record with `links: [{ target_id: rawId, kind: 'source' }]`
  and `provenance.source_ids: [rawId]`).
- **Library** (`src/GraphPane.tsx`) — the wikilink graph over the selected
  root: nodes are Kit records (grouped in rings by type), edges are forward
  links. Clicking a node opens a detail panel (title/type/category/body
  excerpt/links); clicking a linked node re-selects it, so a provenance
  chain (compiled note → raw transcript) is navigable without leaving the
  pane. A **Files / Neo4j view** toggle switches between the *file-based*
  graph (`GET /api/knowledge/roots/:rootId/graph`, the default) and the
  separate, opt-in Neo4j-backed graph view — see "Local Docker Neo4j
  quickstart" below for how to configure a connection, and "Integration
  points and known gaps" for the toggle's honest not-configured state.
- **Ask** (`src/AskPane.tsx`) — a search box over the K3 retrieval index,
  scoped to personal + active-project roots. Every result is an excerpt card
  (title, category, matched text, score) with a "View source record →"
  affordance that opens the full cited record inline. No generation step
  (Q3 decision): this pane finds and cites, it never composes an answer.
- **Agent** `compile` (`agents/compile/agent.json`) — a plugin-contributed
  Station agent (same mechanism `examples/demo-layout` uses for its
  "assistant" agent) that extracts `{title, summary, actionItems}` from a
  transcript. The extraction prompt wording is vendored verbatim from
  `examples/meeting-transcription/src/MeetingTranscriptionModal.tsx`'s
  `handleSend` — same dogfooded capability, now writing to a Kit record
  instead of dumping into chat.

No `serverModule` — this plugin's entire API surface is core routes
(`src-server/routes/knowledge-record-routes.ts`,
`knowledge-index-routes.ts`'s `/index/search` extension, and, for the
Neo4j-backed graph view, `src-server/routes/neo4j-graph-routes.ts`), consumed
directly.

## Dual-root demo: Obsidian + default-store (with Neo4j synced)

The intended dogfood demo (`docs/design/knowledge-foundation.md`'s Q1-ratified
"Graph view, synced" scope) runs the same Capture → Library → Ask flow twice,
on two different personal roots, to prove this app works identically
regardless of which adapter backs the root:

1. **Root A — `kit-obsidian-store`.** Connect an existing (or freshly
   `git init`'d) Obsidian vault as your personal knowledge store
   (`Settings → Knowledge Store → Connect an existing Obsidian vault`, see
   the main knowledge guide). Capture a transcript, compile it, and recall it
   through Library/Ask on this root.
2. **Root B — `kit-default-store`, with the Neo4j graph view synced.**
   Create (or use) a second knowledge store root backed by the built-in
   default-file adapter, capture/compile a transcript there too, then sync
   that root into Neo4j (see the quickstart below) and read the synced graph
   back directly over the API.

Both roots' Library/Ask panes behave identically from the UI's perspective —
the only difference is which adapter and (optionally, for root B) which
graph-query connection sits behind them.

## Local Docker Neo4j quickstart for the graph view

The Neo4j graph view is entirely optional — Capture, Library (file-based),
and Ask all work with zero Neo4j setup. This quickstart is for exercising the
opt-in, read-side Neo4j graph view described in the main knowledge guide.

1. **Start a real Neo4j instance locally** (mirrors the Kit's own
   "Docker-based live integration, run locally" pattern, and the exact
   recipe `src-server/knowledge-store/__tests__/neo4j-connection.test.ts`'s
   live-integration suite documents):

   ```bash
   docker run --rm -p 7687:7687 -p 7474:7474 \
     -e NEO4J_AUTH=neo4j/localtestpass neo4j:5
   ```

2. **Register the connection** (`src-server/knowledge-store/
   neo4j-connection.ts`'s `Neo4jGraphViewConnectionConfig` — `uri` is
   required; `username`/`password`/`database` are optional). There is no
   Settings UI for this yet, so registering today is a one-time,
   server-side call — illustrative shape (module path relative to the
   Station repo root, run in-process, e.g. from a small server-side script
   or test setup, not from the plugin's browser bundle):

   ```ts
   // (server-side; module path relative to the Station repo root)
   import { registerNeo4jGraphViewConnection } from './src-server/knowledge-store/neo4j-connection.js';

   registerNeo4jGraphViewConnection({
     uri: 'neo4j://localhost:7687',
     username: 'neo4j',
     password: process.env.NEO4J_PASSWORD, // matches the NEO4J_AUTH value you chose for the Docker container
   });
   ```

3. **Sync a root and read it back:**

   ```bash
   curl -X POST http://localhost:3141/api/knowledge/roots/<rootId>/graph/neo4j-sync
   curl http://localhost:3141/api/knowledge/roots/<rootId>/graph/neo4j
   curl "http://localhost:3141/api/knowledge/roots/<rootId>/graph/neo4j/shortest-path?fromId=<compiledId>&toId=<rawId>"
   ```

   Sync is idempotent (content-hash guarded) — re-running it against an
   unchanged store issues zero writes. `shortestPath` is the one structural
   query this slice ships (Q1-ratified scope); the other four canonical
   queries (`transitiveBlockers`/`contradictionCandidates`/`orphans`/
   `duplicateCandidates`) are named-deferred, not built.

   For the same exercise driven from `vitest` instead of `curl`, export
   `KNOWLEDGE_NEO4J_TEST_URL=neo4j://localhost:7687` and run
   `npx vitest run src-server/knowledge-store/__tests__/neo4j-connection.test.ts` —
   that suite is skipped (not silently passed) whenever the variable is unset.

## Integration points and known gaps

- **The temporary local API client (`src/api.ts`) is gone.** It existed only
  until `knowledge-record-routes.ts`'s SDK client/hooks
  (`packages/sdk/src/client/knowledge.ts`,
  `packages/sdk/src/query-domains/knowledgeStores.ts`) landed; a Wave 3
  cleanup pass deleted it and switched `CaptureModal.tsx` onto
  `createKnowledgeRecord` from `@kontourai/station-sdk/client` directly,
  matching what `GraphPane.tsx`/`AskPane.tsx` already did. The same pass
  deduplicated `RootPicker.tsx`'s and `AskPane.tsx`'s independently-written
  personal/project relevant-root filter into one shared module,
  `src/roots.ts`.
- **`useSTT` is not actually exported by `@kontourai/station-sdk`.**
  `examples/meeting-transcription/src/MeetingTranscriptionModal.tsx` imports
  `useSTT` from `@kontourai/station-sdk`, but that hook is defined only
  internally at `src-ui/src/hooks/useSTT.ts` — outside the plugin boundary
  and not re-exported by the SDK. This is a pre-existing, verified gap (not
  introduced by this plugin) that also affects `meeting-transcription`
  itself. `CaptureModal.tsx` detects this defensively at module load
  (`LIVE_CAPTURE_SUPPORTED`) and simply doesn't render the live-capture
  toggle until the SDK actually exports the hook — the paste/upload
  textarea (this plugin's always-available v1 capture surface) works
  regardless.
- **The Neo4j-backed graph view has a Library-tab toggle.** `GraphPane.tsx`
  now offers a "Files" / "Neo4j view" toggle (`useKnowledgeGraphNeo4jQuery`/
  `useSyncKnowledgeGraphNeo4jMutation`, added to the SDK alongside this Wave 3
  cleanup pass). Switching to "Neo4j view" only fetches once selected (never
  alongside the file-based graph by default); an unconfigured/unavailable
  connection renders an honest "Neo4j graph view isn't configured" state
  (never a silent empty graph), and a "Sync now" button triggers
  `POST .../graph/neo4j-sync` and reports the returned write counts.

## Try it

```bash
cd examples/meeting-notes
npm install
npm run build
```

Install the built plugin the same way as any other `examples/*` plugin (see
[docs/guides/plugins.md](../../docs/guides/plugins.md)), then open the
`meeting-notes` layout in a project (or personal workspace) that has at
least one registered knowledge-store root (see
[docs/guides/knowledge.md](../../docs/guides/knowledge.md)'s onboarding
section for creating one).
