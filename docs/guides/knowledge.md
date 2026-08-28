# Knowledge: stores and the retrieval index

Station's knowledge system has two layers. They are separate on purpose, and understanding the
split is the key to everything else in this guide — see
[ADR-0009](../adr/0009-treat-knowledge-stores-as-canonical-and-index-as-derived.md) for the full
rationale ("why sqlite-vec") and [docs/design/knowledge-foundation.md](../design/knowledge-foundation.md)
for the implementation contract.

## Two layers: store vs. index

**Layer 1 — Knowledge store (canonical).** A knowledge store is a "root" directory written in the
Kit knowledge format (the same format the `@kontourai/flow-agents` Kit CLI and Obsidian-vault
adapters read and write). Every knowledge record you or an agent captures — a note, a concept, a
meeting summary — lives here as a plain, versionable, human-inspectable file tree. This is your
data. Nothing about it depends on Station running, and Station never invents a competing on-disk
format for it — record CRUD always goes through the Kit's own published adapter contract.

**Layer 2 — Retrieval index (derived, disposable, rebuildable).** To answer a semantic-search
query fast, Station also maintains a local `sqlite-vec` index — one file,
`{dataDir}/knowledge-index/index.db` — that holds embedded vectors for every chunk of every record
in every store. The index is a cache, not a second copy of your data: every entry carries a pointer
back to the store record it came from, nothing is ever read out of the index as if it were the
record itself, and the whole file can be deleted at any time with zero data loss. If it goes
missing, gets corrupted, or an embedding connection changes, Station rebuilds it from the stores
from scratch.

If you only remember one thing: **the store is truth, the index is a rebuildable performance
optimization on top of it.**

## `./station knowledge reindex` — (re)build the index

Run this any time you want the semantic-search index brought up to date with what's currently in
your knowledge stores — after a bulk import, after editing store files directly outside Station, or
just because you deleted the index file and want it back.

```bash
./station knowledge reindex
```

Rebuilds every registered store root. Example output:

```
Reindexed root root:personal: 42 record(s), 118 chunk(s).
Reindexed root root:project-station: 17 record(s), 53 chunk(s).
Knowledge reindex complete: 2 root(s), 59 record(s), 171 chunk(s).
```

Scope it to a single root with `--root`:

```bash
./station knowledge reindex --root root:project-station
```

```
Reindexed root root:project-station: 17 record(s), 53 chunk(s).
Knowledge reindex complete: 1 root(s), 17 record(s), 53 chunk(s).
```

Rebuilding is safe to run repeatedly — it always walks the store from scratch and replaces the
root's index partition, so re-running it on an already-current root just re-derives the same
result rather than erroring or double-counting.

### The rebuildability property

Because the index holds nothing that isn't derivable from a store, you can always throw it away:

```bash
runtime_home="${STATION_HOME:?export STATION_HOME for the selected runtime home}"
rm "$runtime_home/knowledge-index/index.db"
STATION_HOME="$runtime_home" ./station knowledge reindex
```

Recall (which records rank where, for a given query) after this delete-and-rebuild is expected to
be identical to what the index returned before you deleted it — that equivalence is exactly what
Station's `lossless-rebuild` test suite asserts. If a rebuild ever "succeeds" but search results
look thin or wrong afterward, that is a bug worth reporting, not an accepted side effect of
rebuilding — a shallow rebuild that returns fewer or zero chunks is exactly the failure mode this
property is designed to catch.

> **Changing your embedding connection clears the shared index for every project, not just the
> one you rebuild first.** The index is one physical table shared across every root's partition,
> and `vec0` fixes that table's vector width at creation time — so the first write after an
> embedding-connection change (a `reindex --root <one-project>`, or even a single document
> upsert) forces a full drop-and-recreate of the *entire* table, silently emptying every OTHER
> already-indexed root's search results until it, too, is rebuilt. If you switch your embedding
> connection, always run `./station knowledge reindex` with **no** `--root` afterward to restore
> search for every project — not just the one you happened to touch first.

## `./station knowledge migrate` — bring in pre-store knowledge

