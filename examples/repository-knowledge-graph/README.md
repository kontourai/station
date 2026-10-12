# Repository knowledge graph

Export Station's module map and recorded documentation dependencies as a derived
Knowledge Kit record graph. Import it into a dedicated local Station root using
the public SDK, then browse it with [Knowledge Library](../knowledge-library/README.md).
This is a repository example, not a new plugin or Station command.

The graph answers “where is this explained?”, “which source and test files are
referenced?”, and “which decisions does the explanation cite?”. It does not infer
call graphs, test results, historical intent or business value from code alone.
Module purpose is an attributed excerpt of the canonical module map. Missing
historical rationale remains explicit. Issue links are pointers; the exporter
does not fetch GitHub or claim an issue was implemented.

## Export without changing a store

From the Station repository root, with Node 24 and managed dependencies installed:

```sh
npm run dependencies:ci
node examples/repository-knowledge-graph/export.mjs --output=/tmp/station-knowledge-graph.json
```

Omit `--output` to print JSON. An existing output file is refused. `--repo=<path>`
selects another Station worktree. The exporter reads that worktree's tracked
atlas, module map and review ledger, including intentional working edits. It
records HEAD and independent byte hashes; HEAD alone does not describe dirty
inputs. Symlinks, unsafe paths and changed-during-read inputs are refused.

Current atlas membership determines the module set; it is not hard-coded in the
exporter. Whole-document ledger dependencies stay on document nodes. A module
gets only references found in its own canonical section. Untracked/private
artifacts, unsupported external URLs and ambiguous short filenames are not
ingested. Counts disclose omitted references. No raw source-file bodies or
arbitrary ledger command descriptions are copied.

Records use snapshot-qualified IDs and immutable provenance notes. The exported
payload digest detects accidental alteration, not authorship or semantic truth.
Import validates the input digest against the recorded revision and observations,
checks module/record/edge counts against the payload, and derives verified counts
from the records it reads back. Omitted-reference counts are export observations;
they do not prove complete coverage of the repository.
Path-only ledger records provide human dependency decisions; the exporter does
not judge Git review history. Run `npm run docs:freshness:check` for that report.
Legacy matching hashes mean only that recorded bytes match. Test references
never become PASS.

## Ingest into an isolated root

Start a separate instance using the normal [development workflow](../../docs/guides/development.md).
For example:

```sh
./station start --instance=knowledge-graph-dogfood --temp-home --port=43521 --ui-port=43531
```

Use an enrolled credential for that instance in `STATION_GRAPH_TOKEN`, and set
`STATION_GRAPH_API=http://127.0.0.1:43521`. Keep the credential out of commands,
logs and repository files. Do not use the current personal Station.

Create or select a Project in the isolated Station, then create its dedicated
Knowledge root through the public SDK. Replace `repository-graph` below with
that Project's slug:

```sh
node --import tsx --input-type=module <<'JS'
import { createKnowledgeRoot } from '@kontourai/station-sdk/client';
const api = process.env.STATION_GRAPH_API;
const root = await createKnowledgeRoot(api, {
  scope: { kind: 'project', projectSlug: 'repository-graph' },
  adapterId: 'kit-default-store',
  displayName: 'Station repository graph dogfood',
}, {
  credential: process.env.STATION_GRAPH_TOKEN,
  credentialOrigin: api,
  requireCredential: true,
});
console.log(root.id);
JS
```

Use the returned ID explicitly. Preview is the default; only `--apply` submits
record creation and link requests. Store reads can still refresh derived caches:

```sh
node --import tsx examples/repository-knowledge-graph/ingest.mjs --input=/tmp/station-knowledge-graph.json --api-base=http://127.0.0.1:43521 --root=root:project-repository-graph
node --import tsx examples/repository-knowledge-graph/ingest.mjs --input=/tmp/station-knowledge-graph.json --api-base=http://127.0.0.1:43521 --root=root:project-repository-graph --apply
node --import tsx examples/repository-knowledge-graph/ingest.mjs --input=/tmp/station-knowledge-graph.json --api-base=http://127.0.0.1:43521 --root=root:project-repository-graph --query=KnowledgeStoreProvider
```

The importer refuses default ports, non-loopback origins, personal roots and
roots containing records without this example's provenance marker. That marker
is a consistency check, not authenticated writer identity. Use one importer/writer for
this dedicated root. The API has no bulk transaction: an interrupted run can
leave a partial snapshot. Rerunning the identical export reads existing records,
refuses differences, and creates only missing IDs. It then checks every canonical
record and expected graph edge. A missing response may follow a durable write;
the next run inspects that record instead of assuming the write failed. Records
are created first; links are added afterward through the public `link` operation,
with evidence, so every target already exists. A partial expected link set can
resume, while unexpected links or changed content/provenance refuse the import.

Writes are paced at most four per second. Station's default authenticated
mutation budget is 300 standard requests per minute, shared by a principal's
routes. A known `rate_limited` HTTP 429 with a valid `Retry-After` waits at least
that long, then reads the exact record before another write. At most eight such
waits and a 15-minute batch deadline are allowed. Unknown refusals and uncertain
transport failures stop with an incomplete receipt; they are not automatically
replayed. Individual SDK request deadlines still apply.

New exports retain old snapshot records rather than rewriting history. Recall
uses the selected export's IDs, so equal titles from older snapshots are not
silently substituted. Use a fresh isolated root when comparing large snapshots;
the example has explicit record, edge, byte and retention limits. It neither
retires records nor deletes files automatically.

`--query` performs bounded graph-title matching followed by canonical record
reads, and returns an explicit no-answer. It is not semantic/vector search.
Browsing and graph traversal do not require an embedding provider or Neo4j.
Install Knowledge Library in the isolated Station, add it to the matching
Project and choose this root to follow the same records interactively.

## Evidence and limits

```sh
npm run test:focused -- examples/repository-knowledge-graph/__tests__/repository-knowledge-graph.test.mjs
```

The tests use real SDK HTTP requests, production Knowledge route handlers and
file adapters in a disposable home. They cover deterministic export, stale
dependencies, excluded private/untracked inputs, partial-write reconciliation,
idempotence, retained history, restart reads, graph edges and canonical recall.
Their small HTTP host supplies fixture authentication; that is not full Station
deployment or physical/native UI qualification. Record separate running-service
and browser receipts when exercising those layers.

The [guide](../../docs/guides/repository-knowledge-graph.md) explains source
authority, rationale and how this fits documentation maintenance.
