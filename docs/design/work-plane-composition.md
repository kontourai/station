# Work-Plane Composition: Station as the Native Host of the Kontour Work Plane

- **Status:** Shaped (builder.shape session `work-plane-composition`, 2026-07-20)
- **Owner:** Brian Anderson
- **Provenance:** Shaped interactively with the owner; decisions below record owner calls made during that session.

## Thesis

Station is the opinionated, native composition of the Kontour contracts — the flow-agents
engine for process and work, Console for view-and-act — where every piece is a published
abstraction with a local fallback, and owning the harness means the composition can be
enforced natively, not just suggested through runtime hooks.

Selling point, one line: *use the Builder Kit (or any kit) where you work today; get more
out of it in Station, where the concepts are built in.*

## Problem

Station has grown three parallel "work" concepts that do not speak to each other:

1. **Tasks board** (`TaskGraphService`, per-project `task-graph.json`, own 6-value status
   vocabulary) — a local dispatch queue with no provider, no assignment, no process link.
2. **Session Board** (`SessionBoardView.tsx`) — a bespoke, pre-token founding-commit kanban
   of orchestration sessions, visually divergent from the app (hardcoded light palette).
3. **flow-agents integration** — sidecar service + skills source at the process layer only;
   the boards are blind to work items, assignments, and workflow phase.

Meanwhile the suite already defines the abstractions Station reinvented locally:
flow-agents ships provider contracts (`WorkItemProvider`, `BoardProvider`, `ChangeProvider`,
`AssignmentProvider`) with a neutral work-item vocabulary, and Console ships a projection
contract (`console-core` `OperatingState`) plus a capability-descriptor/router act layer.

## Architecture

### Three altitudes of work

| Altitude | Owner | Contract |
| --- | --- | --- |
| Backlog (durable work) | Providers (GitHub first) | flow-agents work-item contract + schemas |
| Process (delivery state) | flow-agents sidecars | `state.json` / trust bundle / assignment records, keyed by `task_slug`, linked by `work_item_refs` |
| Execution (live runs) | Station orchestration | Station-native; projected outward as Console processes |

A Station "task" today conflates all three. After this epic: the Tasks board renders the
backlog altitude through providers; the Console board component renders the execution/process
altitudes through projections; the sidecar links them.

### Two Console planes (semantic authority vs execution transport)

- **View plane** (hub + projections): never semantic authority — unchanged invariant
  (Console ADR 0003). Station builds `OperatingState` in-process via `@kontourai/console-core`;
  no hub required at runtime.
- **Act plane** (host bindings + executable router): routes intents only to product-owned
  authority. Products keep semantic authority; Console routes. Station binds board intents
  in process from its typed host-command catalog through Console's `HostIntentBinding`
  resolution; this makes no CLI executable claim. A `ProductCapabilityDescriptor` remains
  the router contract for products that ship the executable it advertises. Console UI
  components emit **intents, never execute**; unbound intents render inert (standalone
  Console remains read-only-plus-CLI until an opt-in runner exists).

### The harness gradient

1. **Any runtime, today** — kits via hooks/CLIs/sidecars: portable, advisory-strength.
2. **Runtimes that improve** — same contracts; richer host hook surfaces climb toward the
   spec'd capabilities (the upstream-proposal precedent: Station files contract asks
   upstream — e.g. flow-agents#86, where native orchestration-layer enforcement was
   adopted as a *named capability*, per the maintainer not a new conformance level —
   with Station's implementation as the reference).
3. **Station** — native enforcement (policy classes as the consent layer), boards bound to
   providers, dispatch that claims assignments, Console emission built in.

Non-divergence invariant: **process truth lives only in the canonical artifacts** (sidecar,
trust bundle, assignment records). Station state is additive. The operational test is the
cross-runtime round-trip (see Success criteria).

## Decisions (owner-ratified 2026-07-20)

1. **Vocabulary**: adopt the flow-agents neutral work-item status vocabulary in Station's
   task contract, with anti-drift identity tests against the installed package's exported
   enums and shipped JSON schemas (the `workflow.ts` / console-bridge `validateEvent`
   pattern, made mandatory). Upstream ask: export work-item/provider types as values.
2. **Provider seam**: Station reads the same flow-agents provider settings files
   (`backlog-provider-settings`, `assignment-provider-settings`, workspace → project →
   defaults) — no Station-specific provider config. Local provider (today's
   `task-graph.json`) is the zero-dependency fallback, mirroring flow-agents' local-file
   precedent.
3. **Dispatch = pull-work + claim**: selection semantics (`ready_statuses`, `wip_policy`,
   `zero_ready_items` dead-source warning) reused verbatim; dispatch records an
   AssignmentProvider claim with actor `{runtime:'station', session_id, host}`.
4. **Two-way sync, provider-neutral (owner call)**: work-item write-back is an **upstream
   flow-agents engine contract extension** (WorkItemProvider mutation operations: status and
   field updates, comments, with a declared conflict policy building on the existing
   planned-base/drift fields and the GitHub adapter's render-don't-execute discipline).
   Station implements the contract; it never gets Station-specific sync.
5. **Console board componentization (inverted hybrid)**: Console's board/timeline/fleet
   views become a published component layer (`@kontourai/console-ui` on `@kontourai/ui`
   tokens + `console-core` types), components take `(OperatingState, IntentHandler)`.
   Station mounts the board and **deletes** `SessionBoardView`. Products keep shipping
   panels Console mounts (existing direction); this adds the inverse direction.
