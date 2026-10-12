# Learn Station

Explore Station from responsibilities to interfaces to implementation. Start
with [the product concepts](../user/concepts.md) and
[system overview](../architecture.md), then choose a branch below. The detailed
module descriptions come from the existing [module map](../architecture/module-map.md).

## Review status

Each document has a visible review note. The
[review ledger](review-ledger/) distinguishes current explanations, dated
history, design, policy, release notes, generated records, and fixtures.
Classification describes the document's purpose; it is not verification of its
runtime claims. Unlisted documents remain unreviewed.

A record states its review scope, supporting source files, checks, and limits.
Git history and append-only notes identify changes still needing review. If a
landing commit touches a document or listed source without a covering note,
the reader shows **Review out of date**. The PR checks require new notes for
that PR's touched inputs; another PR landing does not invalidate its notes.
See [keeping reviews fresh](../guides/documentation.md#keep-reviews-fresh).
Use `npm run docs:review:record` only after inspecting the changed claims and
evidence. A note is a reviewer's decision, not proof of semantic accuracy.

The deploy ledger has a narrower generated-output contract. Its current data
must contain valid, unique release identities and render byte-for-byte to the
Markdown through the reviewed generator. The reader labels this **Generated
output checked**, preserving the previous review identity; it does not claim
that the new releases were independently verified. Generator or validator
changes still require source review. A removed, purpose-classified changeset
note remains an absent historical classification, without implying it shipped.
These rules do not exempt other generated files or missing current guides.

## Interactive atlas

Build the local learning atlas from this checkout:

```bash
npm run docs:learn:build
python3 -m http.server 41781 --bind 127.0.0.1 --directory .kontourai/docs-learning
```

Open `http://127.0.0.1:41781`. Choose a concept in the expandable navigation,
open an interface beneath it, or search the full Markdown library. Documents
are rendered from their checked-in text; links between documents stay in the
reader. References to tracked source files open local text snapshots, and each
document offers its original Markdown. This works before a branch is published.
GitHub links are a secondary route to the recorded revision and require that
revision to exist on the remote. Rebuild to refresh the local snapshots.
Source URLs include the hash of their exact captured bytes. Normal rebuilds
retain those immutable files, so an already open reader's evidence links keep
showing the bytes selected by its original snapshot. GitHub links to older
commits stay on GitHub; links to `main` or the build's commit route locally.

The atlas includes every tracked Markdown file, including hidden directories,
READMEs, historical records, changesets, and fixture instructions. Inclusion is
inventory, not a claim that the prose is current. Each document retains its own
status; the audit ledger records review progress. A timestamp or source hash is
provenance, not proof of behavior.

This is a local contributor learning surface. It does not change the public
Pages allowlist or publish the repository's full documentation tree. Its
generated files live under the ignored `.kontourai/docs-learning/` directory.
Rebuild after editing or staging new documents. Mermaid diagrams render locally
with fit-width and actual-size controls, and retain expandable source. The
renderer is bundled from the pinned development dependency, so reading and
diagram rendering need no external network requests. The
[Mermaid security configuration](https://mermaid.js.org/config/usage) stays strict;
diagram source cannot enable executable click actions.

## Screenshots and walkthroughs

Selected application captures appear beside the relevant explanation. Each
caption names the scenario, its evidence limits, the capture revision and the
notes about its supporting source review.
A browser running sample fixtures is not a live provider or physical-device test.
Open a screenshot for full size; videos have ordinary playback controls and do
not autoplay. Keep a written explanation of the steps alongside a video.

`media.json` admits tracked PNG screenshots and WebM recordings under
`docs/learn/media/`. It records the asset digest, capture revision, evidence and
owning documents. Each capture's source path list
and historical review notes live in the review ledger under `captures/`, so reviewing
a capture does not rewrite `media.json`. The builder uses local immutable URLs,
preserves original capture provenance, and warns when supporting code has
changed. The check refuses a stale capture when the current change touched it,
its sources, its manifest entry or its capture review. Unlisted or remote
images remain links and are not fetched inline.

When adding a capture, inspect it for private data, record the actual fixture or
service used, and add its asset and source dependencies to each owning document's
review record. This connects UI changes to the impact/catch-up report. Re-capture
when behavior or presentation changes; if a reviewed code delta leaves the image
accurate, retain its capture revision and record the inspected inputs with `npm run docs:review:record -- docs/learn/media/<file> --note
"<what you checked>"`. The note is added to the ledger's notes files. The
command refuses a capture whose image bytes changed. Never relabel old media as
a new capture.

## Reading branches

| Branch | Begin with | Questions to bring |
| --- | --- | --- |
| Projects and durable work | [Concepts](../user/concepts.md), [Task dispatch](../design/task-dispatcher.md) | Who owns work before and after an engine runs? |
| Sessions, engines, recovery | [Chat sequence](../architecture.md#data-flow-chat-request), [Session API](../reference/session-api.md) | What is accepted, persisted, replayed, stopped, or uncertain? |
| Navigation and work surfaces | [Pane host contract](../design/pane-host-contract.md), [authoring](../guides/workspace-pane-authoring.md) | Which responsibilities belong to the shell, host, and Pane? |
| Identity and connections | [Topology](../design/station-topology.md), [authentication](../guides/deployment-authentication.md) | What authority does each identity or credential actually grant? |
| Shared and remote work | [Shared state](../design/shared-working-state.md), [machine relationships](../guides/machine-relationships.md) | Which state travels, and which authority stays local? |
| Knowledge and learning | [Knowledge guide](../guides/knowledge.md) | Which material is authoritative, indexed, proposed, or accepted? |
| Extensions | [Plugins](../guides/plugins.md), [contracts](../reference/contracts.md), [examples](../../examples/README.md) | What is installed, admitted, granted, and active? |
| Background activity | [Monitoring](../guides/monitoring.md), [notifications](../guides/web-push-notifications.md) | Who owns delivery, retries, retention, and failure? |
| Homes, native shells, delivery | [Development](../guides/development.md), [deployment](../guides/deployment.md), [release rings](../guides/release-rings.md) | Which instance, home, process, artifact, and Device were actually verified? |
| Evidence and governance | [Testing](../guides/testing.md), [Veritas](../../.veritas/README.md) | What does a passing gate establish, and what remains unverified? |

## Improving the architecture

Use the tree to ask where a responsibility belongs. Then follow the public
interface, composition point, real caller, state owner, and test. An interface
is useful when callers can state their intent without coordinating its private
mechanics. A folder or a class name alone does not establish that boundary.

Record a proposed improvement with the caller burden or failure it addresses,
the current owner, relevant code/evidence, and tradeoffs. Separate missing
explanation from an implementation defect. The
[abstraction review](../architecture/abstraction-review.md) starts this analysis;
the [audit ledger](../plans/documentation-code-audit.md) retains the broader
work still to complete.

For known defects and suggested fixes, follow the issue links in the
abstraction review. GitHub owns their progress. The implementation PR should
update the current explanation, diagrams, and shared MCP material when it
changes the behavior, then re-review the affected evidence. The audit retains
the original observation and a link to the fix.

## Maintaining the atlas

Use `npm run docs:impact -- <changed-paths...>` before an edit and
`npm run docs:impact -- --catch-up --json` to find accumulated review work.
The report links changed sources to their documented owners, distinguishes a
page's last edit from the coverage baseline and covering review notes,
and exposes unmapped changes.
See [incremental maintenance](../guides/documentation.md#find-affected-documentation-and-catch-up)
for the comparison baseline and limits.


The reader starts with a small navigation manifest. It fetches individual
document/module bodies, the full-text search index, and the diagram renderer
when needed. Snapshot digests bind rendered content, review metadata, and source
dependencies to the manifest that selected them; a mismatched lazy payload asks
the reader to reload. Changing supporting code without changing Markdown still
invalidates that identity. The builder hashes and writes the same captured
source bytes; review freshness separately derives from Git history and notes. A cached
page retains its original content and evidence across rebuilds. Mobile navigation
uses a native modal dialog so the reading content comes first and the background
is inert while the menu is open.

The [builder](../../scripts/build-learning-guide.mjs) owns these static artifacts,
the [shared model](../../scripts/lib/documentation-model.mjs) owns section and
catalog rules, and the [reader](atlas.js) owns navigation and presentation.
The [browser checks](../../scripts/__tests__/learning-atlas.browser.test.ts)
exercise lazy loading, source drill-down, search/history, mobile keyboard
navigation, and every Mermaid diagram in the library.

`atlas.json` owns only the concept grouping, reading routes, and learning
questions. Module explanations remain in the module map; prose remains in its
canonical document. The builder rejects unknown or multiply assigned modules,
missing documents, and unsupported catalog structure. New module sections must
be assigned to a branch. All tracked Markdown enters the library automatically.

Run `npm run docs:learn:check` to validate the tree and its references without
writing generated output. A passing check establishes navigation structure and
source locations. It does not establish semantic accuracy or execute the
behavior of the documented feature.

Diagrams initially fit the reading column. Choose **Actual size** to read small
labels and scroll inside the diagram; **Fit width** restores the overview.
Both controls work by keyboard. Diagram colors follow the theme at page load;
reload after changing the system theme to recolor existing diagrams.

## The same documentation through MCP

The built-in Station Docs MCP compiles the
[shipped manual](../reference/station-docs.md), this concept catalog, and the
module map into static content. Its existing topic IDs remain available;
architecture topic IDs use the `architecture-` prefix. An agent can call
`list_station_docs_topics` with `parentId: "architecture"`, then list a branch
such as `architecture-execution` and open one module with
`get_station_docs_topic`. Search covers both the manual and architecture.

Results carry their canonical source path and section, parent ID, and the
digest of the compiled documentation. That digest identifies content; it is
not a runtime, deployment, or test receipt. Reading this static documentation
needs no external provider credentials and reads neither the filesystem nor
the network at request time. Access to a Station endpoint still follows that
endpoint's authentication and tool-delivery contract. Live Station
state and operations stay behind their separate authenticated interfaces.

After changing the shipped manual, module map, or topic catalogs, run
`npm run docs:mcp:generate`. The server build checks that generated content is
current, and the documentation tests compare the actual shipped topic payload
with its canonical inputs. The local learning library includes the full
repository; the MCP ships only the explicitly selected manual and architecture
content, not changesets, fixtures, or historical operational records.