Before knowledge stores existed, per-project knowledge lived in an older, project-scoped vector
store (`{dataDir}/vectordb/<namespace>/vectors.json`) paired with a document tree
(`{dataDir}/projects/<slug>/knowledge/<namespace>/`). If you have any projects from that era, use
`migrate` to bring that data into the new store + index world.

```bash
./station knowledge migrate
```

Example output when there are pre-index documents or vectors to migrate:

```
Knowledge migrate complete: 12 document(s), 34 chunk(s) across 1 namespace(s) (project-acme).
```

Or, if no pre-index content is found (the common case for a project created after knowledge stores
shipped, or a fresh `~/.station` home):

```
Knowledge migrate: no pre-index documents or vectors found (no-op).
```

Scope it to a single project with `--project`:

```bash
./station knowledge migrate --project acme
```

Migration reuses each pre-index document's existing embedded vectors as-is when your embedding
connection hasn't changed (no wasted re-embedding); if the connection has changed since those
vectors were written, it re-embeds them through a normal reindex.

### The non-destructive guarantee

Migration only ever *adds*: it creates a new, project-scoped knowledge store root, writes each
pre-index document into it as a record, and builds an index partition for that root. **It never
writes to, moves, or deletes anything under the pre-index `{dataDir}/vectordb/` or
`{dataDir}/projects/*/knowledge/` directories** — those files are opened read-only, and the old
read path keeps working exactly as before. You can run `migrate` today and keep using Station
unchanged; nothing about your existing setup is disturbed, and there is no forced cutover. Re-running
`migrate` is also safe — a namespace that's already been migrated is skipped (reported as no new
work), so it never double-writes.

Because nothing is deleted automatically, "rolling back" before you're ready is simply: do nothing.
The earlier directories are still there, still valid, and still readable by the pre-index read path. Deleting
them once you've confirmed the new stores look right is a separate, manual cleanup step you take
when you're ready — migration itself never does it for you.

## Local vs. project scope

Every knowledge store root belongs to exactly one scope: your personal root (`root:personal`) or a
project root (`root:project-<slug>`, one or more per project). The retrieval index is one shared
`sqlite-vec` table, but every entry is tagged with the root it came from (a "partition key"), so a
search scoped to one root's records never leaks results from another root, and `reindex --root`
only ever touches that one root's partition. This is tested explicitly, not just assumed.

## Searching: `./station knowledge search`

Once a root is indexed (via `reindex`, above), search it from the CLI:

```bash
./station knowledge search "release pipeline failure" --top-k 5
```

Scope it to one root with `--root`, same flag as `reindex`:

```bash
./station knowledge search "release pipeline failure" --root root:conversations
```

Each result names the matched record's root, title, category, score, and a text excerpt — the same
`POST /api/knowledge/index/search` route the Ask tab (below) and the `search_knowledge` station-control
MCP tool both call. Like every other search path, results are index hits re-resolved through their
root's adapter, never trusted as the record on their own.

## `root:conversations`: past conversations as a knowledge root

Station's own conversation history — everything under `station runs`/the chat history, both
native-SDK (Claude/Codex) sessions and managed-runtime chats — is itself registered as a read-only
knowledge store root, `root:conversations`, when the `knowledgeStores` setting is on. This means
`./station knowledge search`/`search_knowledge` and the K3 index cover past conversations the same
way they cover any other root: no separate "search my chat history" surface to learn.

Two things make this root different from a personal or project store:

- **Read-only.** `root:conversations` is a derived projection, not somewhere you write new records.
  Every mutation (create/update/link/etc.) is rejected — the CLI/API surfaces this as an HTTP 405,
  not a generic error.
- **Freshness is explicit, same as any other root.** New or updated conversations do not
  automatically appear in search results — run `./station knowledge reindex --root=root:conversations`
  (or a plain `./station knowledge reindex`, which covers every root) after conversations you want to
  find have happened.

See [docs/design/knowledge-foundation.md](../design/knowledge-foundation.md)'s "Derived read-only
roots" note for the implementation detail (canonical source, the `READ_ONLY` error code, and how
this differs from a Kit-format file-tree adapter).