6. **Naming (owner call)**: Station UI keeps **"Tasks"**; glossary formally maps Station
   "task" = suite "work item" + dispatch affordance. Contracts/code use work-item terms.
   The Console board becomes *the* board; "Session Board" retires with its view.
7. **No interim re-theme (owner call)**: `SessionBoardView` stays as-is until the Console
   board component replaces it.
8. **Degradation matrix**: no sibling service, account, or installation is required at
   runtime for Station to function. Published packages as library dependencies are
   acceptable composition; hubs/telemetry/hosted anything remain opt-in.
9. **Hosted act is out of scope** for this epic (local-only act plane; ADR 0003
   multi-tenant interplay deferred).
10. **Docs cleanup**: glossary entries disambiguating the three "planes" (Console operating
    plane = projection; emitter-sink control/record plane = data taxonomy; Station control
    plane = `station-control` execution surface); refresh stale C-series facts in
    `kontour-integration-surface.md` (verified against Console 0.3.0; source now 2.6.x with
    C2 resolved and C1 resolved at workspace level but not in the published root manifest);
    supersede the Console-convergence SPLIT log with this inverted-hybrid decision, noting
    the revisit trigger's C1/C2 leg moved.

## Success criteria (epic DoD, dogfood-proof style)

One board rendering a terminal Builder-Kit session and a Station session side by side, from
projections; click-to-act on the Station session routes through host-binding
resolution; and a cross-runtime round-trip (start a work item in a terminal Claude Code
session, continue in Station, close from Codex, same `task_slug`) yields a valid trust
bundle. Migration: existing `task-graph.json` files map losslessly onto the aligned
vocabulary.

## Non-goals

- Replacing `TaskGraphService`'s dispatch/relations role with the 13-status workflow model
  (wrong altitude).
- A backlog view inside Console (no work-item record source exists there; may follow later).
- A standalone Console execution runner (trails the epic; consent spec is the prerequisite).
- Hosted/multi-tenant act.

## Risks

- **Projection fidelity**: Station session lifecycle states (`needs_input`,
  `review_pending`, blocked reasons) must land in the projection schema or the board shows
  mush — upstream schema extension is on the critical path.
- **Console publish inconsistency**: README documents `require('@kontourai/console')`;
  the publish workflow ships the exports-less root manifest. Verify the published tarball
  before Station consumes anything beyond `console-core`.
- **Double enforcement**: Station-native policies + in-runtime flow-agents hooks firing in
  the same session should agree (same policy classes) — needs an explicit test, not a hope.
- **Worktree artifact roots**: sidecars written from linked worktrees landing in the main
  checkout (known footgun) — must be mechanically correct in the harness.
- **Full-suite hang**: `npm test` hangs environmentally at a fixed point (suspected
  hermetic-openssh lane) — bisect chore filed with the epic; CI is the arbiter meanwhile.

## Slices (breakdown; per-repo lanes)

### flow-agents
- FA1. Export work-item/provider vocabularies and types from the library entry (values +
  schema-derived types), so hosts stop mirroring by hand.
- FA2. WorkItemProvider mutation extension (two-way sync contract): operations, conflict
  policy, adapter mapping (GitHub first, render-don't-execute), settings schema rev.
- FA3. Provider TS interfaces for native hosts (WorkItemProvider/BoardProvider/
  AssignmentProvider as importable contracts, matching the documented CLIs).
- FA4. Confirm/extend telemetry descriptors to carry the session states the board needs.
- FA5. Track the native-enforcement capability outcome on flow-agents#86 (already filed;
  maintainer reframed it as a named capability, not a conformance level) and align
  Station docs that still say "L3 spec staged for upstream filing" — file nothing new.

### console
- C1. Fix publish: ship the console-server manifest (or hoist exports) so the published
  `@kontourai/console` matches the README; verify tarball; close the C-series.
- C2. Projection-schema extension: generic process states for interactive sessions
  (`needs_input`, `review_pending`, blocked reason) + validator updates.
- C3. `@kontourai/console-ui`: componentize board/timeline/fleet as published components
  taking `(OperatingState, IntentHandler)`; board gains status-grouped (kanban) mode.
- C4. Intent-binding + consent policy spec: how hosts declare bindable authorities; inert
  rendering of unbound intents; consent metadata beyond "transparency, not consent".
- C5. (Trailing) opt-in standalone runner wrapping the router for click-to-act without a
  host product.

### station
- S1. Vocabulary alignment + anti-drift identity tests + `task-graph.json` migration
  (first slice: no upstream dependencies, immediate value).
- S2. Sidecar join: surface workflow phase/status in task and session detail via the
  existing workflow-sidecar-service, keyed by `task_slug`/`work_item_refs`.
- S3. Provider seam: WorkItemProvider/BoardProvider consumption (local + flow-agents
  contract backends), reading shared provider settings; Tasks board renders provider-backed
  work (read path; write path follows FA2).
- S4. Dispatch-as-claim via AssignmentProvider (local-file backend first).
- S5. Maintain Station's in-process host-command catalog for board/task actions and bind
  them through host-binding resolution. Publish a capability descriptor only with a real
  Station executable.
- S6. In-process `OperatingState` derivation (reuse console-bridge mapping); mount the
  Console board component; delete `SessionBoardView`; double-enforcement test.
- S7. Docs/glossary cleanup per Decision 10; SPLIT supersession record.
- S8. Chore: bisect the environmental full-suite hang (suspected hermetic-openssh lane).

Dependency notes: C2 → C3 → S6; FA1 → S1(tests harden); FA2 → S3 write path; FA3 → S3/S4
typed backends; C4 → S5. S1/S2/S8 have no upstream dependencies and start immediately.
