# Workspace Surfaces Context

Workspace Surfaces covers how Station presents projects, layouts, experiences,
file work, proposed changes, trust state, and review state to users. A
Workspace Pane is the smallest addressable UI unit within a surface,
experience, or layout; it is not a replacement name for this bounded context,
and it is never the Kontour Surface product.

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
A mode inside one Task workspace that keeps Task identity visible while presenting Direct, Deliver, Learn, or Operate work. Every mode discloses its owning product and actual availability.
_Avoid_: product tab when it would imply Station owns another product's state

**Task workspace binding**:
A server-derived snapshot of the Project working directory and optional Git top-level, worktree, and branch. Reopening revalidates the snapshot and reports it as `available`, `ambiguous`, or `unavailable`.
_Avoid_: caller-authorized path

**Project agent scope**:
The set of agents available in a project. Missing scope means all agents remain available for compatibility.
_Avoid_: global agent list when project scope exists

**Layout**:
A project view or standalone workspace surface.
_Avoid_: page when plugin composition matters

**Layout tab**:
A named area inside a layout that hosts a Workspace Pane: a plugin component,
built-in component, or MCP-UI panel.
_Avoid_: route

**Layout action**:
A user-visible action attached to a layout or tab.
_Avoid_: command unless it is a slash command

**Layout component reference**:
The structured reference telling Station whether a tab hosts a plugin component, built-in pane, or MCP-UI panel.
_Avoid_: string component name when host type matters

**Workspace Pane descriptor**:
The versioned (`1.0`) data-only declaration of one workspace pane: its renderer reference, bounded placement, context requirement, actions, provenance, lifecycle, and optional alternative renderer. Never claims availability, installation, authorization, or renderer execution.
_Avoid_: Surface (the Kontour product) when the Workspace Pane contract is meant; see Flagged Ambiguities

**Workspace Pane renderer reference**:
A Pane descriptor's pointer to its rendering implementation: a built-in component, a trusted plugin component, or a sandboxed MCP App. Reuses the existing Layout component reference vocabulary and its security classes rather than replacing them. It is independent of the application host (Web, Tauri, Electron, or a future native shell).
_Avoid_: inventing a parallel renderer-kind vocabulary

**Workspace Pane host adapter**:
The edge that translates a Workspace Pane's host-neutral identity, lifecycle, availability, and requested placement into capabilities supplied by the current application shell. Native window/webview handles and geometry remain ephemeral adapter state and never enter the descriptor, instance, catalog, or persisted adaptation contract.
_Avoid_: Tauri- or Electron-specific fields in portable Pane data

**Workspace Pane host document**:
The versioned, data-only Station shell record for one exact Project/Layout scope or Task-owned Project/Task/Layout scope. It owns bounded tab/split placement, exact existing instances, active/maximized/collapsed selection, and restoration; it never fabricates a Task identity or contains renderer callbacks, browser/native handles, authorization, or availability claims.
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
The Station pane for file tree, diff, terminal, chat, readiness, trust, and run context.
_Avoid_: IDE