## Optional setup in Settings

Everything above describes the store/index model once it exists. This section covers how a new
Station user actually gets a knowledge store in the first place, without reading any of it.

### Settings → Knowledge Store

Settings has a "Knowledge Store" section (`Settings → Knowledge Store`) that manages your **personal**
knowledge store — the one every chat can read and write, independent of any project. Knowledge is
optional: Station does not show a global setup prompt or create/import a store automatically.

**Creating one is a single click.** If you don't have a personal knowledge store yet, the section
shows a "Create recommended store" action. There's no path to type: the server defaults the
location to `{dataDir}/knowledge/personal` (typically `<STATION_HOME>/knowledge/personal`) and uses the
built-in Kit default-store adapter. Once it exists, the section shows its location, display name, and
adapter instead of the create action.

**Connecting an existing Obsidian vault.** Instead of creating a fresh store, you can connect a vault
you already keep in Obsidian, via the "Connect an existing Obsidian vault instead" affordance (only
offered while there is no personal knowledge store yet — a personal store, once created, is exactly
one thing). Enter the vault's path, then run "Validate" before "Connect" becomes available. Validation
checks that the path exists, is a directory, and looks like a real vault (it has an `.obsidian/`
folder, or is simply non-empty). An honest failure — a missing path, a path that isn't a directory,
or an empty directory with no `.obsidian/` marker — is shown as a named error with the real reason
(e.g. "storeRoot is an empty directory with no .obsidian/ vault marker"), never a generic "something
went wrong" message and never silently creates a fresh store instead. Only once
validation reports success does "Connect" register the vault as your personal knowledge store.

**Changing a registered store is not migration.** The current registry contract has separate
create and deregister operations but no atomic replace operation. Settings therefore does not offer
a change action that could briefly remove the active store or register two personal stores. A future
redefinition flow must validate and atomically switch the registered target while preserving the
old store and every file. Copying records between stores is a separate migration operation and must
not be implied by a registry switch.

Note the noun: the thing Station manages is a **knowledge store**; "vault" is reserved for the
Obsidian-specific folder structure you're pointing it at.

### Project settings → Knowledge store

Each project's Settings has its own "Knowledge store" subsection (alongside the earlier per-project
document-upload panel), for that project's **project-scoped** knowledge store:

- **Create a project knowledge store** — same one-click pattern as the personal store: no path to
  type, the server defaults the location to `{dataDir}/projects/<slug>/knowledge-store` using the Kit
  default-store adapter.
