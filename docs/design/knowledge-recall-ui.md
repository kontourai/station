# Knowledge recall UI boundary

Status: accepted for the Station #528 extraction, 2026-07-19.

This decision follows the generic Knowledge Library pilot with a supported
first-party boundary that Meeting Notes can also consume. It does not change
the Knowledge foundation's authority model: Kit-format records in registered
stores remain canonical, the graph remains derived, and Station remains a
consumer of the published store and client contracts.

## Decision

The domain-neutral recall implementation belongs in the plugin-facing
`@kontourai/station-sdk` package.

The SDK owns:

- personal plus active-project root relevance and root-incarnation identity;
- selected-record navigation across graph nodes, record links, and provenance
  sources;
- canonical record resolution through the existing read-only SDK query;
- record title, type, category, body excerpt, status, freshness, update time,
  provenance, sources, and outgoing-link rendering;
- accessible default graph navigation for plugins that do not need custom
  geometry.

The shared browser accepts a graph-renderer boundary. Knowledge Library uses
the default accessible record list. Meeting Notes supplies its existing radial
SVG renderer so K5's geometry, keyboard behavior, Files/Neo4j switch, and sync
controls remain product-owned while selection and record detail converge.

The two example plugins may keep their own loading, error, empty, toolbar, and
page-shell presentation. Those are product state and composition, not the
recall contract.

## Why the SDK

`@kontourai/station-sdk` is already the published, host-provided contract used
by both plugins for Knowledge queries and plugin UI components. Putting recall
there avoids all three incorrect dependencies:

- Knowledge Library importing Meeting Notes source;
- Meeting Notes importing Knowledge Library source;
- Knowledge Kit depending on Station UI.

A new package is not justified yet: there are two Station plugin consumers,
the SDK already owns their host-facing React boundary, and no non-Station
renderer has appeared. If a second product needs to render the same recall UI,
that is the promotion signal for a dedicated package rather than a reason to
freeze one prematurely.

## Public boundary

The SDK exports domain-neutral names rather than either plugin's vocabulary:

- `isRelevantKnowledgeRoot(root, selectedProject)`
- `knowledgeRootIncarnationKey(root)`
- `KnowledgeRecallBrowser`
- `KnowledgeRecordDetail`
- `KnowledgeGraphRecordList`

The browser owns selection unless a product provides controlled selection. Its
graph-renderer callback receives the canonical graph, selected record id, and
one `onSelect` action; a product renderer may decide geometry but cannot fork
record resolution or detail rendering.

Product-specific CSS classes and test ids are compatibility adapters supplied
as component props. They are not record identity and are not used by the SDK
to infer authority.

## Preserved product responsibilities

Meeting Notes retains Capture, Ask, the deterministic radial layout, the
Files/Neo4j choice, sync mutation and status, and meeting-specific empty-state
copy. Knowledge Library retains its read-only page shell, authority disclosure,
and root/settings affordances.

Neither plugin gains a write path from recall. Link navigation selects another
node only when that node is present in the derived graph; an outside-graph link
is disclosed rather than fetched under an invented authority.

## Lifecycle and cache integrity

Root authority is more than a root id. The incarnation key includes scope,
adapter, store root, display name, and creation time so a reconfigured root that
reuses an id cannot inherit a prior graph or canonical-record presentation.
Canonical record queries are explicitly revalidated when that authority key or
the selected record changes.

The shared detail renders status and freshness from the canonical record, not
from graph-node metadata. A missing canonical record is an explicit error even
when a stale derived graph still contains the node.

## Styling and runtime packaging

The SDK component imports SDK-owned CSS. Station's host imports the SDK exports,
so the shared stylesheet is emitted with the host while plugin JavaScript keeps
using the existing host-externalized `@kontourai/station-sdk` runtime. Focused
plugin builds are the required packaging proof.

## Telemetry

No new telemetry operation is added. This is a behavior-preserving client-side
extraction with no new authority, mutation, network operation, or user action.
Existing Knowledge read instrumentation and Meeting Notes Neo4j sync telemetry
remain the owning signals.

## Verification contract

- SDK unit tests cover root scoping, incarnation identity, navigation, canonical
  detail, provenance, lifecycle, and outside-graph links.
- Knowledge Library focused unit and Playwright tests prove the pilot behavior
  now travels through the shared boundary.
- Meeting Notes focused unit and Playwright tests remain the K5 regression
  floor, including SVG keyboard navigation and Neo4j honest states.
- A source gate rejects cross-example imports in the final change.
