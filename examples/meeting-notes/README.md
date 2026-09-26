# Meeting Notes

Meeting Notes is a Station example plugin for saving a text transcript as a
Knowledge store record, requesting a structured note from an Agent, and
browsing or searching the resulting records. Its Ask tab returns excerpts;
it does not generate an answer. A build or component test does not establish
that a live model, microphone, Obsidian vault, or Neo4j connection works.

The [Knowledge guide](../../docs/guides/knowledge.md) owns store registration,
indexing, and provider setup. The K5 section in the
[foundation design](../../docs/design/knowledge-foundation.md) records the
original delivery plan and deviations; it is historical context, not a live
qualification receipt.

## Prerequisites and local build

Use a configured Station and explicitly select a writable personal or active-
Project root backed by `kit-default-store` or `kit-obsidian-store`. The picker
filters roots by relevance, not write capability: the read-only
`root:conversations` can be listed but refuses record creation. Root selection
is a UI filter, not an authorization boundary.

Compiling requires the installed `compile` Agent and a usable model connection.
Semantic search separately needs an embedding-capable connection and an index
built for the selected roots. Saving and file-based browsing do not need Neo4j.

```bash
# From the Station repository root; use its managed dependencies.
npm run dependencies:ci
npm run build --prefix examples/meeting-notes
./station target
./station plugin preview ./examples/meeting-notes
./station plugin install ./examples/meeting-notes
```

Preview and install target the selected Station; follow its person-approved
plugin lifecycle. Add the `meeting-notes` layout to a Project and open it.
Building alone does not install the plugin, register a root, or configure an
Agent/model. See the [plugin guide](../../docs/guides/plugins.md).

## Capture, compile, and recall

1. **Capture:** choose a writable root, paste a transcript or upload a `.txt`
   file, then choose **Save transcript**. The
   [Capture component](src/CaptureModal.tsx) calls the public
   [`createKnowledgeRecord`](../../packages/sdk/src/client/knowledge.ts)
   client. It writes a `raw` record with category `meeting-transcript` and a
   caller-supplied `station.meeting-notes.capture` provenance label.
2. **Compile:** after saving, choose **Compile**. The
   [compile helper](src/compile.ts) invokes `compile` through the
   [public SDK invocation client](../../packages/sdk/src/api-agent-runtime.ts),
   requests `{title, summary, actionItems}`, and checks that response shape.
   It then writes a `compiled` record with category `meeting-note`, a forward
   `source` link to the saved raw ID, and `provenance.source_ids: [rawId]`.
   Review the generated text; schema-shaped output is not proof of accuracy.
3. **Library:** select the root again. The
   [graph pane](src/GraphPane.tsx) reads its file-based record graph and opens
   canonical record details and source links through the public SDK. It does
   not require the semantic index. Capture calls the plain record client, so
   it does not perform the graph-query invalidation offered by the SDK's
   `useCreateKnowledgeRecordMutation`; reload/refetch before concluding that
   a cached graph reflects a new save.
4. **Index explicitly** before expecting the new records in Ask:

   ```bash
   ./station target
   ./station knowledge reindex --root=<selected-root-id>
   ```

   Inspect the selected Station and rebuild result. The
   [record route](../../src-server/routes/knowledge/knowledge-record-routes.ts)
   writes the store; it does not rebuild the retrieval index.
5. **Ask:** choose one relevant root or all personal + active-Project roots,
   then search. [AskPane](src/AskPane.tsx) uses
   `useSearchKnowledgeIndexMutation` and shows title, category, excerpt, and
   score. **View source record** fetches the current full record. The
   [search route](../../src-server/routes/knowledge/knowledge-index-routes.ts)
   re-reads the record but returns the indexed excerpt, which may predate an
   edit. Open the source and inspect its lifecycle; reindex when fresh excerpts
   are needed. Changing embedding models requires rebuilding all roots, as
   described in the Knowledge guide.

## Capture and provenance limits

The transcript is text input, not an authenticated meeting recording. The
record route accepts the submitted provenance label; that label does not prove
who spoke or captured the material. The compile helper reads the current
textarea, not the stored raw record, and does not verify equality with that
record before writing the source link. Editing normally clears the saved ID,
but inputs remain editable while requests are pending. Avoid switching the
root or transcript during save/compile, and verify both records before relying
on their provenance relationship. This is a known qualification gap, not a
claim of an enforced immutable capture workflow.

Live capture is currently unavailable in this example: the public SDK does not
export `useSTT`, so `LIVE_CAPTURE_SUPPORTED` hides the control. Paste/upload
remains available. The separate
[Meeting Transcription example](../meeting-transcription/README.md) uses the
public `voiceRegistry` and sends text to chat; it does not save these Knowledge
records. Its provider-selection limits still apply.

The extraction prompt originated in the earlier Meeting Transcription modal.
The current owner is [compile.ts](src/compile.ts); do not infer equivalent live
behavior from that shared prompt history. Model invocation and record creation
are separate operations. A failed or uncertain request does not prove that no
model work or record write happened; inspect the result before retrying.

## Optional Neo4j developer surface

The Library's **Files / Neo4j view** toggle uses the public
[`useKnowledgeGraphNeo4jQuery` and sync mutation](../../packages/sdk/src/query-domains/knowledgeStores.ts).
Selecting Neo4j reads that projection; **Sync now** requests a separate write.
Unconfigured or unavailable connections return an explicit error rather than
an empty successful graph.

This is not an ordinary Settings setup path. The
[connection registration](../../src-server/knowledge-store/neo4j-connection.ts)
is process-local, and the runtime mounts the
[graph routes](../../src-server/routes/knowledge/neo4j-graph-routes.ts) without a
production registration caller. Starting Docker or calling the registration
function in a separate script does not configure a running Station. A developer
harness must provide the connection in that same process, including credentials
required by its Neo4j server; the real-driver dependency must also be available.
The generic connection probe establishes TCP reachability only.

The intended dual-root exercise is to capture and recall the same meeting in a
Git-backed Obsidian vault and a default-file root, then explicitly sync a root
into Neo4j and inspect the projected records and `shortestPath`. Treat this as
a qualification procedure, not proof that both adapters or views behave
identically. The projection is not a canonical store or a retrieval index.
Removed source records and changed links need separate reconciliation coverage;
an unchanged-record write count does not prove a fully synchronized graph.

The [Neo4j test file](../../src-server/knowledge-store/__tests__/neo4j-connection.test.ts)
contains TCP and real sync/read/path tests guarded by
`KNOWLEDGE_NEO4J_TEST_URL`. Those live tests currently construct their driver
from the URI alone; a credential-requiring daemon is not configured by that
variable. With the variable unset, live tests are skipped, not passed:

```bash
npm run test:focused -- src-server/knowledge-store/__tests__/neo4j-connection.test.ts
```

Real microphone capture, model-backed compilation, dual-adapter use, and a live
Neo4j journey require separate evidence. Component tests use mocked SDK calls;
store and route tests prove their own boundaries, not the entire installed
plugin journey.
