# Workspace Surfaces Context

Workspace Surfaces covers how Station presents projects, layouts, experiences,
file work, proposed changes, trust state, and review state to users. A
Workspace Pane is the smallest addressable UI unit within a surface,
experience, or layout; it is not a replacement name for this bounded context,
and it is never the Kontour Surface product.

## Follow the current composition

| Question | Code owner |
| --- | --- |
| What can the shell navigate to? | [Destination registry](../../../src-ui/src/app-shell/destination-registry.ts) and [navigation store](../../../src-ui/src/contexts/navigation-store.ts) |
| Which region holds each tab? | [Region model](../../../src-ui/src/regions/region-model.ts), [saved arrangement](../../../src-ui/src/regions/region-arrangement-record.ts), and [RegionPaneHost](../../../src-ui/src/workspace-panes/RegionPaneHost.tsx) |
| What may be placed and rendered? | [Pane contract](../../../packages/contracts/src/workspace-pane.ts), [catalog](../../../src-server/services/projects/workspace-pane-catalog.ts), and [built-in renderer registry](../../../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx) |
| What survives a reload? | [Host storage](../../../src-ui/src/workspace-panes/workspacePaneHostStorage.ts) and each Pane's separate state owner; [runtime callbacks](../../../src-ui/src/workspace-panes/workspacePaneHostRuntime.ts) remain ephemeral |
| Where does Task collaboration run? | [TaskWorkspaceView](../../../src-ui/src/views/TaskWorkspaceView.tsx), [TaskRoomEditorPane](../../../src-ui/src/workspace-panes/TaskRoomEditorPane.tsx), and [ProjectTaskRoomRuntime](../../../src-server/services/orchestration/project-task-room-runtime.ts) |

