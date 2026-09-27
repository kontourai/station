# Learn Station through its repository graph

The [repository graph example](../../examples/repository-knowledge-graph/README.md)
turns the learning atlas, module map and review ledger into a reproducible
Knowledge Kit record snapshot. It uses Station's existing Knowledge store API
and Knowledge Library rather than introducing another database.

Start with a subsystem, open a module, then follow its canonical explanation,
source references, tests and decision links. The module map remains the current
explanation. GitHub issues and accepted design records retain their own history
and authority. The graph is a way to navigate those sources, not a substitute
for them.

## What an edge means

| Edge | Evidence |
| --- | --- |
| `contains-module` | The atlas places that module in that subsystem. |
| `reading-path` | The atlas recommends that document for the subsystem. |
| `documented-in` | The module has that canonical module-map section. |
| `references-source` / `references-test` | That exact section references the tracked file. This does not establish a call relationship or a passing test. |
| `references-document` / `references-decision` | The section links that document or public Station issue/PR. Remote content is not fetched. |
| `review-dependency` | The whole document's review record names the source, with a digest comparison. This is not per-module claim certification. |

The current export includes the atlas's module set, including retained contract
work. A graph node does not mean that a feature is mounted in production. Read
the canonical section's implementation status and evidence limits.

## Purpose and historical rationale

Each module carries an attributed excerpt of its documented purpose. Historical
“why was this added?” remains unknown unless an accepted decision, issue or
other canonical source establishes it. A reference to an issue is not proof
that its proposed design shipped. The exporter does not synthesize business
benefits, intent or success from code structure.

When rationale is missing, add the explanation and its evidence to the owning
document during the normal review. Separate the observed current behavior from
the desired outcome. Update the linked backlog item when implementation changes;
then regenerate this projection. Do not maintain a competing task list inside
the Knowledge store.

## Snapshot and update boundaries

The exporter records Git HEAD plus independent hashes of the selected tracked
working files. Intentional dirty documentation can therefore be explored without
pretending it belongs to the recorded commit. A changed source dependency is
visible even when the review ledger still names older bytes. Matching hashes
do not prove the prose is correct.

Each input digest creates a distinct record identity set. Ingestion into a
dedicated isolated root verifies existing records and preserves earlier snapshots.
There is no atomic whole-graph publish or automatic retirement. Use the selected
snapshot for programmatic recall, and a fresh root for a clean interactive
comparison. The example documents interruption recovery and limits explicitly.

Knowledge Kit's published store contract supplies records, immutable creation
provenance and directed links. Station implements that file contract through
its own adapters and exposes it through the public SDK. No Kit-internal imports
are needed. Knowledge Library reads the canonical record after graph selection;
vector search is a separate derived index and is not required for this journey.

Follow [documentation maintenance](documentation.md) for source review and
downstream document updates. The graph and any dependency report are review
leads; neither grants semantic approval or refreshes evidence hashes for you.