- **Migrate this project's existing knowledge** — shown only when the project has knowledge from
  before knowledge stores existed (the earlier per-project document upload panel has files in it).
  This button runs the same non-destructive migration described above in
  ["The non-destructive guarantee"](#the-non-destructive-guarantee): it only ever adds a new,
  project-scoped knowledge store and copies pre-index documents into it as records — it never touches,
  moves, or deletes anything under the pre-index `vectordb/` or `projects/*/knowledge/` directories.

## Knowledge Library: general, read-only recall

**Knowledge Library** (`examples/knowledge-library/`) is the general Station surface for browsing
registered Knowledge Kit roots. It is an installable plugin, not a new store or a replacement for
the Knowledge Kit. Use it when you want recall without entering a domain app such as Meeting Notes.

The plugin deliberately keeps the two-layer authority boundary visible:

- its record list comes from the root-derived graph and is labeled as derived navigation;
- selecting a node resolves the canonical record again through that root's adapter;
- lifecycle, expiry, body, provenance, and links come from that canonical record response;
- it sends no knowledge mutations, index rebuilds, root changes, or Neo4j synchronization requests.

It shows personal roots plus roots for the active project only. Root choice stays explicit, so the
surface does not invent an automatic recall-routing policy. If there is no relevant root, it links
to `Settings → Knowledge` instead of showing an empty successful graph. A graph failure and a
canonical-record failure remain distinct visible errors.

Install and build it like any other example plugin:

```bash
cd examples/knowledge-library
npm install
npm run build
cd ../..
./station plugin install examples/knowledge-library
```

The final public product label may later become **Learn** as part of the unified Task experience.
`Knowledge Library` names this standalone pilot; it does not ratify the cross-product navigation
label.

## Meeting notes: capture and recall

**Meeting Notes** (`examples/meeting-notes/`) is the first real app built on the store/index model
above — Knowledge K5 (issue archive#203). It is an installable plugin, not core: everything it does goes
through the two layers this guide already describes (Kit records in a knowledge store, a
retrieval index for search) plus one optional addition, a Neo4j-backed graph view. Read this section
as a worked example of the store/index model, not a third layer.

### Install it

Like any other example plugin (see [docs/guides/plugins.md](./plugins.md)):

```bash
cd examples/meeting-notes
npm install
npm run build
./station plugin install examples/meeting-notes
```

Once installed, open the **Meeting Notes** layout in a project (or your personal workspace). It
needs at least one registered knowledge store — create your personal one first via
`Settings → Knowledge Store` if you haven't already (see
["Onboarding: first-run and Settings"](#onboarding-first-run-and-settings) above). The layout has
three tabs: **Capture**, **Library**, and **Ask**.

### Capture: transcript → raw record → compiled note

The **Capture** tab has a root picker (your personal knowledge store, plus the active project's, if
any — manual choice only, nothing is auto-selected), a transcript textarea (paste, upload a `.txt`
file, or — where your browser supports speech recognition — record live), and two actions:

- **Save transcript** writes the verbatim transcript as a `raw` Kit record
  (`provenance.agent: 'station.meeting-notes.capture'`).
- **Compile** sends that transcript to a plugin-contributed agent (the same "extract the key action
  items, decisions made, and any important points" prompt already dogfooded by
  `examples/meeting-transcription/`), then writes the structured result as a `compiled` record whose
  `links` includes `{ target_id: <raw record's id>, kind: 'source' }` and whose
  `provenance.source_ids` names the same raw record. The compiled note is never written before the
  raw transcript, so the provenance link is always resolvable the moment the note appears.

Both writes go through the K2 store seam described above — nothing about capture bypasses the
adapter contract or invents a parallel storage format. See
`examples/meeting-notes/src/CaptureModal.tsx` and `examples/meeting-notes/src/compile.ts` for the
exact record shapes.

### Library: the wikilink graph

The **Library** tab renders the selected knowledge store's records as a wikilink graph — one node
per Kit record (grouped in rings by type: raw, compiled, concept, snapshot, person), one edge per
forward link. Click a node to see its title, type, category, a body excerpt, and its own outgoing
links; clicking a linked node re-selects it, so you can walk a provenance chain (compiled note →
its raw transcript, and onward) without leaving the pane.

**Files vs. Neo4j: which graph you're looking at.** Every knowledge store root has a file-based
graph view for free — `GET /api/knowledge/roots/:rootId/graph` derives it directly from the store's
own records and their `links` fields (`src-server/routes/knowledge/knowledge-record-routes.ts`), no extra
setup required. This is what the Library tab renders today
(`examples/meeting-notes/src/GraphPane.tsx`'s `useKnowledgeGraphQuery(rootId)`).

Separately, a root can also be synced into a real **Neo4j** graph database as an opt-in, read-side
"graph view" — the same graph data, materialized in Neo4j for genuine graph queries (a shortest-path
provenance-chain lookup between two records, for example) rather than a re-derivation from files
each time. This is a connection you configure once, not a second place your notes are stored: your
knowledge store's files stay the single source of truth on `kit-default-store` or
`kit-obsidian-store`; Neo4j only ever mirrors what's already there. The relevant server routes
(`src-server/routes/knowledge/neo4j-graph-routes.ts`: `POST .../graph/neo4j-sync`,
`GET .../graph/neo4j`, `GET .../graph/neo4j/shortest-path`) are wired into the Library tab as a
**Files / Neo4j view** toggle (`examples/meeting-notes/src/GraphPane.tsx`) — switching to "Neo4j
view" calls `useKnowledgeGraphNeo4jQuery(rootId)` (only once you actively select that view, never
alongside the file-based graph by default) and a "Sync now" button triggers
`useSyncKnowledgeGraphNeo4jMutation()`, reporting the returned node/link write counts. `curl`/script/
Kit-CLI access to the same routes remains equally valid — the toggle is a UI convenience over the
same API, not a replacement for it.

**What "Neo4j graph view isn't configured" means.** Every one of those Neo4j routes answers an
honest `503` with that reason whenever no connection is registered — which is the default, out of
the box, on every Station install. Nothing about knowledge stores, capture, or the file-based
Library graph requires Neo4j; it is purely optional. "Not configured" specifically means no process
has called `registerNeo4jGraphViewConnection(...)` (`src-server/knowledge-store/neo4j-connection.ts`)
yet — there is no Settings toggle for this in this landing, so registering a connection today is a
one-time programmatic/operational step (see `neo4j-connection.ts`'s `Neo4jGraphViewConnectionConfig`
shape below), not a user-facing form.

**How to configure it.** Register a connection with (server-side; module path
relative to the Station repo root — this is not something a plugin or
browser client calls, it runs in-process on the Station server):

```ts
import { registerNeo4jGraphViewConnection } from './src-server/knowledge-store/neo4j-connection.js';

registerNeo4jGraphViewConnection({
  uri: 'neo4j://localhost:7687', // or bolt://, neo4j+s://
  username: 'neo4j',
  password: process.env.NEO4J_PASSWORD, // never hardcode credentials
  database: 'neo4j', // optional; defaults to the driver's own default database
});
```

Then, for a given root, trigger a sync and read it back:

```bash
curl -X POST http://localhost:3141/api/knowledge/roots/<rootId>/graph/neo4j-sync
curl http://localhost:3141/api/knowledge/roots/<rootId>/graph/neo4j
curl "http://localhost:3141/api/knowledge/roots/<rootId>/graph/neo4j/shortest-path?fromId=<compiledId>&toId=<rawId>"
```

Sync is idempotent and content-hash guarded (`src-server/knowledge-store/neo4j-graph-sync.ts`): a
second sync of an unchanged store writes nothing. See
["Local Docker Neo4j quickstart"](../../examples/meeting-notes/README.md#local-docker-neo4j-quickstart-for-the-graph-view)
in the plugin's own README for a copy-pasteable local setup, including a `docker run` one-liner.

### Ask: retrieval-grounded Q&A

The **Ask** tab is a search box over the retrieval index described earlier in this guide, scoped to
your personal store plus the active project's — not a chat. Type a question, submit, and each result
comes back as an excerpt card: title, category, the matched text, a relevance score, and a "View
source record →" affordance that opens the full record (title, type, category, and body) inline.
There is no generation step: nothing here composes an answer for you, it only finds and cites. If
you want the exact wording behind an excerpt, follow its source link — every excerpt is traceable
back to the Kit record it came from (`examples/meeting-notes/src/AskPane.tsx`, backed by
`POST /api/knowledge/index/search`, `src-server/routes/knowledge/knowledge-index-routes.ts`).

**The no-embedding-connection state.** Search embeds your query text before it can match anything,
so it needs an embedding-capable Model connection configured (the same requirement
`./station knowledge reindex`/`migrate` already have, described earlier in this guide). If none is
configured, Ask shows an honest "No embedding model configured" state with a direct link to
`Connections → Models` — never a silent empty-results screen. Once you configure one, existing
records still need an index before they're searchable: run `./station knowledge reindex` (or
capture/compile new records, which the plugin writes straight into the store the reindex command
already knows how to pick up).

## See also

- [ADR-0009](../adr/0009-treat-knowledge-stores-as-canonical-and-index-as-derived.md) — why
  sqlite-vec was chosen as the built-in index, and the evaluation of the runner-up (real LanceDB).
- [docs/design/knowledge-foundation.md](../design/knowledge-foundation.md) — the full
  `KnowledgeStoreProvider`/`KnowledgeIndexProvider` interface contracts and landed file references.