The [module map](../../architecture/module-map.md#projecttaskroom)
documents that mounted Task path; the unmounted pure editor controller was
deleted. Browser, Device, Work Board and host actions have separate entries
there; sharing a Pane host does not give them the same persistence or authority.

## Language

**Project**:
A scoped workspace where Station associates files, layouts, agents, knowledge, runs, and receipts.
_Avoid_: repo when the workspace may not be only Git

**Working directory**:
The filesystem location a project uses for file-backed work.
_Avoid_: project when only a path is meant

**Task**:
A durable Project-owned work identity that can retain a workspace binding and exact references across Station restarts.
_Avoid_: chat or Session

**Task workspace**:
The broader `/tasks/:taskId` Workspace Surface composition for one Task's identity, references, local files and diffs, receipts, and exact execution correlation. It may contain several Workspace Panes; it is not itself one Pane.
_Avoid_: Session detail

**Task experience**:
A named mode inside one Task workspace. Direct mounts Station's inspection and
room composition. Deliver, Learn and Operate name external product boundaries.
The current UI shows those optional modes when an enabled installed plugin
declares the corresponding capability; selecting one renders an explanatory
boundary and alternative link, not a product renderer or verified owner state.
_Avoid_: product tab when it would imply Station owns another product's state

**Task workspace binding**:
A server-derived snapshot of the Project working directory and optional Git top-level, worktree, and branch. Reopening revalidates the snapshot and reports it as `available`, `ambiguous`, or `unavailable`.
_Avoid_: caller-authorized path

**Project agent scope**:
The set of agents available in a project. Missing scope means all agents remain available for compatibility.
_Avoid_: global agent list when project scope exists

**Layout**:
A project's named view the sidebar navigates between: a server record whose type selects the renderer.
_Avoid_: page when plugin composition matters; region or arrangement when placement is meant

**Layout tab**:
The legacy plugin `layout.json` shape: a named area that hosts a Workspace Pane (a plugin
component, built-in component, or MCP-UI panel). A layout with N tabs maps onto a pane host
whose root is one tab group with N panes; it is migration input, not a target-model term.
_Avoid_: route

**Region**:
A fixed shell slot: main, left, right, or bottom. The shell owns it; nothing placed in a
region reads which region it is in.
_Avoid_: pane, panel, or a placement capability word from the Workspace Pane contract
(`supportedRegions`) when a shell slot is meant

**Surface**:
A registered shell surface with an ID, presentation metadata and allowed/preferred
regions. Chat and Activity are examples. Dock regions can retain several surface
tabs and select one; the main region holds at most one. Instance-keyed surfaces
such as individual file previews are resolved through the same placement boundary.
_Avoid_: a navigable destination (the app-shell destination registry); the Kontour Surface
product

**Pane host**:
A tree of Workspace Panes arranged as `split` and `tabs` nodes inside a region or a layout.
The persisted form is the Workspace Pane host document.
_Avoid_: layout, tab bar

**Arrangement**:
The user's placement choices across regions, surfaces, and pane hosts, persisted per device
(the `regionArrangement` device setting).
_Avoid_: layout, preference

**Layout action**:
A user-visible action attached to a layout or tab.
_Avoid_: command unless it is a slash command

**Layout component reference**:
The structured reference telling Station whether a tab hosts a plugin component, built-in pane, or MCP-UI panel.
_Avoid_: string component name when host type matters

**Workspace Pane descriptor**:
The versioned (`1.0`) data-only declaration of one workspace pane: its renderer
reference, bounded placement, one or more modes with their context requirements,
actions, provenance, lifecycle, and optional alternative renderer. A descriptor
does not prove availability, installation, authorization or renderer execution.
_Avoid_: Surface (the Kontour product) when the Workspace Pane contract is meant; see Flagged Ambiguities

**Workspace Pane renderer reference**:
A Pane descriptor's pointer to its rendering implementation: a built-in component, a trusted plugin component, or a sandboxed MCP App. Reuses the existing Layout component reference vocabulary and its security classes rather than replacing them. It is independent of the application host (Web, Tauri, Electron, or a future native shell).
_Avoid_: inventing a parallel renderer-kind vocabulary

**Workspace Pane host adapter**:
The edge that translates a Workspace Pane's host-neutral identity, lifecycle, availability, and requested placement into capabilities supplied by the current application shell. Native window/webview handles and geometry remain ephemeral adapter state and never enter the descriptor, instance, catalog, or persisted adaptation contract.
_Avoid_: Tauri- or Electron-specific fields in portable Pane data

**Workspace Pane host document**:
The versioned, data-only Station shell record for an ambient device scope, an
exact Project/Layout scope, or Task-owned Project/Task/Layout scope. It owns
bounded tab/split placement, exact instances, active/maximized/collapsed selection
and restoration. Ambient hosts do not borrow a synthetic Project. The document
contains no renderer callbacks, browser/native handles or authorization grants.
_Avoid_: treating a host document as a renderer runtime or an alternate LayoutDefinition

**Workspace Pane runtime**:
UI-local mount, suspend, resume, dispose, failure, and close-arbitration state for placed Pane instances. It is ephemeral and never persisted in a host document or storage adapter.
_Avoid_: overloading descriptor lifecycle maturity with renderer mount lifecycle

**Workspace Pane instance**:
One placed occurrence of a Pane descriptor, carrying its own `instanceId` and `stateKey` independent of the descriptor and of any other instance of the same descriptor.
_Avoid_: assuming one descriptor implies one instance

**Workspace Pane provenance**:
The declared contributor (`builtin`, `plugin`, or direct `mcp`) of a Pane descriptor. Security-sensitive renderer class remains on the renderer reference: a plugin can contribute a sandboxed MCP App while retaining its `pluginId` alongside the MCP server attribution.
_Avoid_: contributor identity branching in host code; provenance stays data

**Coding pane**:
The built-in `coding` occurrence. It gates the built-in Coding layout's host,
but that layout no longer places it: its Chat position is the Chat page of the
layout's navigation stack (`CodingWorkbench`, see
[placement](../../design/placement.md)). A host that does render the
occurrence gets `CodingChatPane`: the Chat position's effects and the Browser
launcher. Files, diff, terminal, plan, readiness, trust and Flow run console
are separate registered Pane renderers that a workspace can compose; they are
not all children of one monolithic Coding pane.
_Avoid_: IDE

**File Preview pane**:
A code-owned, read-only Workspace Pane occurrence for one workspace-relative
file. Its versioned state contains Project slug, relative path, optional bounded
line range, wrap and Markdown mode preferences, and an optional Session `thread`.
Without a thread it reads the Project checkout; with one, the route resolves
that readable Session's directory and refuses an unavailable or unauthorized
Session instead of falling back to the Project directory. The Session must
belong to the Project its start recorded, whatever its engine; a read-only
attached Session records none there and is refused. Its opaque
instance and state keys never encode a path, and host geometry never contains
file intent. The host restores it only when the builtin descriptor, renderer,
provenance, bound Project/source context, and separately validated state all
match the exact built-in contract. Source is coloured by the shared Shiki
highlighter (the chat highlight worker) and rendered as text, never markup; the
2,000-line render cap and any refusal to colour are stated in the pane. Its
Changes view reads that one file against HEAD through the preview route's own
path and Session rules (`file-preview/changes`), through the same confined
repository read as the coding diff (the Project's own repository, a judged
copy of its config, the output discarded when the repository changed under
the read; a repository being written answers busy, which the pane offers to
ask again), and refuses an oversized patch.
_Avoid_: an editor, browser, native file handle, or renderer supplied by persistence