**File Preview pane**:
A code-owned, read-only Workspace Pane occurrence for one Project-relative
source or plain-text path. Its versioned pane state contains only project slug,
relative path, optional bounded line range, and wrap preference; its opaque
instance and state keys never encode a path, and host geometry never contains
file intent. The host restores it only when the builtin descriptor, renderer,
provenance, bound Project/source context, and separately validated state all
match the exact built-in contract.
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
- A Task experience keeps Task identity in Station while its owning authority remains Station (Direct), Builder Kit (Deliver), Knowledge Kit (Learn), or Console (Operate).
- An optional Task experience remains `unavailable` until a typed, trusted owner contract proves it is available; a generic opaque external reference is never promoted into owner state.
- Only an `available` revalidated Task workspace binding permits local file or diff inspection. An `ambiguous` or `unavailable` snapshot remains visible for identity and recovery.
- A layout hosts tabs; tabs host Workspace Panes. A surface or experience may compose several layouts and panes.
- A Workspace Pane descriptor owns identity, renderer reference, supported placement capability set, context requirement, actions, provenance, lifecycle, and optional alternative renderer. A descriptor's requirements say which exact Project, Task, Session, run, workspace, and source identities a host must provide; the distinct Pane instance records the exact identities actually bound for that occurrence. Neither form owns or replaces `LayoutDefinition`/`LayoutTab` persistence or render dispatch.
- Existing Layout tabs remain the baseline data — the additive Layout-to-Workspace-Pane adapter reads `LayoutTab.component`'s string and structured `LayoutComponentRef` shapes into a lossless retained-Layout record and writes the original tab shape back, never migrating or executing it. The current catalog read seam uses that adapter for built-ins, trusted plugin Layouts, and MCP Apps; it does not install, authorize, probe, or claim renderer availability.
- A Workspace Pane host document is an additive, bounded persistence layer for exact existing instances. Its parser rejects unsafe/version-mismatched/duplicate/orphan data; restoration quarantines a malformed child where valid siblings remain and reconstructs a bounded recovery document rather than trusting raw storage.
- Tab-group selection is local persisted presentation state. `activeInstanceId` remains the exact navigation/focus identity, while desktop visibility reconciles one selected occurrence per uncollapsed group (or the maximized occurrence); compact presentation still mounts only its active occurrence.
- Compact/mobile host presentation is a projection of host data, not hidden desktop geometry. It retains stable tab order and selection as data but mounts at most the active compatible Pane; inactive compact Pane renderers are suspended rather than left in the DOM.
- The host selection bridge writes only through the existing navigation store. URL/popstate/back-forward remains the navigation authority, while persisted host selection is merely a restoration candidate.
- Runtime callbacks, dirty or pending close arbitration, and renderer-failure isolation stay UI-local per instance. A renderer failure cannot dispose or reset its siblings.
- Portable Workspace Pane parsers accept already-deserialized plain data. They reject accessor-bearing data without evaluating getters, but browser JavaScript cannot prove an arbitrary object is not a Proxy without invoking Proxy meta traps. The Node catalog/plugin ingestion edge rejects Proxies before values enter the portable contract or adapter.
- A Workspace Pane renderer reference is the same three-way `builtin-component`/`plugin-component`/`mcp-tool-ui` vocabulary as a Layout component reference; trusted plugin React and sandboxed MCP Apps remain distinct security classes at every layer. Contributor provenance remains separate, so a plugin-declared MCP pane retains both contributor and MCP renderer attribution.
- Workspace Pane contracts are application-host neutral. Web, Tauri, Electron, or future native shells consume the same descriptor, instance, catalog, and restoration data through adapters; native handles, APIs, and geometry remain adapter-local. Unsupported host behavior is expressed later as typed availability rather than a forked contract.
- Workspace Pane availability composes product rollout, renderer presence, exact Project/workspace/Git context, deployment capability facts, and the typed native capability adapter at the catalog edge. Missing or malformed host/deployment facts fail closed to an actionable unavailable state; UI consumers never read Tauri globals or infer support from a platform name. Catalog, add menu, command launcher, and direct route consume that one resolved state/reason/action instead of reimplementing availability.
- Availability telemetry is a bounded projection: built-in descriptor ID (or the single `contributed` category), state, and reason code only. Instance IDs, contributed raw IDs, paths, URLs, credentials, content, and arbitrary reasons never become metric attributes.
- The coding pane can show readiness, trust, run console, file tree, terminal, chat, and proposed changes together.
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
- File Preview supplies the host a typed prepare/rollback pair: prepare writes
  one atomic bounded state record, and every rejected host or state prepare
  invokes rollback removal before the occurrence can become live authority.
- File Preview open/rollback durability currently assumes one writer in the
  renderer context. Multi-tab or cross-context host single-writer coordination
  is `NOT_VERIFIED` and belongs to #1371; this slice does not claim distributed
  serialization through browser storage.
- Proposed changes belong to sessions and projects and require decisions before they become accepted work.
- Navigation restore depends on persisting project-layout selection, not just changing URL.

## Flagged Ambiguities

**Dashboard**:
Use Flow run console for session-context gate state and Console projection for cross-product operating state.

**Review / approval**:
A proposed change decision is review. Tool execution consent is approval.
