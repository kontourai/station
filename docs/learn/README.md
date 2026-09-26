# Learn Station

Explore Station from responsibilities to interfaces to implementation. Start
with [the product concepts](../user/concepts.md) and
[system overview](../architecture.md), then choose a branch below. The detailed
module descriptions come from the existing [module map](../architecture/module-map.md).

## Interactive atlas

Build the local learning atlas from this checkout:

```bash
npm run docs:learn:build
python3 -m http.server 41781 --bind 127.0.0.1 --directory .kontourai/docs-learning
```

Open `http://127.0.0.1:41781`. Choose a concept in the expandable navigation,
open an interface beneath it, or search the full Markdown library. Documents
are rendered from their checked-in text; links between documents stay in the
reader. Code links open the recorded Git revision on GitHub. Local unpublished
changes may not exist there yet; use the displayed repository path in your
editor for those changes.

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

## Maintaining the atlas

`atlas.json` owns only the concept grouping, reading routes, and learning
questions. Module explanations remain in the module map; prose remains in its
canonical document. The builder rejects unknown or multiply assigned modules,
missing documents, and unsupported catalog structure. New module sections must
be assigned to a branch. All tracked Markdown enters the library automatically.

Run `npm run docs:learn:check` to validate the tree and its references without
writing generated output. A passing check establishes navigation structure and
source locations. It does not establish semantic accuracy or execute the
behavior of the documented feature.

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
not a runtime, deployment, or test receipt. The MCP remains credential-free
and reads neither the filesystem nor the network at request time. Live Station
state and operations stay behind their separate authenticated interfaces.

After changing the shipped manual, module map, or topic catalogs, run
`npm run docs:mcp:generate`. The server build checks that generated content is
current, and the documentation tests compare the actual shipped topic payload
with its canonical inputs. The local learning library includes the full
repository; the MCP ships only the explicitly selected manual and architecture
content, not changesets, fixtures, or historical operational records.