**Readiness panel**:
The Station pane that shows Veritas merge readiness and the evidence behind it.
_Avoid_: CI badge

**Trust panel**:
The Station pane that renders Surface trust state for bundles and reports.
_Avoid_: static report

**Flow run console**:
The Station pane for live Flow run, gate, evidence, route-back, and exception state.
_Avoid_: Console projection

**Proposed change**:
A file or content change suggested by an agent or system and awaiting a decision.
_Avoid_: diff when decision lifecycle matters

**Proposed change decision**:
A human, agent, or system decision to approve, reject, or supersede a proposed change.
_Avoid_: review comment

**Navigation restore**:
Station's behavior of returning root navigation to the last project and layout.
_Avoid_: raw route push for project layout navigation

## Relationships

- A project owns layouts, knowledge configuration, agent scope, and working directory.
- A project owns durable Tasks; each Task remains distinct from the Sessions that may execute it.
- A Task workspace composes references and local inspection without owning Flow, Builder, Knowledge, or Console semantics.
- Task experience names retain their intended owners: Station (Direct), Builder Kit (Deliver), Knowledge Kit (Learn), and Console (Operate). [The current selector](../../../src-ui/src/views/task-experiences.ts) treats an enabled plugin's manifest capability as enough to list an optional mode as `available`. That is a declaration, not verification of a trusted owner contract. Generic Task external references do not enable modes. Optional modes currently show an explanatory boundary rather than invoking the declaring plugin.
- Only an `available` revalidated Task workspace binding permits local file or diff inspection. An `ambiguous` or `unavailable` snapshot remains visible for identity and recovery.
- The shell owns regions. Each dock region retains ordered surface tabs and a selected occupant; the main region holds at most one. A region or Layout composition mounts a Pane host, whose document arranges exact Pane instances in tabs and splits. The current move operation removes a surface from its previous region. The saved-record parser's tolerance for future duplicate instance placements does not mean this build offers copy-to-region behavior.
- A Workspace Pane descriptor owns identity, renderer reference, supported placement, mode-specific context requirements, actions, provenance, lifecycle and an optional alternative renderer. Each mode says which Project, Task, Session, run, workspace and source identities it needs; the instance records the exact bound identities. Neither replaces `LayoutDefinition`/`LayoutTab` persistence or render dispatch. The dock chooser enables a surface only when its code-owned instance factory can bind the current context; projectless Device and Project-bound coding panes therefore differ.
- Existing Layout tabs remain the baseline data — the additive Layout-to-Workspace-Pane adapter reads `LayoutTab.component`'s string and structured `LayoutComponentRef` shapes into a lossless retained-Layout record and writes the original tab shape back, never migrating or executing it. The current catalog read seam uses that adapter for built-ins, trusted plugin Layouts, and MCP Apps; it does not install, authorize, probe, or claim renderer availability.
- A Workspace Pane host document is an additive, bounded persistence layer for exact existing instances. Its parser rejects unsafe/version-mismatched/duplicate/orphan data; restoration quarantines a malformed child where valid siblings remain and reconstructs a bounded recovery document rather than trusting raw storage.
- Tab-group selection is local persisted presentation state. `activeInstanceId` remains the exact navigation/focus identity, while desktop visibility reconciles one selected occurrence per uncollapsed group (or the maximized occurrence); compact presentation still mounts only its active occurrence.
- Compact/mobile host presentation is a projection of host data, not hidden desktop geometry. It retains stable tab order and selection as data but mounts at most the active compatible Pane; inactive compact Pane renderers are suspended rather than left in the DOM.
- The host selection bridge writes only through the existing navigation store. URL/popstate/back-forward remains the navigation authority, while persisted host selection is merely a restoration candidate.
- Runtime callbacks, dirty or pending close arbitration, and renderer-failure isolation stay UI-local per instance. A renderer failure cannot dispose or reset its siblings.
- Portable Workspace Pane parsers accept already-deserialized plain data. They reject accessor-bearing data without evaluating getters, but browser JavaScript cannot prove an arbitrary object is not a Proxy without invoking Proxy meta traps. The Node catalog/plugin ingestion edge rejects Proxies before values enter the portable contract or adapter.
- A Workspace Pane renderer reference is the same three-way `builtin-component`/`plugin-component`/`mcp-tool-ui` vocabulary as a Layout component reference; trusted plugin React and sandboxed MCP Apps remain distinct security classes at every layer. Contributor provenance remains separate, so a plugin-declared MCP pane retains both contributor and MCP renderer attribution.
- Workspace Pane data is application-host neutral. The current Web/Tauri UI consumes it through adapters; this does not establish an Electron implementation. Native handles, APIs and geometry stay adapter-local. Unsupported behavior is expressed as typed availability.
- Availability combines rollout, installation/distribution, renderer presence, exact context, permission/configuration, deployment and host facts. The server catalog supplies only facts it owns; the [UI adapter](../../../src-ui/src/workspace-panes/workspacePaneAvailabilityAdapters.ts) adds renderer/native/client-observed facts and reruns the shared resolver. Missing required facts refuse availability. Catalog, add menu, launcher and route share this resolver rather than treating a saved descriptor as permission to render. Plugin visibility is supplied by the server's caller-bound grant policy and cannot be overridden by a plugin declaration.
- Availability telemetry is a bounded projection: built-in descriptor ID (or the single `contributed` category), state, and reason code only. Instance IDs, contributed raw IDs, paths, URLs, credentials, content, and arbitrary reasons never become metric attributes.
- A coding workspace composes separate file, diff, terminal, chat and evidence
  panes. The built-in Coding layout shows Chat on its stack's Chat page and
  each pane as a drill-in of a chromeless host whose selection is
  `navigationSelection="explicit"` below the wide fold and `"replace"` past
  it, where the pane is a side panel beside Chat (#3040); the Chat
  position's effects (the phone's maximized dock, the File Preview deep
  link — skipped for the intent the Files pane wrote itself) are
  `useCodingChatPositionEffects` in
  [CodingChatPane](../../../src-ui/src/workspace-panes/CodingChatPane.tsx),
  run by the stack while its Chat page is on screen. Neither owns the pane
  renderers or their state.
- File Tree opens File Preview through the provider-neutral Workspace Pane host
  open/focus seam. Preview state is separately bounded and keyed by opaque
  `stateKey`; corrupt and unreferenced interrupted state records are reclaimed
  without evicting state referenced by another live or persisted host. Source
  and plain-text content remains inert React text. The initial image allowlist
  is static PNG-only: the project-bound service checks signature, chunk
  framing/CRC, a narrow chunk allowlist/count, IHDR fields/dimensions, and byte
  and pixel caps before returning a bounded data URL. The UI revalidates its
  MIME and shape. SVG, APNG, compressed metadata, and other image formats
  remain unsupported rather than entering Station's trusted origin. Markdown
  keeps a persisted rendered/source preference, forces line reveals to the
  exact source projection, bounds rendered complexity, skips raw HTML, and
  replaces links/images with inert text. The bounded renderer is CommonMark;
  GFM remains disabled until a true pre-parse/AST budget can constrain bare
  autolinks and other extensions. HTML, PDF, browser handoff, editing, and
  native surfaces are separate increments.
- File Preview supplies a typed prepare/rollback pair. After preparing the host
  document, prepare writes one bounded state record; a failed preparation attempts
  rollback before the occurrence can become live authority. Storage failure can
  also defeat durable rollback. A retained host superset protects prior state
  references, and hydration quarantines an occurrence whose required state was
  never written. This is not a multi-record storage transaction or a guarantee
  that removal succeeded.
- File Preview open/rollback durability currently assumes one writer in the
  renderer context. Multi-tab or cross-context host single-writer coordination
  is `NOT_VERIFIED` and belongs to #1371; this slice does not claim distributed
  serialization through browser storage.
- Proposed changes retain Session/Project correlations and a persisted decision
  history. [ProposedChangeService](../../../src-server/services/projects/proposed-change-service.ts)
  records approval/rejection/supersession; that decision store does not itself
  apply a filesystem patch. Tool execution approval is a separate authority.
- Navigation restore depends on persisting project-layout selection, not just changing URL.

## Flagged Ambiguities

**Dashboard**:
Use Flow run console for session-context gate state and Console projection for cross-product operating state.

**Review / approval**:
A proposed change decision is review. Tool execution consent is approval.
