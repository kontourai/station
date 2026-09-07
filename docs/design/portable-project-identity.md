# Design: portable Project identity — remote-keyed resources, per-Station bindings

> Status: **draft for owner review (2026-08-01, revision 2); tracking issue
> [#1425](https://github.com/kontourai/station/issues/1425).** Twelve open
> questions are open — see §9, each with a recommendation; OQ-12 is explicitly
> owner-pending rather than merely undecided. This doc is the
> proposed contract for the arc: the manifest/binding split, the membership /
> contribution / backing model, the canonicalization rules, the migration seam,
> and the slice plan. Revise this doc — not just the code — when direction
> changes.
>
> **Revision 2 (owner feedback, 2026-08-01)** adds §4 (membership is not
> backing; contribution as the explicit per-space offer; binding stays
> private), the requirements/compliance sketch (§4.4), the vocabulary table
> (§4.5), the local-only invariant and progressive-disclosure principle (§4.6),
> the backing-view sketch (§4.7), and
> OQ-11. It narrows "unresolvable for you" to an attempted-and-denied state
> only (§3.6), and corrects the routing constraint from *binding* to
> *contribution* (§6.1) — having a checkout is not consent to have work routed
> into it. Contribution's primary grain is **per shared space**, with the
> shipped fleet opt-in as the degenerate global instance of one contract
> (§4.2). §4.4 sketches project requirements and offer compliance as
> **direction only** — the owner flagged it for further thought, and OQ-12
> carries its three unsettled sub-questions. Fleet slices 1–2 landed between
> revisions, so
> `packages/contracts/src/fleet-contribution.ts` is now a shipped contract to
> generalize rather than a doc-only pattern (§2.8, §4.2).
>
> Every claim about current behavior carries file:line evidence; §11 lists what
> is UNVERIFIED. Refs #1392 (multi-tenant tier — the consumer that forces the
> split), #1398/[inference-fleet](inference-fleet.md) (contribution pattern,
> binding-aware routing constraints), #1123 (delegate_task targeting), #1302
> (project scoping designed but dead), #1409 (shareable provenance), #741
> (personal fleet).

## 0. Naming and sources

The open-source forge whose multi-repo project entity #1425 cites as prior art
is called **"the reference forge"** throughout this doc. The one fact this doc
borrows from it — that its *only* custom event kind is a multi-repo project
grouping, signed by one principal and spanning repos owned by different people
— is recorded in #1425. The separate attributed research record is not required
to understand or implement this design.

"Resource" in this doc means a thing a Project references — today: a git repo,
a knowledge root, an agent, an MCP integration, a layout. It does **not** mean
a generalized resource graph; #1425 rules that out of scope and so does §8.

## 1. Problem: three concerns fused into one optional string

`ProjectConfig.workingDirectory` (`packages/contracts/src/project.ts:9`) is one
optional string carrying three concerns that have to separate:

1. **What the project *is*** — its identity, name, and membership. Shared.
2. **What it *references*** — which repos, which knowledge, which agents,
   which integrations. Shared.
3. **Where those resources *live on this machine*** — an absolute (or
   tilde-prefixed) filesystem path. Irreducibly local.

Everything downstream inherits the fusion. Five route families derive their
entire state from `slug → workingDirectory → read the directory`
(`src-server/runtime/routes/runtime-routes.ts:735-742` and its consumers). The
Kontour product integrations — Flow, Veritas, Survey, Flow Agents,
diff-comments — are pure convention over that path. Knowledge scanning falls
back to it (`src-server/services/knowledge/knowledge-scan-utils.ts:88-106`).
Every engine session's cwd is settled from it
(`src-server/services/orchestration/orchestration-service.ts:616-688`).

There is a fourth concern the current model cannot express at all, and §4
addresses it: **what a machine offers a project** is neither identity,
reference, nor location. Today, having a path implies offering the machine,
because a path is the only thing there is.

Three consumers now need the split, and none of them can be served by a path:

- **#1392 maps channels to projects.** A channel is shared state on a server;
  a machine-local path cannot be the shared half of that mapping. Two members
  of one channel have different checkouts of the same repo at different paths,
  and one of them may have no checkout at all — and, per §4.1, may never want
  one.
- **#1123 wants "run this on a Station that has repo X."** Today
  `delegate_task` takes an explicit `environmentId` plus a `projectSlug`, and
  the slug join is only sound if both Stations independently happen to have
  created a project with the same slug
  (`src-server/tools/station-control-delegation.ts:97-124`). There is no
  portable identity to constrain on.
- **#1409 wants location-independent provenance.** Content-addressed snapshot
  refs are already location-independent, but R6 requires every source read to
  be "authorized in the caller's current Project/room context" — and a
  path-keyed project cannot be a shared authorization context.

#1302 already recorded the symptom from the other end: project scoping is
"designed but dead" — `ConversationRecord.projectId` exists and is never
written, `projectSlug` is emitted on the wire and thrown away by the route's
return type. Scoping stayed dead partly because there was nothing durable to
scope *to*.

**Non-goal, explicitly.** This is not a multi-repo checkout orchestrator. v1
*records* where resources are; it does not clone, sync, or lay out repos for
you beyond one convenience path (§10 slice 4).

## 2. Current state, verified

### 2.1 `ProjectConfig` is a flat local record, and `slug` — not `id` — is the real key

`packages/contracts/src/project.ts:3-20` is a plain TS interface with no zod
schema, persisted verbatim as JSON at `<home>/projects/<slug>/project.json`
(`src-server/domain/file-storage-adapter.ts:89-97` — whole-file overwrite, no
merge, no schema version, no write lock). `<home>` is
`process.env.STATION_HOME || ~/.station` (`src-server/utils/paths.ts:11-13`).

`id` is a per-machine `randomUUID()` (`src-server/services/projects/project-service.ts:65`).
It has no portable meaning and mapping id → slug is an O(n) scan of every
`project.json`. **`slug` is the routing key everywhere**: the on-disk directory,
every `/api/projects/:slug/*` route, `LayoutConfig.projectSlug`,
`KnowledgeRootScope`, the delegation input. Any portable identity has to be
introduced alongside `slug`, not in place of it.

The only validation is at the HTTP boundary and it is `.passthrough()`
(`src-server/routes/schemas/schema-definitions/content.ts:81-90`): `name`,
`slug`, `workingDirectory`, `description`, all optional except `name`.
Arbitrary extra fields reach disk unvalidated — which makes an additive
manifest field cheap to introduce and impossible to rely on.

The UI redeclares `ProjectMetadata`/`ProjectConfig` independently of the
contracts package and drops `knowledgeNamespaces`
(`src-ui/src/contexts/ProjectsContext.tsx:4-27`). Two definitions of one entity
in one repo; any new contract has to land in both or converge them first.

### 2.2 `workingDirectory` is the only local field, and its consumers concentrate in five seams (**the "five seams" claim was wrong — see §2.2.1**)

> **Correction, slice 3b (station#1501).** The five-seam claim in this
> section's heading and table **understated the surface**. §11 flagged it as a
> grep sweep that was never exhaustively re-derived; slice 3b re-derived it and
> found **eight further forward-resolution consumers** the table never named,
> plus **two false attributions inside the table itself** (struck below).
> §2.2.1 carries the full classified sweep. This section is kept for its
> narrative; §2.2.1 is the authority on *what actually reads the field*.

The value is stored **as the user typed it, with a literal `~`**, and expanded
inconsistently at each consumer. Write-side normalization is UI-only (trim +
strip trailing slashes; no tilde expansion, no absolutization). So `~/dev/repo`,
`~/dev/repo`, and a symlinked path are three different strings at
rest denoting one tree, and **no single stored form is authoritative**.

The five seams the original sweep named (line numbers refreshed at slice 3b;
the struck cells are corrections, not refreshes):

| Seam | file:line (2026-08-02) | What it serves |
|---|---|---|
| `resolveStartSessionCwd` | `src-server/services/orchestration/orchestration-service.ts:616-688` | Every engine session's cwd — Claude, Codex, ACP, station-agent |
| `resolveWorkspacePath` | `src-server/runtime/routes/runtime-routes.ts:902-909` | Flow, Veritas, Survey, Flow Agents, work-items, operating-state, ~~trust-bundles~~, ~~diff-comments~~ — **false: trust-bundles and diff-comments each read `project.workingDirectory` themselves and never call this function (see A1/A2/A3 in §2.2.1)** |
| `resolveKnowledgeScanPath` | `src-server/services/knowledge/knowledge-scan-utils.ts:88-106` | Knowledge scanning (namespace `storageDir` wins; else the working directory) |
| `readProjectWorkingDirectory` / `deriveWorkspaceBinding` | `src-server/services/projects/task-graph-service.ts:726-790` | Task workspace bindings, `repoRoot`/`branch` derivation. **Incomplete: dispatch claims resolve through a *separate* injected resolver (`setProjectWorkspaceResolver`), which the table never named — A7 in §2.2.1** |
| `resolveAttachedProjectRoot` | `src-server/services/orchestration/attached-session-follow-service.ts:388-430` | The **reverse** map: an attached session's cwd → a project slug. **Incomplete: `OrchestrationService.resolveAdoptionProject` is a second caller — A8** |

Three things ride outside the seams and matter for migration:

- The **git route family is already path-keyed, not slug-keyed**:
  `/git/status`, `/git/log`, `/git/diff`, `/repos`, `/git/commit` etc. all take
  `?path=` (`src-server/routes/projects/coding.ts:185-463`) and the UI supplies
  `project.workingDirectory`. These need no server change — the UI just sources
  the path from a resolver instead.
- The **coding layout used to carry a second, drifting copy**: `workingDirectory`
  was auto-injected into a new coding layout's `config`, backfilled on read, and
  re-injected on catalog apply. This was the warning about what happens when a
  local path is copied rather than resolved, and it is the pattern the binding
  layer must not repeat. **Closed by slice 0 (station#1497):** the value is now
  derived from the owning project on read and stripped on every write
  (`src-server/routes/projects/layout-working-directory.ts`), so a copy already
  on disk is inert immediately and cleared by the next write. The residual is
  recorded there: a layout whose `type` moves away from `coding` in the same
  write keeps its copy, which nothing reads.
- `src-server/services/projects/project-icon-discovery.ts:124-126` scans the
  workspace for icon candidates — a genuinely local-only read that should stay
  binding-side.

`resolveStartSessionCwd`'s docblock is the single best statement of the
existing contract and the new one must not regress it
(`orchestration-service.ts:577-615`; line refs in this section corrected at
slice 3b — see §2.2.1): a project-bound chat "either launches in a
real, resolved directory or fails loudly enough to name the project and the
path"; a project **without** a `workingDirectory` is deliberately not an error
— it is "an organizational/knowledge scope, not a directory binding", and its
chats terminate at `$HOME`.

That last rule is load-bearing and two subsystems already disagree about it:
`resolveStartSessionCwd` treats an absent directory as a valid global chat,
while `task-graph-service.ts` treats an unresolvable project workspace as
`unavailable` (`deriveWorkspaceBinding`, `:743-760`) and then `blocked`
(`claimForDispatch`, `:1069-1082`), refusing dispatch. Any binding design owes an explicit answer
for the unbound case, because there is no consistent one today. §4.1 argues
that the split is not accidental — the two subsystems are answering for two
different kinds of participation.

### 2.2.1 The re-derived sweep (slice 3b, station#1501) — the five-seam claim understated the surface

§11 recorded that "~40 consumers reduce to five seams" came from a grep sweep,
was spot-checked only at the five named places, and **would not show a consumer
reading `workingDirectory` off `ProjectMetadata` or off a layout config**.
Slice 3b re-derived it exhaustively (case-insensitive `workingDirectory` /
`workingDir` sweep across `src-server`, `packages/contracts/src`, `src-ui/src`,
plus every `listProjects()` and `getProject()` call site, on
`origin/main` @ `4338e2a7`, 2026-08-02). The result:

**The claim was wrong in four distinct ways.**

1. **Eight further server-side forward-resolution consumers exist** that the
   table never named (A1–A9 below, of which A5/A6 turn out not to be local
   reads at all — see point 4).
2. **Two cells of the table were false attributions.** Trust-bundles and
   diff-comments were listed as things `resolveWorkspacePath` serves. They are
   not: each reads `project.workingDirectory` directly, in its own closure,
   with its own `expandTilde` call and its own failure behaviour. Migrating
   `resolveWorkspacePath` alone would have left both unmigrated while the doc
   said they were done — the exact shape of an unearned completion claim.
3. **Two named seams were themselves incomplete.** Seam 4 has a *second*
   input — the injected `resolveProjectWorkspace` (A7), which serves every
   assignment-claim artifact root and is not reached through
   `readProjectWorkingDirectory`. Seam 5 has a *second caller* — session
   adoption (A8).
4. **Two apparent consumers are not local reads.** `execution-target-resolver`
   and `station-control-delegation` fetch a project over
   `EnvironmentAccess.apiBase`, which is routinely a **remote** Station reached
   over SSH or a tunnel. A local resolver is the wrong instrument there: it
   would answer for *this* machine's filesystem about *another* machine's
   checkout. `station-control-delegation.ts:833-841` already documents that
   asymmetry for the `existsSync` question. These are recorded as
   **cross-machine**, not as deferred work, and no future slice should
   "finish" them by pointing them at `resolveProjectResource`.

**Classified sweep.** `S` = named seam, `A` = additional server-side
forward-resolution consumer, `X` = cross-machine (not a local read),
`B` = legitimately binding-side, `W` = write path, `R` = the resolver's own
compat/backfill branch, `C` = client-side, `P` = downstream of an
already-resolved path (not a read of the field).

| # | file:line (2026-08-02) | What it does | Class | Slice 3b |
|---|---|---|---|---|
| S1 | `orchestration-service.ts:616-688` (callers `:1980`, `:4759`) | `resolveStartSessionCwd` — every engine session's cwd | S | **out of scope** — slice 3a shadows it, slice 3c flips it |
| S2 | `runtime-routes.ts:902-909` | `resolveWorkspacePath` → Flow, Veritas, Survey review store, workflow sidecars, work-items, operating-state | S | **deferred** — migrated in slice 3b's first round and **reverted** after review. The contract gap that forced the revert is closed by station#1594; the re-migration (onto the *directory-question* adapter) is its own follow-up. See the note below |
| S3 | `knowledge-scan-utils.ts:88-106` | `resolveKnowledgeScanPath` | S | **migrated** |
| S4 | `task-graph-service.ts:726-790` | `readProjectWorkingDirectory` / `deriveWorkspaceBinding` | S | **migrated** |
| S5 | `attached-session-follow-service.ts:388-430`, fed at `:148-151` | `resolveAttachedProjectRoot` roots | S | **migrated** (root *sourcing* only; the #1462 tie-break is untouched) |
| A1 | `runtime-routes.ts:1000-1035` | trust-bundle `resolveLocations` — workspace path + Veritas evidence dirs | A | deferred — falsely attributed to S2; independent failure semantics (returns `undefined` for the whole location set) |
| A2 | `runtime-routes.ts:1041-1055` | diff-comments `resolveStorePath` | A | deferred — same false attribution; per-project store path |
| A3 | `runtime-routes.ts:1058-1068` | diff-comments aggregate `listStorePaths` | A | deferred — **reads `ProjectMetadata.workingDirectory` off `listProjects()`**, the exact class §11 warned about; an N-project fan-out that a per-project async resolver changes the cost model of |
| A4 | `chat-request-preparation.ts:141-145` | Flow Agents workflow-steering cwd for managed chat | A | deferred — fail-open by design; lives on the chat request path that slice 3c is already reshaping |
| A5 | `execution-target-resolver.ts` | Exact remote-POSIX identity match of a project dir against `access.verifiedProjectPath` | **X** | **closed (station#1870)** — `deps.getProject(access, slug)` remains a possibly-remote HTTP read, so this uses no local filesystem seam; remote verification supplies `remoteHome` for exact `~/` expansion and legacy SSH profiles fail closed |
| A6 | `station-control-delegation.ts` | Delegation target project path + `slugJoin` corroboration | **X** | **closed (station#1870)** — same remote-only contract: both sites share the pure-string comparator, and corroboration remains stricter raw byte equality |
| A7 | `station-runtime.ts:560-567` → consumed at `task-graph-service.ts:1020`, `:1220`, `:1411`, `:1491` | `setProjectWorkspaceResolver` — assignment-claim artifact roots | A | **migrated** — it is seam S4's second input, not a separate surface |
| A8 | `orchestration-service.ts:4017-4041` | `resolveAdoptionProject` — second caller of `resolveAttachedProjectRoot` | A | deferred — in `orchestration-service.ts`, owned by slices 3a/3c |
| A9 | `projects.ts:114-116`, emitted at `:340`, `:381`, `:496`, `:590` via `layout-working-directory.ts:83-95` | Derives a coding layout's `config.workingDirectory` on read | A | deferred — the **layout-config class** §11 warned about; slice 0 (#1497) owns this file, and its output is consumed client-side (C1, C2), so it migrates with slice 4 |
| B1 | `project-icon-discovery.ts:123-126`, called from `routes/projects/projects.ts:195-204` | `discoverProjectIconCandidates(workspacePath)` — scans a **client-supplied** `?path=` for icon candidates | B | **not a `workingDirectory` read at all** (correction, slice 3b review): the file contains no reference to the field. Same class as B2 — an execution boundary over a path the client already chose |
| B2 | `terminal-service.ts:62-74` | Refuses an empty cwd, expands `~` on a **client-supplied** path | B | execution boundary for C1, not a project read |
| W1 | `project-service.ts:53-54` | Derives a default project name from the directory at create | W | write path |
| W2 | `file-storage-adapter.ts:71-72` | Projects `hasWorkingDirectory` / `workingDirectory` into `ProjectMetadata` | W | the source A3 reads |
| W3 | `schema-definitions/content.ts:85` | HTTP boundary schema (`.passthrough()`) | W | write path |
| W4 | `layout-working-directory.ts:44,58-95` | Strips the persisted layout copy on write (slice 0) | W | write path |
| W5 | `routes/orchestration/tasks.ts:22` | Request schema for a supplied `TaskWorkspaceBinding` | W | write path |
| W6 | `task-graph-service.ts:154,163,194` | `workspaceValuesConflict` — compares a supplied binding against the derived one | W | operates on `TaskWorkspaceBinding`, never on `ProjectConfig` |
| R1 | `project-resource-resolver.ts:274-322` | The resolver's own compat branch | R | by construction |
| R2 | `project-manifest-store.ts:547-554` | Backfill derivation | R | write path |
| C1 | `TerminalPanel.tsx:118` | Sends `cwd` from the coding-layout config | C | client-side; downstream of A9 |
| C2 | `useGitActions.ts:56-166`, `useGitStatus.ts:3-11` | Supply `?path=` to the already-path-keyed git route family | C | client-side; §2.2 already records the plan |
| C3 | `new-chat-modal-utils.ts:72,286`; `NewChatModal.tsx:581-587`; `useChatDockViewModel.ts:87`; `ChatDockProjectContext.tsx`; `useActiveProject.ts:32` | Display the cwd a chat will use | C | display-only |
| C4 | `TaskWorkspaceView.tsx:55-98,411` | Displays the *persisted* `TaskWorkspaceBinding.workingDirectory` | C | display-only; not a `ProjectConfig` read |
| P | `flow-agents-work-item-provider.ts:326-383`; `provider-interfaces.ts:133`; `work-items.ts:50` | Consume a cwd already resolved by S2 | P | not a read of the field |

**What slice 3b migrates:** S3, S4 (including A7), and S5's root sourcing.
**What it defers:** S1 (slices 3a/3c), **S2 (see below)**, A1, A2, A3, A4, A8,
A9 — each with its reason in the table. **What no slice should migrate:** A5
and A6.

All three migrated seams route through one adapter,
`src-server/services/projects/project-workspace-path.ts`, so the
resolution-state → path-or-honest-absence mapping is written and reviewed once
rather than three times.

#### Why S2 is deferred (slice 3b review)

S2 was migrated, reviewed, and reverted inside slice 3b. The reason is a gap in
the contract, not a defect in the migration.

A project with a manifest git resource and a perfectly good working directory
resolves **`stale`** whenever `readCheckoutRemotes` answers `{ ok: false }` —
which is what it returns when `git` cannot be run at all (absent from a
service/launchd/packaged-app `PATH`), or exits 128 on a momentarily unreadable
`.git`, or loses a race with an `index.lock` or a background `gc`. `stale`
carries no path by contract, so `resolveProjectWorkspacePath` returns
`undefined`, so `GET /runs`, the workflow sidecars, work-items and
operating-state all answer **404** and never reach their service. Before the
migration none of those routes touched `git` at all. Since slice 2 backfills a
manifest on every `createProject`, the exposed population only grows.

That was not fixable inside the seam: `ResourceResolutionResult` could not say
"the directory is there, I could not verify whose repo it is", and slice 1's
`isWellFormedResolution` deliberately forbids a non-`bound` state from carrying
a path. A route that only needs *a directory to read `.flow`/`.veritas` in* is
asking a different question from an operation that targets a named repository,
and the contract had one answer for both. It is the same family of gap as
station#1594 (`unbound` conflating "no working directory" with "the declared
directory is gone") — indeed the same root defect from the other end.

**Resolved by station#1594 (slice 3c-pre); S2's re-migration is a follow-up.**
`stale` and `drifted` now carry a required `unverifiedPath` (§3.6), and the
directory-question that S2 is actually asking is folded once, as
`resolveProjectDirectoryOutcome` in
`src-server/services/projects/project-workspace-path.ts`. S2 re-migrates onto
*that* function, not onto `resolveProjectWorkspacePath` — the repo-question
adapter it was wrongly pointed at the first time, which is why a host with no
`git` 404'd it. The same distinction applies to A1 and A2 when they migrate.
This row stays **deferred** until that re-migration lands and is reviewed on its
own evidence; the contract no longer blocks it.

The other three seams keep their migration because they already model an
explicit unavailable/blocked outcome and degrade honestly: S3 and S4 answer
"no path" where they previously answered a path that failed the caller's own
`existsSync` a line later, and S5 never removes a candidate root — an
unverifiable project keeps its stored `workingDirectory`.

### 2.3 The satellites bind three different ways

| Satellite | Binding mechanism | Evidence |
|---|---|---|
| Layouts | Per-project directory + `projectSlug` on the record; coding layouts embed a copy of the path | `src-server/domain/file-storage-adapter.ts:106,151-163`; `src-server/routes/projects/projects.ts:255-262` |
| Agents | Global store; `ProjectConfig.agents?: string[]` is an opt-in *filter*, and `AgentSpec.project?` makes an agent project-*owned* | `packages/contracts/src/project-reference-integrity.ts:49-85` |
| Knowledge namespaces | **Config embedded** in `ProjectConfig.knowledgeNamespaces`; **data** under `<home>/projects/<slug>/`; **scanning** falls back to the working directory | `packages/contracts/src/knowledge.ts:3-16`; `src-server/services/knowledge/knowledge-storage.ts:131-136`; `src-server/knowledge-store/namespace-compat.ts:33-69` |
| MCP integrations | **Global only** — `<home>/integrations/<id>/`, referenced by agents via `mcpServers: string[]`. No project-level MCP binding exists at all | `src-server/domain/config-loader.ts:405` |
| Skills | Global store under `<home>/skills/`, plus per-project `<home>/projects/<slug>/skills/` | `src-server/domain/skill-paths.ts` (`skillsRootDir`) |
| Flow / Veritas / Survey / Flow Agents / diff-comments | Pure convention over the working directory | `src-server/runtime/routes/runtime-routes.ts:766-889` |

So "what a project references" is today: one embedded list (knowledge
namespaces), one filter over a global store (agents), one convention over a
path (the whole Kontour integration surface), and nothing at all (MCP). The
manifest is the first place any of these become a declared, portable reference.

### 2.4 Nothing keys anything by repo identity — except the test tooling, which already solved it correctly

Repo-wide, no product code path derives a project's git remote. `AppConfig.gitRemote`
exists and is unused by any project code. `git remote get-url origin` is called
only for Station's own checkout (version/telemetry), `station upgrade`, and
plugin provenance. `task-graph-service.ts:681-706` derives `repoRoot` and
`branch` from the working directory — never the remote.

But `scripts/lib/test-reliability.mjs:224-235` contains exactly the function
this design needs, already written and tested:

```js
export function normalizeGitOrigin(url) {
  if (typeof url !== 'string') return '';
  let normalized = url.trim();
  if (normalized.length === 0) return '';
  normalized = normalized.replace(/^(?:https?|git|ssh|file):\/\//i, '');
  normalized = normalized.replace(/^git@([^:/]+):/i, '$1/');
  normalized = normalized.replace(/^[^/@]+@/, '');
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.replace(/\.git$/i, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized.toLowerCase();
}
```

and `collectRepositoryIdentity` at `:284-320` already establishes the priority
this doc argues for: **the normalized origin is authoritative; the common git
directory is the local-only fallback.** That is the portable-identity /
local-identity split, reasoned through once, scoped to verification receipts.
Slice 1 promotes it rather than reinventing it.

### 2.5 `KnownEnvironment` is the right precedent, and its no-secrets rule is narrower than it has been quoted

`packages/contracts/src/known-environment.ts:82-103` is the in-repo shape to
copy. Its three properties matter here:

- **A local id and a server id, both durable.** `id` is "stable LOCAL identity,
  never reassigned" (`:84-91`); `environmentId` is server-owned and attached
  after the first handshake (`:92-97`). Exactly the portable-key/local-key split
  §3 needs.
- **Read-model discipline.** The registry never becomes a second source of
  truth: entries owned by other mechanisms are *folded in at read time*, never
  persisted (`packages/connect/src/core/knownEnvironmentRegistry.ts:203-211`).
- **No secrets, and it is cited as authority for that.** `known-environment.ts:30-35`:
  no bearer credential, device proof, or key material belongs on the type;
  credentials stay in mechanism-specific stores. `src-server/services/peers/peer-credential-store.ts:37-38`
  cites this refusal as the reason a *separate* secret-bearing store had to
  exist.

Two corrections to make before leaning on it:

1. **It is a no-*secrets* rule, not a no-URLs or no-paths rule.**
   `AccessEndpoint.httpBaseUrl` is a base URL by design. `inference-fleet.md:667-668`
   describes the precedent as "no credentials, no base URLs, and no filesystem
   paths — the same discipline `KnownEnvironment` already enforces" — the cited
   lines only exclude secrets. This doc states its own exclusions explicitly
   (§3.2) rather than inheriting that overstatement.
2. **`schemaVersion` is written by every producer and read by none.**
   `KnownEnvironmentRegistry.read()` casts untrusted storage JSON with no field
   validation and no version gate. Versioned in name only. A manifest that will
   actually be exchanged between machines cannot repeat this — §3.2 requires
   the version to gate parsing.

There is also a live hardening note worth carrying: `packages/connect/src/core/nodeStorage.ts:26-31`
records that its writer has no symlink/permission hardening, "acceptable today
only because `KnownEnvironment` holds no secrets." The no-secrets rule is not
decorative; a future sensitive field silently converts a store into a
vulnerability. The binding store (§3.5) holds credential *references*, so it
inherits the same obligation.

### 2.6 Nothing prevents two projects sharing a directory, and the reverse map breaks silently when they do

No layer checks it. `createProject` collects existing slugs to enforce slug
uniqueness and never looks at directories, three lines apart
(`src-server/services/projects/project-service.ts:32-76`). `updateProject` is a
spread merge with zero validation (`:78-91`). The HTTP schema is
`z.string().optional()` inside a `.passthrough()`. The UI never consults the
project list.

When it happens, `resolveAttachedProjectRoot` picks a winner by longest prefix
with a **strictly greater** tie-break (`attached-session-follow-service.ts:311-343`).
Equal-length roots — which two projects sharing a directory produce exactly —
never displace the incumbent, so the winner is whichever project
`listProjects()` yields first, i.e. filesystem `readdir` order. Consequences,
in order of severity:

- The losing project can never see attached sessions in its tree; the caller
  takes exactly one slug and drops the session if none matched. There is no
  fan-out: one cwd → at most one project, forever.
- **The mis-attribution is persisted, not merely displayed.** The envelope
  stamps `metadata.projectSlug` into the canonical `session.started` and
  `session.configured` events, and the event id is a content hash of
  `sessionId + kind` — so re-running discovery after fixing the order produces
  an identical id and dedupes. The wrong attribution never self-corrects.
- The five slug→cwd→derive route families (operating-state, work-items,
  flow-runs, veritas-readiness, workflow-sidecars) render byte-identical state
  under two different slugs with nothing indicating they are one tree.

The strict `>` is correct for the *nested* case (project A = `~/dev/repo`,
project B = `~/dev/repo/packages/web` — B must win). Any fix has to preserve
nesting while making the equal-length case explicit rather than arbitrary.
**Remote-keyed bindings make equal-length ties the common case rather than the
accident**, which is why §10 sequences this fix first.

### 2.7 There is no occupancy concept anywhere

- `provider_session_state` (`src-server/domain/migrations/003-orchestration-events.ts:39-52`)
  has a `cwd TEXT` column, **no `project_slug` column**, and no index beyond
  the `thread_id` primary key. `readSessions()` is `SELECT ... ORDER BY
  created_at ASC` with no WHERE clause; every caller reads the whole table and
  filters in JS. `markSessionClosed` does not clear `cwd`, so any naive "is
  this tree busy" query must also join on status.
- The project binding of a session lives only in event `metadata.projectSlug`
  inside a JSON payload, reconstructed by replay
  (`src-server/services/orchestration/session-lifecycle-service.ts:97,120-121`).
- No lease, lock, or occupancy primitive exists for a working tree. The nearest
  analogues are the per-thread attachment byte quota, the adoption reservation
  (thread-keyed, carries `cwd`/`project_root`/`owner_pid` but never asks who
  else holds the path), and the Flow Agents assignment claim — which is keyed
  by `(artifactRoot = <workspace>/.kontourai/flow-agents, subjectId)`
  (`task-graph-service.ts:895-923`) and is therefore *accidentally*
  directory-scoped for namespaced work items only.
- `task-graph-service.ts:135-186` compares workspaces, but it is
  *client-vs-server* agreement checking, not run-vs-run. Its `ambiguous` state
  means the captured `(workingDirectory, repoRoot, worktreePath, branch)` tuple
  no longer re-derives — most often because the branch moved. It is a drift
  detector that a shared tree would turn into a false-positive generator, not a
  contention guard.
- `src-server/services/projects/worktree-provisioning-service.ts` has the right
  *shape* — dirty-repo / branch-exists / path-exists gates, each emitting
  `worktreeConflictPreventedTotal{detection_source}` — but it is **dead code**
  (its only importer is its own test), it is keyed by `threadId`, and it
  persists no ownership record at all: `WorktreeSessionMetadata`
  (`packages/contracts/src/workspace-isolation.ts:18-27`) carries no thread or
  session field, so a crash between provision and cleanup orphans the worktree
  permanently.
- No UI surface anywhere shows "N sessions running here", a lock, or any
  contention affordance.

### 2.8 Contribution has shipped for the fleet; the routing-constraint channel has not

Fleet slices 1–2 landed after this doc's first evidence sweep, and they change
what §4 has to invent versus generalize:

- `packages/contracts/src/fleet-contribution.ts` is a **shipped contract** for
  "what this machine offers": a default-off, allowlist-only persisted opt-in
  (`:59-66`), a four-state participation enum (`:90-105`), a two-clock
  freshness split (`projectedAt` at `:242` vs `sourceObservedAt` at `:249`), a
  fail-closed reader that refuses truthy coercion (`:255-265`), and a
  deliberate refusal to carry a self-asserted identity (`:29-33`). §4.2
  generalizes it rather than inventing a second noun.
- `packages/contracts/src/fleet-inference.ts` is the serve-side wire contract.
  Its first stated property is the boundary §6.1 depends on: fleet inference is
  "completions only. It is not `delegate_task`" — the agent loop, tools, files,
  and event record stay on the consumer.
- `AppConfig.fleetContribution` (`packages/contracts/src/config.ts:103`) is
  registered in the settings registry
  (`packages/contracts/src/settings-registry.ts:324`), so contribution already
  has a settings home. Project contribution should use the same one (§4.2).

Still greenfield, re-verified against current `origin/main`: **no
`RoutingConstraint`, capability predicate, or target-selection primitive
exists** anywhere in `packages/contracts` or the inference services.
`DelegationTarget` (`src-server/tools/station-control-delegation.ts:76-89`)
takes an explicit `environmentId` and the caller names the machine; nothing
evaluates a predicate over candidates. `DelegationTargetOption.capabilities`
(`:145-160`) is a booleans bag rendered for a human chooser, per-agent, not
per-Station. `inference-fleet.md:962-985` (§6.3) states the design opening and
cites #1425 by name: the receipt schema should carry a general `constraints[]`
channel with binding constraints as its first member, and it warns that
"claiming binding-aware inference routing as a v1 user-facing feature would be
overselling it" — token generation does not need the repo; **task** delegation
does. This doc supplies that channel's first member and adopts the warning.

There is also **no presence or liveness contract** for a Station. The only
liveness fact that exists is `AccessEndpoint.lastVerifiedAt`
(`packages/contracts/src/known-environment.ts:69-80`), "epoch ms of the last
successful well-known handshake through this endpoint" — a *last-seen*, not a
*now*. §4.7 depends on that distinction.

## 3. The split: a portable manifest and a per-(member, Station) binding store

### 3.1 The contract in one paragraph

A **Project manifest** declares identity and references, keyed by things that
mean the same thing on every machine: git repos by canonicalized remote,
knowledge roots by namespace, agents and integrations by id. It contains no
filesystem paths and no secret values. A **binding store**, private to one
Station and one member, maps each manifest resource to a local realization —
a checkout path, an available credential reference — and never leaves the
machine. What a Station *offers* a project is a third, separate, deliberate act
(§4): a **contribution**, default-none and allowlist-only, and the only one of
the three that crosses the wire. Resolution of a manifest against a binding
store produces an explicit per-resource state for a Station that backs the
project, and "I tried and was denied" is one of those states rather than an
empty result.

### 3.2 Manifest schema v1

Shape (illustrative; the contract lands in `packages/contracts` at slice 1):

```jsonc
{
  "schemaVersion": 1,
  "id": "prj_7f3a…",              // portable, generated once, never machine-derived
  "slug": "station",               // LOCAL naming/routing key (§9 OQ-5)
  "name": "Station",
  "icon": "…", "description": "…",

  "repos": [
    {
      "id": "github.com/kontourai/station",   // == canonicalRemote (§9 OQ-1)
      "kind": "git",
      "canonicalRemote": "github.com/kontourai/station",
      "aliases": ["git.example.com/kontourai/station"],  // deliberate, shared equivalence
      "role": "primary",
      "label": "Station",
      "defaultBranch": "main"
    },
    { "id": "local:scratch", "kind": "local-only", "label": "Scratch notes" }
  ],

  "knowledge": [
    { "namespaceId": "default", "root": { "kind": "station-managed" } },
    { "namespaceId": "rules",   "root": { "kind": "repo", "repoId": "github.com/kontourai/station", "path": "docs" } }
  ],

  "agents": ["reviewer", "planner"],

  "integrations": [
    { "id": "linear", "kind": "mcp", "auth": { "station": "linear" } }
  ],

  "layouts": [ /* layout ids; bodies stay in the layout store */ ],

  "createdAt": "…", "updatedAt": "…"
}
```

Rules, stated as exclusions so they can be enforced by a validator rather than
by convention:

- **No absolute or tilde-prefixed filesystem paths, anywhere.** Every path in
  the manifest is *relative to a named repo* (`{ repoId, path }`) or
  Station-managed (resolved locally under `<home>/projects/<slug>/`). A
  validator rejects any string matching `^[~/]` or a drive letter in a path
  position. This is the rule §2.5 says `KnownEnvironment` does *not* actually
  have; the manifest has it explicitly.
- **No secret values.** Auth is by reference only (§3.4), with the validator
  rejecting key-looking literals.
- **No machine or member identity.** A manifest describes a project, never who
  has it or who offers it. That is §4's contribution layer, computed per
  Station and attributed by the reader (§4.2).
- **Base URLs are allowed** and are not treated as secrets — a self-hosted
  forge or MCP endpoint is topology, and refusing it would make self-hosted
  setups unrepresentable. They are, however, the field most likely to be
  sensitive in a shared manifest, so §8 defers per-field share redaction rather
  than pretending the question does not exist.
- **`schemaVersion` gates parsing.** An unknown major version is refused with a
  named error, not cast. (§2.5's `KnownEnvironment` lesson.)
- **`id` is portable and opaque.** It is generated once at manifest creation
  and is the join key for channels (#1392), delegation (#1123), and provenance
  (#1409). It is *not* derived from any repo, path, or machine — a project may
  span repos, change repos, or have none.

### 3.3 Decision: remote canonicalization and the alias problem

Canonicalization must be **pure and deterministic — no filesystem, no
`~/.ssh/config`, no network** — because every member must compute the same id
from the same string. Anything machine-dependent is by definition a binding
concern. `normalizeGitOrigin` (§2.4) already satisfies this. It collapses:

| Input | Canonical |
|---|---|
| `git@github.com:kontourai/station.git` | `github.com/kontourai/station` |
| `https://github.com/kontourai/station` | `github.com/kontourai/station` |
| `ssh://git@github.com/kontourai/station.git` | `github.com/kontourai/station` |
| `https://user:token@github.com/kontourai/station/` | `github.com/kontourai/station` |
| `https://GitHub.com/KontourAI/Station` | `github.com/kontourai/station` |

Three cases it does **not** collapse, each with a different correct home:

**(a) SSH host aliases — a binding concern.** A member using
`Host github-work / Hostname github.com` in their ssh config has a remote of
`git@github-work:kontourai/station.git`, which canonicalizes to
`github-work/kontourai/station` and matches nothing. This is machine-local
knowledge and belongs in the binding store as an explicit host-alias map
(`{"github-work": "github.com"}`), applied *before* canonicalization when
reading a local checkout's remotes. It is never applied to the manifest side.
Deriving the map automatically from `~/.ssh/config` is deferred (§8) — reading
a user's ssh config to change matching behavior should be an explicit action,
not a silent one.

**(b) Forks — a binding concern, and it must stay private.** My checkout's
`origin` is `github.com/brian/station`; `upstream` is
`github.com/kontourai/station`. The fix is to stop treating `origin` as
privileged: **a binding records the canonicalized set of *all* remotes the
local checkout advertises**, and matching is set-intersection against the
manifest resource's `{ canonicalRemote } ∪ aliases`. The manifest never has to
enumerate every member's fork, and no member's fork is disclosed to anyone.

**(c) Mirrors and moves — a manifest concern.** "We migrated from one forge to
another" and "we keep an internal mirror" are shared facts about the project,
authored deliberately. Those go in `aliases[]`, replicate with the manifest,
and are visible to every member — which is correct, because they *are* the
project's identity.

So the aliasing rule is one sentence with a clean authority split: **the
manifest says which repo it means (primary + deliberate aliases); the Station
says which of its checkouts satisfies that (the checkout's full remote set,
after local host-alias rewriting).**

Two residual cases, handled honestly rather than cleverly:

- **Case sensitivity.** `normalizeGitOrigin` lowercases everything. That is
  right for the major forges and wrong in principle for a case-sensitive host.
  Accepted: the failure mode is two distinct repos colliding on one id, which
  requires a host that serves both `Org/Repo` and `org/repo` as different
  repositories. Recorded as a known limitation, not designed around.
- **No remote at all.** A local-only repository, or a directory that is not a
  repo, or the seeded `default` project with no directory. These get
  `kind: 'local-only'` with a manifest-local id and are *explicitly marked
  non-portable*: they resolve for their author and produce a `not-portable`
  state (§3.6) for everyone else. Refusing them would turn migration into a
  wall (§5).

  **The manifest-local id grammar is `^local:[A-Za-z0-9._-]+$`** (adopted
  slice 1, station#1498; it was previously only implied by §3.2's illustrative
  `"local:scratch"`). This is not cosmetic. §5's migration turns a
  directory-only project into a `local-only` resource, and the only value on
  hand to make its id from is the working directory — so without a grammar the
  ordinary upgrade path ships the author's absolute home path to every project
  member, in a field §3.2 says can never hold one. The grammar closes that by
  construction rather than by a reviewer noticing.

- **A `file://` or bare local-path remote is not a `git` resource.**
  `normalizeGitOrigin` strips the scheme, so `file:///Users/me/dev/repo`
  canonicalizes to an absolute path that is *idempotent* and therefore passes
  an "is it already canonical" check. The validator refuses it in
  `canonicalRemote` and in `aliases`: a local mirror is a `local-only`
  resource. Same leak, same field, different door.

  The rule is `isLocalCloneSource` and it exists **once**, in
  `packages/contracts/src/project-identity.ts`, called by both the validator
  (read side) and slice 2's backfill (write side). It refuses an
  absolute/tilde/drive-letter/UNC form, a `.` or `..` first segment on either
  separator, and a loopback host with or without a port — `git clone
  file://localhost/<abs path>` is supported by git and strips to
  `localhost/users/...`, which escapes the anchored path pattern entirely.
  Two independent copies of this rule were measured diverging in **both**
  directions: one leaked `localhost:2222/org/repo` as portable, and the other
  let a write persist a manifest the read side then refused forever, with no
  later write able to repair it. Its one residual is that a relative source
  with no dot segments (`git clone mirror/repo` → `mirror/repo`) is
  indistinguishable at the string level from a single-label host, and is
  accepted — recorded, and asserted as accepted rather than implied away.

### 3.4 Auth by reference — the datum idiom

Datum's rule (`../datum` README §Registry; `CONTEXT.md` "Secret References") is
the one to copy verbatim rather than paraphrase: **auth is a reference to a
secret, never the secret's value**, with exactly one backend per entry —
`{ env: "VAR_NAME" }`, `{ keychain: { service, account? } }`, or
`{ op: "op://vault/item/field" }` — materialization lazy and explicit, and a
validator that **rejects a key-looking literal in any auth field** (long token,
no spaces → error). Its list/sync paths report the auth *kind* and whether the
backend is *available*, never the value.

Station adds one backend and no more: `{ station: "<integrationId>" }`,
resolving through the existing `<home>/integrations/<id>/` store. Rationale: a
manifest that names an integration should say *which* integration, and Station
already owns that store; inventing a fourth secret backend would fork datum's
model for no gain. The three datum backends stay valid for provider auth, where
datum is already the resolver. (§9 OQ-9.)

The projection discipline follows directly: a manifest carries the *reference*;
the binding store records whether that reference *resolves on this Station*;
the contribution projection carries only `available: boolean`. Nothing at any
layer carries the value.

### 3.5 The binding store

Per Station, per member. In today's single-tenant Station the member is
implicit; the shape reserves the slot so #1392 does not have to reshape it.

```jsonc
// <home>/config/project-bindings.json
{
  "schemaVersion": 1,
  "memberId": "local",                 // reserved; "local" until #1392
  "hostAliases": { "github-work": "github.com" },
  "bindings": [
    {
      "projectId": "prj_7f3a…",
      "resourceId": "github.com/kontourai/station",
      "kind": "git-checkout",
      "path": "~/dev/github/kontourai/station",
      "remotes": ["github.com/kontourai/station", "github.com/brian/station"],
      "verifiedAt": 1754000000000,
      "state": "bound"
    }
  ],
  "credentialBindings": [
    { "projectId": "prj_7f3a…", "integrationId": "linear", "available": true, "checkedAt": 1754000000000 }
  ]
}
```

Properties that are design commitments, not incidental:

- **It never leaves the Station.** Not replicated by #741 slice 3, not included
  in any export, not part of the manifest, and *not* what a peer reads. The
  privacy argument for everything downstream reduces to this one sentence, and
  §4.3 is what it buys.
- **It is a resolution cache, not a consent record.** What this Station offers
  lives in `AppConfig` alongside `fleetContribution` (§4.2), because consent
  belongs in settings where an operator can see and revoke it — not in a store
  that a resolver rewrites as a side effect of doing its job.
- **It stores references, never values.** `credentialBindings` records
  availability and when it was checked; the reference itself lives in the
  manifest, the value in the OS keystore. Per §2.5 this store therefore
  inherits `KnownEnvironment`'s obligation: if a secret ever lands here, the
  file's write path needs the hardening `packages/connect/src/core/nodeStorage.ts:26-31`
  says it lacks.
- **`path` is stored as the user gave it; `remotes` is stored canonicalized.**
  The path stays verbatim to preserve the existing tilde behavior (§2.2) and is
  canonicalized at each read by the resolver, in one place. The remotes are
  canonicalized at write because they are a *key*.
- **`verifiedAt` is an observation, not a guarantee.** A binding whose
  `verifiedAt` is old is `stale`, not `bound` — the resolver re-checks, and the
  contribution projection carries the timestamp so a router can decide (§6.1).

Resolution is one function, and it is the only thing the rest of the codebase
should call:

```ts
resolveProjectResource(projectSlug, resourceId?): {
  state: ResourceResolution;
  path?: string;          // present only when state === 'bound'
  resourceId: string;
  reason?: string;        // required for every non-'bound' state
}
```

`resourceId` is optional so that today's single-repo projects — and every
existing caller — keep working unchanged by resolving the `primary` repo.

**Primary cardinality, settled (slice 1, station#1498).** The sentence above
assumed a primary exists and is unique, and nothing required either — `role` is
optional, so the most common manifest (one repo, no `role`) had no primary at
all and a resolver would have had to invent a rule. The contract is now:

- A **single-resource manifest's sole resource is its primary**, whether or not
  it declares `role`.
- A manifest with **more than one resource must declare exactly one**
  `role: 'primary'`. The validator refuses both zero and two.
- `role` is available on `local-only` resources as well as `git` ones, so a
  manifest holding only local-only resources can still name a primary.

The consequence for a resolver is worth stating because it is easy to read the
wrong way: for a manifest that came through `validateProjectManifest`, the
ambiguous-primary branch is unreachable **except for a manifest declaring no
resources at all**, which validates (there is no cardinality rule to break)
and still has nothing to name. It is **not** dead code — a resolver
reads manifests off disk, where they may predate the rule, have been
hand-edited, or have been written by another member's older Station. That is
exactly when "exact match or an honest unavailable" has to hold: report
ambiguity naming every candidate, never pick one.

A resolver therefore classifies a cardinality failure as `ambiguous` (§3.6),
not as an unreadable manifest: the document parses, every resource is
well-formed, and the only thing it cannot do is name ONE resource — so it is
read, and the answer is the honest unavailable rather than a throw the caller
cannot answer. Every other validation failure still fails closed. The
classification runs on the validator's machine-readable diagnostic codes
(`ProjectSelectionAmbiguityCode`), never on its message text, and
`selectPrimaryResource` is the rule above as a function so the validator and
the resolver cannot drift apart on any manifest that declares at least one resource.

### 3.6 Resolution states — a backing Station's view of a resource

**These states describe a Station that backs the project or is setting up to
back it.** A member whose Stations back nothing has no per-resource states at
all: the project reports "not backing" once, at the Station level, and shows no
resource rows and no repair prompts. §4.1 is why that is a first-class outcome
rather than a degenerate one.

| State | Meaning | Repair |
|---|---|---|
| `bound` | Binding exists, path resolves, remote sets intersect | — |
| `unbound` | **Nothing on this Station records a realization of this resource** — no binding, and no declared `workingDirectory` on the compat branch | Clone it, or point at an existing checkout |
| `missing` | **A recorded realization — a binding, or a declared `workingDirectory` on the compat branch — whose path no longer exists.** Carries `record` (which of the two) and `declaredPath` | Re-point or re-clone; **never silently re-bind** |
| `drifted` | Path exists but its remote set no longer intersects the manifest's. Carries `unverifiedPath` | Confirm the new identity or re-point |
| `stale` | Bound, but not verified recently enough for the asking consumer. Carries `unverifiedPath` | Re-verify (cheap; a filesystem + `git remote` read) |
| `unresolvable` | An attempt to use or bind this resource was **denied** | Nothing local; the gap is upstream (permissions) |
| `not-portable` | A `local-only` resource authored by someone else | Nothing; it was never shareable |
| `ambiguous` | No single resource could be named — several resources with no unique `primary`, or none declared | Declare a primary, or ask for a specific `resourceId` |

**station#1594 (slice 3c-pre) split `unbound`/`missing` and made the result type
a discriminated union.** The table above had no state for "a working directory
is declared and it is gone" — the resolver reported that as `unbound`, the same
state as "nothing is recorded here", with the difference living only in the
prose of `reason`. The session-cwd seam owes those two OPPOSITE behaviour
(#1023's `$HOME` terminus vs #791's fail-closed throw), so no mapping from the
state alone could serve both and slice 3c was blocked on it.

The `missing` row's original wording ("Binding recorded, path no longer exists")
was an accident of the binding-first design; its *meaning* — the place you
recorded is gone, re-point or re-clone, never silently re-bind — applies
verbatim to a declared `workingDirectory`, which §5 makes the compat-era binding
("`workingDirectory` stays authoritative during compat"). So this is a
definition correction rather than a new state. A compat-sibling state and a
`cause` field on `unbound` were both considered and rejected: the first is
vocabulary inflation for a distinction that is already a derivation (identical
repair, identical handling in every consumer, and no exhaustive `switch` over
`ResourceResolution` exists anywhere to force at compile time); the second
leaves one state meaning two opposite things and pushes a sub-vocabulary onto
every consumer.

The same change closes the S2 residual recorded in §2.2.1, because it is the
same root defect from the other end: a resolution reported a derived label and
discarded the observations it was derived from. `stale` and `drifted` are only
ever emitted *after* an existence check has passed, so the resolver holds a real
directory at that moment and the contract forbade it from saying so. They now
carry a required `unverifiedPath`.

`path` remains the **answer slot** — `bound` only, unchanged from slice 1.
`unverifiedPath` is a separately named, per-state-required **observation slot**
whose name is the warning. Two questions, one derivation point: the
repo-question ("the verified checkout of resource X") is `path`; the
directory-question ("this project's realized directory, for `.flow`/`.veritas`
or a session cwd") is `path ?? unverifiedPath`, folded exactly once in
`src-server/services/projects/project-workspace-path.ts` and never at a seam.

`ambiguous` was added in slice 2 (station#1499) because the table had no state
for it and both alternatives lie: `unbound` implies a resource exists that is
merely not set up here, and `unresolvable` means "you were denied", which
collapses a configuration problem into an access one. It is the one state that
names no resource — `resourceId` is empty and every candidate is in the reason,
because the state exists precisely because no single resource could be named.

Three honesty constraints on `unresolvable`, which is the state #1425 cares
most about:

1. **It renders only in response to an attempt.** A member who tried to bind or
   use a referenced resource and was denied sees it. It is **never ambient
   status**, and it is never shown to a member who did not ask for the
   resource. Rendering it ambiently would require probing every referenced
   remote for every member on every view — network, credentials, and a
   permission oracle — and would tell a reviewer who never wanted the repo that
   they are missing something.
2. **It is asserted, never inferred.** Station cannot know a member lacks
   access without an operation failing with an authorization error. Before
   that, there is no state to show; if the member is otherwise backing the
   project, the resource reads `unbound` ("not set up here"), which is a
   different sentence from "you don't have access." Guessing the stronger claim
   is the exact dishonesty this design exists to prevent.
3. **When it does render, it is never an empty result.** Per #1409 AC5's idiom,
   the resource is named, its state is `unresolvable`, and no path, branch, or
   content is disclosed. A silent skip is a bug, not a degradation.

The states collapse to three tones in any UI: **ready** (`bound`),
**repairable** (`unbound`, `missing`, `drifted`, `stale`, `ambiguous`), **not
for you** (`unresolvable`, `not-portable`). The states stay distinct in the contract
because the repair differs; the UI is free to group.

## 4. Membership, contribution, and backing

The manifest/binding split answers "what is this project, and where is it
here." It does not answer "who is in it," "what does this machine offer it,"
or "is that offer good enough" — and conflating any of those with bindings is
how a collaboration tier acquires a second-class citizen it never meant to
create. §4.1–§4.3 are proposed contract; §4.4 is sketched direction pending
OQ-12; §4.6 is a constraint on all of it.

### 4.1 Membership is not backing

**A member who brings no resources is a first-class role.** Someone who joins a
project to collaborate, review, decide, or develop *through the room* — with no
checkout, no contributed inference, no local tooling — is not an
empty-bindings edge case to be nudged toward completeness. They are a normal,
expected participant, and a large fraction of any real room.

Concretely, that member must never see: a repair prompt, an "unresolvable for
you" badge, a per-resource state table, a clone call-to-action, or any UI that
reads as an incomplete setup. Their ambient state is **"not backing"**, which
is unremarkable and rendered as such — a fact about their machines, not a
deficiency in their membership.

This is a correction to revision 1's §3.6, which treated an unbound member as a
project in need of repair. The repair framing is right for a member who *is
trying to back* the project and cannot; it is wrong for a member who never
intended to. It is also the honest reading of the disagreement recorded in
§2.2: `resolveStartSessionCwd` treating a directory-less project as a valid
organizational scope, and `task-graph-service` treating it as `blocked` for
dispatch, are not a bug on one side — they are two subsystems correctly
answering for two different kinds of participation. Chat works for a
non-backing member; dispatch does not, and should say so by name.

### 4.2 Contribution: the explicit per-space offer

A **contribution** is what one Station offers within one shared space. The
contract is scoped from v1:

> **contribution = (Station, scope) → named resources**

Three resource kinds are in scope:

- **execution** for a named repo — "I will run work in my checkout of X"
- **agents** — named agent slugs this Station makes available in that space
- **inference** — named local model connections, exactly as the fleet already
  does

**The primary grain is per shared space, not global.** A member keeps
everything local by default and decides, *per space*, what — if anything —
their Station contributes there. The same machine can contribute execution for
one repo to one project, inference only to another, and nothing at all to a
third. Once shared spaces exist, per-space is the expected common case; a
single global switch would force one answer across rooms with different people
and different trust in them.

The shipped `fleetContribution` is the **degenerate, global instance of this
same contract**: your own fleet is one implicit trust scope — every machine has
the same owner, so there is exactly one space and the scope dimension collapses
to a constant. That is why it needs no scope field today and why adding one is
not a redesign:

| Scope | Trust boundary | Status |
|---|---|---|
| `{ kind: 'fleet' }` | Your own machines; one implicit owner | Shipped (`fleetContribution`) |
| `{ kind: 'project', projectId }` | A project's members | This doc (§10 slice 2.5) |
| `{ kind: 'channel', channelId }` | A channel's members | #1392 |

One schema, three scopes. Carrying the scope dimension in v1 is what keeps the
fleet instance and the future per-space instances from becoming two contracts
that drift (§9 OQ-11).

Contribution generalizes a **shipped** contract rather than inventing a second
noun. `packages/contracts/src/fleet-contribution.ts` already encodes the four
decisions that matter, and scoped contribution reuses them verbatim:

1. **Default off in every direction, allowlist-only.** `FleetContributionConfig`
   (`:59-66`): "an absent field, an absent `enabled`, `enabled: false`, and an
   empty/absent `connectionIds` all contribute nothing. There is no value of
   this object that contributes a connection the operator did not name — the
   allowlist is explicit, never 'all local connections'." Read fail-closed:
   `isFleetContributionEnabled` (`:255-265`) requires `enabled === true` and
   refuses truthy coercion.
2. **Four-state participation; the empty array is never the signal.**
   `FleetContributionParticipation` (`:90-105`) is
   `contributing | disabled | nothing-contributed | contributed-unavailable`,
   with the doctrine stated at `:83-89`: three of the four states carry an
   empty list, so "off", "on but nothing marked", and "on, marked, and
   currently yielding nothing" stay three different sentences to an operator
   and three different routing decisions to a consumer — "collapsing them into
   `[]` is the silent-degradation class §4.5 bans." (That `§4.5` is
   `inference-fleet.md`'s, not this doc's.)
3. **Two clocks, kept separable.** `projectedAt` (`:242`) is when the
   projection was produced and is deliberately *not* named `observedAt`;
   `sourceObservedAt` (`:249`) is the freshness field, because "a fresh
   projection of a stale inventory is a stale claim, and the two timestamps
   must stay separable to say so."
4. **No self-asserted identity — peer-attested labeling.** The manifest carries
   no `environmentId` (`:29-33`): "A manifest fetched from a peer is attributed
   by the consumer to the environment it authenticated to. A self-asserted
   identity field inside the body adds nothing that the transport identity does
   not already establish, and can only ever disagree with it."

Scoped contribution is the same shape with the resource axis widened and the
scope made explicit, stored in the same place — `AppConfig`, registered in the
settings registry, alongside `fleetContribution`
(`packages/contracts/src/config.ts:103`;
`packages/contracts/src/settings-registry.ts:324`):

```jsonc
// AppConfig.contribution — keyed by scope key; "fleet" is the existing global one
{
  "fleet": {
    "enabled": true,
    "inference": { "connectionIds": ["ollama-local"] }
  },
  "project:prj_7f3a…": {
    "enabled": true,
    "execution": { "repoIds": ["github.com/kontourai/station"] },
    "agents":    { "slugs": ["reviewer"] },
    "inference": { "connectionIds": ["ollama-local"] }
  }
}
```

and the projection a consumer reads:

```jsonc
{
  "schemaVersion": "station.contribution/v1",
  "scope": { "kind": "project", "projectId": "prj_7f3a…" },
  "projectedAt": "…",
  "sourceObservedAt": "…",
  "participation": "contributing",
  "execution": [ { "repoId": "github.com/kontourai/station", "bound": true, "verifiedAt": 1754000000000 } ],
  "agents":    [ { "slug": "reviewer" } ],
  "inference": [ { "id": "…", "connectionId": "ollama-local" } ],
  "diagnostics": [ { "resourceId": "…", "code": "…", "message": "…" } ]
}
```

`station.fleet-contribution/v1` is then the `{ "kind": "fleet" }` instance of
this schema, and remains wire-compatible: an existing consumer reading a
fleet-scoped projection sees the same participation, freshness, model, and
diagnostics fields it reads today. Whether the shipped schema id is aliased or
kept alongside is a slice-2.5 decision, not a design fork.

Two consequences worth stating plainly:

- **The binding attestation is not a separate wire type.** It is the
  `execution[]` entry of this projection — `{ repoId, bound, verifiedAt }`,
  presence and freshness, never a path. One noun across fleet and project, one
  schema across scopes.
- **There is no `stationId` in the body.** Attribution is the reader's, from
  the transport it authenticated to. This corrects revision 1's §5.1, which put
  a self-asserted `stationId` inside the attestation — exactly the field
  decision 4 above bans.

The four participation states carry over with the same words and the same
obligation to name which empty is which. `contributed-unavailable` earns its
keep here: a Station that offers execution for repo X whose binding for X is
`missing` is *offering something it cannot currently serve*, which is a
different sentence from "offers nothing" and a different routing decision from
both.

### 4.3 Binding is private; contributing is a separate consent

Binding and contribution are orthogonal, and keeping them so is the point:

| | **not contributing** | **contributing** |
|---|---|---|
| **not bound** | Member collaborating in the room (§4.1); or a Station offering agents/inference but no checkout | `contributed-unavailable` for that repo — offered, cannot currently serve. Named, never silent |
| **bound** | **The common case.** I have the repo checked out for my own work and nobody may route work into it | Fully backing |

The bottom-left cell is the one that must never be silently promoted.
**Having a checkout is not consent to have work routed into it.** Binding
answers "can I work on this here"; contributing answers "may the project put
work here". A design that derived the second from the first would turn every
private clone into an execution target — both a security posture and a product
posture nobody chose.

§3.5's private-binding commitment is what makes the separation enforceable
rather than aspirational: because the binding store never leaves the machine,
the *only* thing a peer can observe is what was deliberately offered. The
privacy property and the consent property are the same property, stated twice.

### 4.4 Project requirements and offer compliance — sketched direction, not settled

> **This subsection is direction, not decided design.** It is the project-side
> mirror of the fleet's mesh-admission model, and the owner has explicitly
> flagged it as needing more thought. §9 OQ-12 carries the three unsettled
> sub-questions. Nothing here should be treated as a contract until OQ-12 is
> answered.

A project manifest MAY declare **requirements**: capability floors, specific
repos at specific canonical remotes, model or tooling needs. A Station's
offered contribution (§4.2) is checked against them. This is the same machinery
as `inference-fleet.md` §4 (capability manifest at join → evidence-backed
verification → route only to verified capabilities → honest degraded states →
published requirements), generalized from "the fleet" to "a project".

**Four-state outcome for an offer:**

| Outcome | Meaning | Who sees it |
|---|---|---|
| `accepted-live` | Offer meets requirements and is currently serving | The room and the offerer |
| `accepted-degraded` | Accepted, then drifted — re-checked on the liveness cadence, visibly degraded, **never silently dropped** | The room and the offerer |
| `not-accepted` | Does not meet this project's requirements — named, specific, actionable | **The offering member only** |
| `attested-unverified` | Compliance is claimed but cannot be checked here | The room and the offerer, labelled as such |

Design constraints, each with a precedent:

- **Checked at offer time, fail-closed and named; re-checked on the liveness
  cadence.** A requirement that is only evaluated at use time turns every
  dispatch into a possible surprise; one that is only evaluated at offer time
  goes stale silently. `accepted-degraded` exists precisely so drift after
  acceptance has somewhere honest to land — `inference-fleet.md:829-855`'s
  two banned behaviors apply verbatim: never drop a capability without a
  diagnostic, never silently fall back.
- **The requirements vocabulary is bounded by what can be truthfully attested
  or probed.** This is the #1430 lesson generalized: `fleet-contribution.ts:20-27`
  omits a tool-surface column *because no producer populates it*, so the column
  "would be a placeholder that reads as an observation and invites
  tool-capability routing that cannot be honest." A project must therefore not
  be able to require a capability nothing can attest. An unverifiable
  requirement yields `attested-unverified` — never manufactured compliance.
  The peer-attested-vs-probe-verified split is already named and enforced in a
  sibling package (`inference-fleet.md:755-762`); this reuses it rather than
  inventing a grading scheme.
- **No reverse-enumeration oracle.** Refusal reasons are delivered to the
  *offering* member only. The room sees what was accepted; it does not see the
  set of things people offered and were refused for. Otherwise "what does this
  project require, and who fails it" becomes a queryable profile of every
  member's machines — the inventory shape §9 OQ-4 already refuses.
- **Acceptance is per-resource, not all-or-nothing.** An offer of
  `{repo ✓, model ✗}` lands the repo and names why the model did not, using the
  existing per-connection diagnostics idiom (`FleetContributionDiagnostic`:
  a resource id, a code, and a human message). All-or-nothing acceptance would
  make one unmet requirement silently withdraw a machine that was useful.
- **Vocabulary discipline.** "Unresolvable for you" (§3.6) stays strictly
  **consumer/access-side** — *I tried to read this and was denied*. The
  contributor-side state is about **fit**, not access, and gets its own term:
  **"not accepted — doesn't meet this project's requirements."** Collapsing the
  two would produce a badge that means "you lack permission" and "your machine
  lacks a capability" interchangeably, which is exactly the class of
  ambiguity this doc exists to remove.

Deliberately not proposed here: a policy *engine*. `inference-fleet.md:860-880`
decided "design the seam, ship no policy engine" for the fleet, on the grounds
that there is no tenant to publish a policy and no proven pattern to adopt.
That reasoning holds identically for projects until #1392 exists, so the v1
shape is a single named function over `(manifest requirements, offer, evidence)`
returning one of the four states — not a rules language.

### 4.5 Vocabulary

| Term | Means | Notes |
|---|---|---|
| **Member** | A person in the project or channel | May back nothing and still be first-class (§4.1) |
| **Station** | One machine running Station | Backing is a property of a Station, never of a member |
| **Contribution** | An explicit, per-space, default-none offer of named resources by a Station | The consent layer. One noun across fleet and project, one schema across scopes (§4.2) |
| **Binding** | The private local realization of a manifest resource on one Station | Never leaves the machine (§3.5) |
| **Requirement** | A project-declared floor an offer is checked against | Sketched only (§4.4) |
| **Not accepted** | Contributor-side: an offer does not meet requirements — a **fit** statement | Distinct from `unresolvable`, which is access-side (§3.6) |

**"Host" and "client" are transport-layer words and must not appear in product
copy.** They describe an HTTP relationship and nothing else, and "host" is
already overloaded three ways inside this doc's own evidence: the former CLI
address-book concept, now represented by saved Stations
(`packages/cli/src/commands/profile-store.ts`), the `Host`/`Hostname` pair
in an ssh config (§3.3), and `os.hostname()` inside a claim actor
(`task-graph-service.ts:895-923`). A member is not a client; a Station is not a
host. Where copy wants to say "the machine that will run this", the phrase is
**backing Station**.

One corollary the vocabulary forces: a member may have several Stations with
different contributions on each — a laptop that contributes nothing, a desktop
that contributes execution for one repo, a server that contributes inference.
So *"does this member have repo X"* is not a well-formed question. The
well-formed one is *"which of this member's Stations contributes execution for
repo X"*, and it is what §6.1's constraint actually asks.

### 4.6 The local-only invariant, and progressive disclosure at join time

This is a design constraint on everything above, and the collaboration tier
(#1392) inherits it.

> **The local-only experience must not degrade.** Station stays fully
> functional and zero-config for a purely local user, with no member,
> contribution, or manifest concepts visible anywhere. **Collaboration must be
> seamless and easy to *enable*** — the new vocabulary appears progressively, at
> the moment you first join or create a shared space, and the contribution
> question defaults to "nothing," with per-space granularity.

Three consequences, each checkable:

1. **Nothing in §4 is visible to a single-user, single-machine Station.** No
   "members" list, no "contribution" settings section, no manifest UI, no
   backing view. A local user's Station shows projects and chats, exactly as
   today. This is constitution non-negotiable #5, *Local-first, user owns their
   data* (`docs/strategy/constitution.md:48-50`: "No cloud account required")
   applied to vocabulary as well as to data — a local-first product that makes
   you learn a membership model before you can use it is local-first in storage
   only. #741 R7 states the same invariant from the fleet side ("Local-only
   Station continues to work without a hosted service"), and its acceptance
   criteria include "single-machine/local-only mode passes unchanged."
2. **First-run onboarding is unchanged. Join-time onboarding is where the new
   concepts surface.** The existing zero-config first-run journey is pinned by
   a named regression test — `tests/first-run-live.spec.ts`, whose manifest
   rationale is "a dedicated temp-home Station suite proves the 390x844 journey
   from zero-provider guidance through a real persisted Ollama-compatible
   connection to a streamed first reply" (`tests/e2e-manifest.mjs:825-833`).
   That test is the pin for this invariant: if a slice in this arc makes it ask
   about members, manifests, or contribution, the slice is wrong. Every new
   concept is introduced at the moment a user first joins or creates a shared
   space, not before.
3. **The contribution question defaults to "nothing," per space.** Joining a
   space never opts a machine into backing it. The prompt is an offer, its
   default is none, and it is asked per space rather than once globally — which
   is the product reason §4.2's scope dimension has to exist from v1, not just
   the schema reason.

The migration rule in §5 is the same invariant expressed in data: an existing
project does not acquire a contribution because it had a path.

### 4.7 The backing view (sketch, not a full design)

A project — and later a channel — can render its **backing Stations** as
contributions × binding attestations × liveness:

| Station | Contributes | Execution: station repo | Last seen |
|---|---|---|---|
| kontour (desk) | execution, agents, inference | bound · verified 4m ago | 2m ago |
| media-host | inference | — not offered | 31m ago |
| b10 (phone) | — (`disabled`) | — | 3d ago |

Four honesty rules, each with an existing precedent rather than a new
invention:

1. **Liveness is never claimed without a fresh check.** #741 requires "no false
   'online' state from stale discovery," and the only liveness fact that exists
   today is `AccessEndpoint.lastVerifiedAt`
   (`packages/contracts/src/known-environment.ts:69-80`) — the last successful
   well-known handshake, a *last-seen* rather than a *now*. So the column is
   "last seen" with an age, never a green dot, until a real presence contract
   exists (§11).
2. **Staleness is rendered, and the two clocks stay separate.** The view
   inherits `projectedAt` and `sourceObservedAt` from §4.2 for the same reason
   the fleet manifest split them: a fresh projection of stale evidence is a
   stale claim.
3. **Peer-attested labeling.** A row's identity comes from the transport the
   reader authenticated to, never from a field the peer wrote in its own body
   (§4.2 decision 4). A Station cannot name itself in this view.
4. **Participation is displayed by name.** `disabled`, `nothing-contributed`,
   and `contributed-unavailable` render as distinct sentences; an empty
   resource list is never the signal.

**This is the join point to the collaboration tier.** #1392 gives the room and
#741 gives the fleet; contribution is what connects "who is in the room" to
"what can actually run" — members' machines are the compute a project runs on,
and contribution is the mechanism by which a machine gets brought. The view is
deliberately sketched, not specified: it needs a room to be rendered in, and
rendering it for a single-member fleet is a status board for one person
(§9 OQ-11).

## 5. Migration: today's Project is the degenerate case

Every existing project maps without loss:

- **Manifest**: `{ id: <new uuid>, slug, name, icon, description, agents,
  knowledge: <from knowledgeNamespaces>, repos: [ <derived> ] }` where
  `<derived>` is the canonicalized `origin` of the working directory if it is a
  git repo with a remote, and a `local-only` resource otherwise (including the
  seeded `default` project, which has no directory at all).
- **Binding**: `{ projectId, resourceId, path: <the old workingDirectory,
  verbatim>, remotes: <all canonicalized remotes of that checkout> }`.
- **Contribution**: **nothing, in any scope.** Default-off is default-off,
  including at migration. An existing project does not become an execution
  target because it had a path; the operator opts in per space and per
  resource, or the Station offers nothing (§4.2). This is the single most
  important migration rule, the easiest one to get wrong by "helpfully"
  backfilling, and the data-side expression of the §4.6 invariant — a purely
  local user's Station gains no contribution concept at all.

The path is additive at every step:

1. **Nothing existing changes shape.** `project.json` stays exactly as it is.
   The manifest lands as a sidecar (`<home>/projects/<slug>/manifest.json`) and
   the bindings as one file under `<home>/config/`. A Station with no manifests
   behaves identically to today — that is the compat shim, and it is the
   absence of a manifest rather than a flag.
2. **`ProjectConfig.workingDirectory` remains authoritative during compat.**
   `resolveProjectResource` reads the binding store when a manifest exists for
   the slug and falls back to `project.workingDirectory` otherwise. One
   fallback, in one function, with one code path to delete later.
3. **The five seams migrate one at a time** (§2.2 table). Each is an
   independent, individually testable change; `resolveStartSessionCwd` is the
   riskiest because every engine family reaches its adapter through it and its
   fail-closed contract must be preserved verbatim.
4. **Backfill is lazy, not a migration script.** A project without a manifest
   gets one written the first time something asks for its resources. No
   startup migration, no bulk rewrite of `project.json`, nothing to roll back.

**What breaks if nothing migrates: nothing.** That is the design intent and
also the risk. #1302 is the cautionary precedent — a scoping design that landed
partially and stayed dead, with `ConversationRecord.projectId` written by
nobody. Two concrete defenses:

- **Write manifests for every new project from slice 2 onward.** New projects
  are never in the earlier shape, so that read path shrinks monotonically
  instead of persisting as a permanent second mode.
- **The layout copy is the tell.** `projects.ts:255-262, 297-306, 405-411`
  copies `workingDirectory` into layout config in three places and backfills it
  on read — a second, drifting copy of a local path. Slice 0 stops that write,
  because the same mistake made at the binding layer would be much worse.

The cost of *never* migrating, stated plainly so the tradeoff is legible: #1392
cannot map channels to projects, #1123 cannot express a target constraint,
#1409 R6 cannot express a shared authorization context, there is no place to
record what a machine offers, and a moved checkout keeps silently breaking
every project-scoped surface.

## 6. Consumers

### 6.1 Routing constraints (#1398)

The constraint is a manifest-level predicate evaluated against **contribution
projections**, not against bindings and not against paths:

```jsonc
{ "kind": "project-contribution", "projectId": "prj_7f3a…",
  "require": "execution", "resourceId": "github.com/kontourai/station",
  "maxAgeMs": 3600000 }
```

**The constraint must check contribution, not binding.** "Has a binding for
repo X" is the wrong predicate: it routes work into checkouts whose owners
never offered them (§4.3). The honest predicate is "**contributes execution for
repo X**", satisfied only when the opt-in is on, the repo is named in the
allowlist, and the local binding currently resolves — i.e. participation
`contributing` with that `repoId` present in `execution[]` and `bound: true`.

Each candidate Station answers with its project-contribution projection (§4.2).
The router selects, and the Dispatch receipt cites the constraint, **every
candidate's answer including the rejections**, and the selection. Four rules
keep it honest:

- **A stale answer is `unknown`, not satisfied.** `verifiedAt` older than
  `maxAgeMs` fails the constraint rather than passing it optimistically; a
  binding can vanish between the projection and the dispatch. Freshness is
  computed from `sourceObservedAt`, not `projectedAt` (§4.2 decision 3) — this
  is precisely the confusion that field split exists to prevent.
- **`contributed-unavailable` is a named rejection, not silence.** A Station
  that offers repo X but whose binding is `missing` is rejected *by name* in
  the receipt. That is the difference between "nobody could take this" and
  "your desktop was supposed to take this and its checkout is gone."
- **It is query-scoped, not inventory-shaped.** A peer answers for the project
  and resource asked about; it does not publish a list of everything it backs.
  `inference-fleet.md:1052-1067` already defers replicated routing evidence for
  the same reason: a corpus of it is a fleet-wide inventory. (§9 OQ-4.)
- **Attribution comes from the transport.** The receipt names candidates by the
  environment the router authenticated to, never by a self-asserted id in the
  body (§4.2 decision 4).

Per `inference-fleet.md:962-985`, **fleet *inference* will rarely populate this
channel** — moving token generation does not require the repo, and
`packages/contracts/src/fleet-inference.ts` makes that boundary explicit
("completions only. It is not `delegate_task`"). Task delegation is where
contribution constraints do the work, and this doc claims only that.

### 6.2 `delegate_task` targeting (#1123)

Today the caller names the machine (`environmentId`) and passes a `projectSlug`
or an explicit `projectPath`/`cwd`, and the delegation path *deliberately* skips
an existence check on the path because the target may be remote
(`src-server/tools/station-control-delegation.ts:716-724`). Three things change:

- **The slug join becomes sound.** A `projectSlug` only identifies the same
  project on two Stations by coincidence — slugs are locally generated with
  local dedupe suffixes (`project-service.ts:32-76`). The manifest `id` is the
  portable join key; `projectSlug` degrades to a display name in the delegation
  input.
- **The deliberate no-check becomes checkable at the right end.** The caller
  states a constraint; the *target* resolves it against its own binding store
  and answers before work is sent. The existence check moves from the machine
  that cannot perform it to the one that can, and its outcome is receipted
  rather than assumed.
- **Consent becomes explicit.** Delegation today is authorized by possessing a
  credential for the target. With contribution, the target additionally has to
  have *offered* execution for that project's repo. A Station can hold a
  delegation grant and still decline to be an execution target for a given
  project — a distinction the current model cannot express.

`DelegationTarget.projectPath` (`:76-89`) stays for the explicit-path escape
hatch; it just stops being the only way to express intent.

### 6.3 Channels (#1392)

A channel binds to a manifest `id`. Membership gates reading the manifest;
bindings never cross; contribution projections cross only when asked. Every
member sees the same project state and materializes it locally — or does not,
per §4.1, which is a normal outcome and not a gap. The manifest is the
tenant-scoped row that #1392's "every table keyed by tenant id" rule requires;
the binding store is explicitly *not* a tenant table, because it is not on the
server at all; and contribution config is per-Station settings, which is also
not a tenant table.

The backing view (§4.7) is the channel-side rendering of all three, and it is
where "agents are members, not bots" meets "machines are what members bring."

### 6.4 Shareable provenance (#1409)

Content-addressed snapshot refs are already location-independent. The gap is
two-sided:

- **R6** requires reads authorized "in the caller's current Project/room
  context." A path-keyed project cannot be that context across members; a
  manifest `id` can.
- **Repo-file locators must stop being absolute paths.** An excerpt citing a
  file in a project repo should be `{ repoId, path, rev }` — resolving per
  member through their own binding — not `~/dev/repo/src/x.ts`.
  That form survives being read on a machine that has the repo at a different
  path, and degrades honestly on a machine that does not have it at all rather
  than to a broken path. For a non-backing member (§4.1) it degrades to "this
  citation points into a repo you don't have locally" — a statement about the
  citation, not a deficiency notice about the member.

This is the direction the issue names as mutual: the provenance arc needs
remote-keyed identity to be shareable, and remote-keyed identity needs
provenance to be worth sharing.

## 7. Occupancy: many projects, one tree

Remote-keyed bindings make a previously-accidental configuration ordinary: two
projects can legitimately bind the same repo, and therefore the same directory
— a monorepo split into product-scoped projects, a project and a worktree of
it, a shared vendored dependency.

**The binding is not a lock, and this doc does not propose making it one.**
Sharing a tree is legitimate; what must be true is that occupancy is
*observable and attributed honestly*. The design rule that makes this tractable
is one line:

> **Bindings are remote-keyed; occupancy is path-keyed.**

Two worktrees of one repo do not contend — different trees. Two projects
pointing at one directory do contend — same tree. So occupancy keys on the
`realpath` of the resolved directory (`workspaceKey`), never on the resource id.

What v1 should record and show:

1. **`workspace_key` and `project_slug` on the session state row.** Today the
   project binding of a session survives only inside an event JSON payload
   replayed at startup, and `cwd` has no index and is never cleared on close
   (§2.7). "Which live sessions are in this tree" should be a query with a
   status join, not a full-table scan plus string comparison with no
   canonicalization.
2. **A count and an attribution, not a verdict.** "2 live sessions in this tree
   — 1 from *Station*, 1 from *Docs*" is honest. "This tree is free" is **not**
   honest and must never be shown: Station knows about its own sessions and
   nothing about the user's terminal, editor, or another tool holding the same
   directory. The limit of the claim has to be visible in the wording.
3. **The reverse map must return a set.** `resolveAttachedProjectRoot` returning
   one arbitrary, `readdir`-ordered slug is a correctness bug *today* (§2.6),
   and it is made common by this design. It must return every project whose
   binding contains the cwd, preserving longest-prefix preference for genuinely
   nested projects and requiring explicit disambiguation for ties. Because the
   mis-attribution is content-addressed into the event log and never
   self-corrects, **this fix has to land before bindings make ties ordinary** —
   hence slice 0.
4. **Occupancy is local, and it does not cross the wire.** A contribution
   projection says whether a Station offers and can serve a resource; it does
   **not** report how busy that Station's tree is. Live session counts are a
   work-pattern signal about a person, and exporting them would make the
   backing view a productivity monitor. A busy Station simply serves or refuses
   the work it is sent.
5. **Enforcement is deferred, not designed around.** `WorktreeProvisioningService`
   is the natural donor for an "isolate instead of contend" answer — it already
   has the gates and the `worktreeConflictPreventedTotal{detection_source}`
   metric shape — but it is dead code with no ownership record, and turning it
   on requires deciding what happens when the gate fires. That is a product
   decision (§9 OQ-6), and showing contention truthfully is worth shipping
   before deciding it.

## 8. Explicitly deferred

| Deferred | Why | Revisit when |
|---|---|---|
| A generalized resource graph | #1425 rules it out; v1 models only what `ProjectConfig` already references | A resource kind arrives that is neither repo, knowledge, agent, nor integration |
| The backing **view** (§4.7) as a shipped surface | It needs a room to render in, and a single-member fleet's backing board is a status page for one person | #1392 ships channels (§9 OQ-11) |
| A presence/liveness contract for Stations | None exists; `lastVerifiedAt` is a last-seen, and #741 forbids inventing a green dot | #741's fleet inventory slice |
| Project **requirements** and offer compliance (§4.4) | Sketched only; the owner flagged it for further thought and the requirements vocabulary has no bound yet | §9 OQ-12 is answered |
| A policy *engine* for project requirements | `inference-fleet.md:860-880` decided "design the seam, ship no policy engine" for the fleet on the same grounds — no tenant to publish one | #1392, with a requirements vocabulary already bounded |
| Multi-repo checkout orchestration (clone-all, layout, sync) | v1 *records* bindings; creating them is a separate product with its own failure modes | Multi-repo projects exist and manual binding is the observed friction |
| Cross-forge identity federation (proving two remotes are one project automatically) | Unsolvable without a trusted mapping; manifest `aliases[]` covers the deliberate cases | A forge publishes a verifiable move/mirror record |
| Deriving host aliases from `~/.ssh/config` | Reading a user's ssh config to change matching behavior should be explicit | The manual alias map is in use and the friction is measured |
| Tenant scoping of the manifest | That is #1392's job; this doc reserves `memberId` and stops | #1392 ships membership |
| Per-field redaction when sharing a manifest (base URLs, private forge hosts) | No sharing mechanism exists yet, so the policy would be unenforceable | A manifest actually crosses a tenant boundary (#1392) |
| Contributing **tools** or **knowledge** (vs execution/agents/inference) | The fleet arc already defers tool contribution because tool-surface data is structurally unknowable (#1430); knowledge contribution has no consumer | #1430 closes; a consumer asks for shared knowledge roots |
| Enforcing exclusive occupancy / auto-worktree isolation | Requires deciding what happens when the gate fires; observation ships first (§7) | Contention is visible and measured (§9 OQ-6) |
| Replicating bindings across a member's own Stations | A binding corpus is a machine inventory; consent lives in the replication slice | #741 slice 3 |
| Non-git resource kinds (object stores, artifact registries) | No consumer | A consumer exists |
| Removing `slug` as the local routing key | ~40 sites, every route and on-disk path | Never, unless something forces it (§9 OQ-5) |

## 9. Open questions for the owner

Each carries a recommendation. Deciding these unblocks slice 1.

- **OQ-1 — Is the canonical remote string itself the resource id, or a hash of
  it?** *Recommend: the string.* `github.com/kontourai/station` is legible in a
  manifest, a receipt, a log line, and an error message, and legibility is the
  point of a shared artifact. `collectRepositoryIdentity`
  (`scripts/lib/test-reliability.mjs:284-320`) hashes because it wants a
  fixed-width receipt key; a hash stays derivable wherever one is needed. Cost
  accepted: ids are variable-length and contain `/`, so anything using them as
  a filename must encode.

- **OQ-2 — Where does the manifest live: a sidecar under `<home>`, a nested
  field in `project.json`, or committed inside the repo?** *Recommend: a
  sidecar (`<home>/projects/<slug>/manifest.json`).* A nested field means every
  write goes through `saveProject`'s whole-file overwrite with no merge
  (`file-storage-adapter.ts:89-97`). Committing it in the repo is genuinely
  attractive — self-describing projects — but it inverts authority: a project
  may span repos, so no single repo can own it, and a repo-owned manifest
  cannot represent the member who has none of the repos yet. Defer the
  committed form; the sidecar does not foreclose it.

- **OQ-3 — Do forks belong in manifest `aliases[]` or purely in the binding's
  remote set?** *Recommend: both, with different authority.* Manifest aliases
  carry deliberate, shared equivalence (mirrors, forge migrations). The
  binding's remote set carries personal forks. This keeps forks private,
  keeps the manifest small, and means the shared artifact only contains facts
  the whole channel agrees on (§3.3).

- **OQ-4 — Does a peer learn what a Station backs, or only the answer to the
  question asked?** *Recommend: query-scoped.* Answer for the project and
  resource asked about; never publish an inventory. A backing list is a machine
  fingerprint, and `inference-fleet.md:1052-1067` already defers replicated
  routing evidence for the same reason. Cost accepted: N round trips for N
  constrained resources, negligible at fleet scale.

- **OQ-5 — Does `slug` remain the local routing key?** *Recommend: yes.* Every
  on-disk path, every `/api/projects/:slug/*` route, `LayoutConfig.projectSlug`,
  `KnowledgeRootScope`, and the delegation input are slug-keyed. The manifest
  `id` becomes the portable join key and `slug` stays local naming — the same
  local-id/server-id split `KnownEnvironment` already ships
  (`packages/contracts/src/known-environment.ts:84-97`). Changing the routing
  key is a separate, larger change with no consumer asking for it.

- **OQ-6 — Occupancy in v1: show or enforce?** *Recommend: show.* Enforcement
  requires deciding the response — refuse, warn, or auto-provision a worktree
  — and the auto-worktree answer means reviving dead code
  (`worktree-provisioning-service.ts`) that persists no ownership record and
  orphans worktrees on crash. Showing "N live sessions in this tree, from these
  projects" is cheap, truthful, and produces the data needed to decide (§7).

- **OQ-7 — Does the reverse-map fix land before bindings, or with them?**
  *Recommend: before, as its own slice.* It is a correctness bug today —
  order-dependent attribution, content-addressed into the event log so it never
  self-corrects (§2.6) — and bindings turn its rare tie case into the ordinary
  one. Shipping it alone also means it can be verified against today's behavior
  rather than against a new abstraction.

- **OQ-8 — Are `local-only` resources allowed in a shareable manifest, or
  refused at share time?** *Recommend: allowed and marked `not-portable`.*
  Refusing at share time turns migration into a wall for exactly the projects
  most likely to migrate first — Station's own seeded `default` project has no
  directory at all. A resource that resolves for its author and honestly says
  "never shareable" to everyone else is a better artifact than a manifest that
  cannot be written.

- **OQ-9 — Credential references: reuse datum's three backends, or a
  Station-native integration ref?** *Recommend: Station-native
  `{ station: "<integrationId>" }` as the primary, with datum's `{env}` /
  `{keychain}` / `{op}` accepted where datum is already the resolver.* Station
  owns `<home>/integrations/`; a manifest naming an integration should name
  Station's id for it. Do not invent a fourth backend. Adopt datum's
  key-looking-literal validator rejection verbatim (§3.4).

- **OQ-10 — At the end of migration, is `workingDirectory` deleted or kept as a
  derived read-only projection?** *Recommend: removed from `ProjectConfig` (the
  write model), kept on `ProjectMetadata` as a derived read-only field.* The UI
  has ~25 display sites and a settings editor; a derived field keeps them
  working while making a second writable copy impossible. The coding-layout
  copy (`projects.ts:255-262`) is the evidence for why a second *writable*
  copy is the failure mode to design out.

- **OQ-11 — Does the contribution layer and the backing view ship in this arc,
  or with the collaboration tier's channels?** *Recommend: define the
  contribution **contract** in this arc, ship the manifest/binding slices first,
  and let the backing **view** ride the collaboration arc.* Three reasons. The
  contract is cheap now and expensive to retrofit — if project contribution
  arrives after channels, `station.fleet-contribution/v1` becomes the *second*
  noun for one concept rather than the first instance of one. The view needs a
  room: #1392 has no channels yet, and a backing board for a single-member
  fleet is a status page for one person. And the constraint work (§6.1) needs
  the contract, not the view, so #1123 is unblocked either way. Shape the
  contract so the shipped fleet manifest is literally its first instance —
  reuse the four-state participation, the two-clock freshness split, the
  default-off allowlist, and the no-self-asserted-identity rule verbatim rather
  than paraphrasing them (§4.2).
  **The contract must carry the scope dimension from v1** even though only the
  `{ kind: 'fleet' }` and `{ kind: 'project' }` scopes are reachable in this
  arc. Adding a scope to a shipped, consumed projection later is a wire change
  across every peer; carrying it now costs one discriminated field. This is
  what keeps per-space contribution (§4.2) from becoming a second contract when
  channels arrive, and it does not change the slice shaping — slice 2.5 is the
  same size with the field as without it.

- **OQ-12 — Project requirements and offer compliance (§4.4): what exactly can
  a project require, where is it enforced, and how is partial acceptance
  shown?** *Owner-pending — flagged as needing more thought; recommendations
  below are a starting position, not a decision.* Three sub-questions:
  - **(a) The requirements vocabulary's bounds for v1.** *Recommend: only facts
    the existing manifests already carry truthfully* — canonical remote
    identity (§3.3), model presence from the contributed inventory, and
    declared capability fields that have a real producer. Nothing whose
    producer hardcodes a placeholder. This is the #1430 lesson as a rule: if a
    field would be a placeholder that reads as an observation, a project must
    not be able to require it. Anything outside the bound yields
    `attested-unverified`, never manufactured compliance.
  - **(b) Enforcement point.** *Recommend: offer time, fail-closed and named,
    plus re-check on the liveness cadence* — with `accepted-degraded` as the
    landing state for post-acceptance drift. Use-time-only enforcement makes
    every dispatch a possible surprise; offer-time-only enforcement goes stale
    silently. The open part is the cadence itself, which should not be chosen
    before there is a presence contract to hang it on (§8).
  - **(c) Partial-acceptance UX.** *Recommend: per-resource acceptance*, using
    the existing per-connection diagnostics idiom — `{repo ✓, model ✗}` lands
    the repo and names why the model did not. All-or-nothing would silently
    withdraw a machine that was useful for one thing because it fell short on
    another.

  Whatever is decided, one constraint should hold regardless: refusal reasons
  go to the offering member only, and the contributor-side "not accepted"
  vocabulary stays distinct from the consumer-side `unresolvable` (§4.4).

## 10. Slice plan

Sized by dependency and shippability, not estimates.

- **Slice 0 — Reverse-map correctness and the layout copy.** Make
  `resolveAttachedProjectRoot` return every matching project with explicit
  longest-prefix preference and explicit tie handling; stop writing
  `workingDirectory` into coding-layout config and derive it on read instead.
  No new concepts. Independently shippable today, independently useful,
  verifiable against current behavior. (§9 OQ-7.)

- **Slice 1 — Contracts and canonicalization.** `ProjectManifest`,
  `ProjectBinding`, and `ResourceResolution` land in `packages/contracts`.
  `normalizeGitOrigin` is promoted out of `scripts/lib/test-reliability.mjs`
  into a shared, tested home with the fixture table from §3.3 plus the
  host-alias, multi-remote, and case-sensitivity cases. Zero behavior change;
  pure types and one pure function.

- **Slice 2 — Stores and the resolver, behind the existing fallback.** Manifest
  sidecar + `project-bindings.json` + `resolveProjectResource`, with
  `project.workingDirectory` as the fallback when no manifest exists. Manifests
  are written for every new project and backfilled lazily. Nothing
  user-visible changes; the compat shim is exercised by every existing project.

- **Slice 2.5 — The scoped contribution contract (§9 OQ-11).** A scoped
  `contribution` config on `AppConfig` + its settings-registry entry, the
  scope discriminant (`fleet` | `project`), the four-state participation enum,
  the fail-closed reader, and the projection builder — modelled on
  `fleet-contribution.ts` and reusing its four decisions verbatim, with the
  shipped fleet contract as the `{ kind: 'fleet' }` instance. No UI, no wire
  route, no consumer yet, and **no requirements/compliance machinery** — §4.4
  waits on OQ-12. Its own change, its own verification, no new behavior.
  Depends on slice 2, because the projection's `execution[]` needs bindings to
  project. Small; the value is that the noun exists once rather than twice, and
  that the scope dimension never has to be retrofitted onto a shipped wire
  type.

- **Slice 3 — Migrate the five seams.** The largest single risk in the arc:
  `resolveStartSessionCwd` is fail-closed by design and every engine family
  reaches its adapter through it, so its docblock contract
  (`orchestration-service.ts:526-563`) is the regression spec. The other four
  seams are independently testable and can land in any order after it.

- **Slice 4 — Resolution states in the UI.** `bound` / `unbound` / `missing` /
  `drifted` / `stale` / `unresolvable` / `not-portable` with repair actions,
  the attempted-and-denied narrowing of `unresolvable` (§3.6), and the
  not-backing path (§4.1) — a project whose Stations back nothing shows no
  resource rows and no repair prompts. First user-visible slice: a project
  survives a moved checkout and says honestly when it cannot resolve. Includes
  the single-repo bind/clone convenience.

- **Slice 5 — Multi-repo.** A manifest names more than one repo; the resolver
  takes a `resourceId`; knowledge roots and layouts reference repos by id.
  Depends on slice 4 (the states are what make a partially-bound multi-repo
  project legible).

- **Slice 6 — Contribution projections and the `constraints[]` channel.** The
  authenticated projection route, the `project-contribution` constraint, and
  `delegate_task` targeting by constraint with a Dispatch receipt citing named
  rejections. Depends on slice 2.5 for the contract, and on the fleet arc's
  receipt work (`inference-fleet.md` §3.4, §6.3) and #1123.

- **Slice 7 — Occupancy surface.** `workspace_key` + `project_slug` on the
  session state row with an index, the live-session query, and the
  cross-project attribution display (§7). Depends on slice 0 for the reverse
  map and on slice 3 for a canonical resolved path.

**Deliberately not a slice here:** the backing view (§4.7). Per OQ-11 it rides
the collaboration arc, and slice 2.5 is what lets it do so without inventing a
second contribution noun when it arrives.

**Sequencing note.** Slice 0 is worth shipping regardless of whether this
design is adopted — it fixes a live correctness bug. If the arc has to stop
somewhere, **stopping after slice 4 leaves a coherent, honest, shipped
product**: single-repo projects that survive a moved checkout, tell the truth
about what they cannot resolve, and carry a portable identity that #1392 and
#1123 can join on later. Slice 2.5 is worth including even in that truncated
form, because it is small and it fixes the vocabulary before two nouns exist.
Slices 5–7 are the collaboration and fleet payoff and each depends on an arc
outside this one.

## 11. UNVERIFIED

Recording a direction does not verify it. Each item below is a gap this doc
knows it has.

- **Every current-behavior claim was read, not executed.** No test was run, no
  Station was started, and no scenario was reproduced for this doc. The
  fail-closed and fail-open behaviors quoted from
  `orchestration-service.ts:616-688` and `task-graph-service.ts:743-760`
  /`:1069-1082` are readings of code and docblocks. (Those refs were **wrong**
  as first written — `:519-688` and `:926-976`; corrected at slice 3b, which is
  itself evidence for the item above.)
- **§2 was swept against an older `origin/main` than §2.8.** Fleet slices 1–2
  landed between revision 1 and revision 2 of this doc; the fleet claims in
  §2.8 and §4.2 were re-verified against current `origin/main`, but §2.1–§2.7
  were not re-swept. A fleet-adjacent change to the project surface in that
  window would not appear.
- ~~**The "~40 consumers reduce to five seams" claim (§2.2) comes from a grep
  sweep**, spot-checked at each named seam. It is not an exhaustive
  re-derivation, and a consumer reading `workingDirectory` off `ProjectMetadata`
  or off a layout config rather than through a seam would not appear in it.
  Slice 3 must re-derive the list before migrating.~~
  **CLOSED by slice 3b (station#1501): the claim was wrong.** The
  re-derivation is §2.2.1. Both suspected blind spots were real — a
  `ProjectMetadata` consumer (A3, the diff-comments aggregate) and a
  layout-config consumer (A9) — plus six more, two false attributions inside
  the table, two named seams that were themselves incomplete, and two
  "consumers" that read a *remote* Station over HTTP and must never be pointed
  at a local resolver.
- **`normalizeGitOrigin`'s behavior on the §3.3 table was reasoned from the
  regexes**, not exercised. The SSH-host-alias, multi-remote, and
  case-sensitivity cases in particular have no fixture today; slice 1 must add
  them before the function becomes an identity key.
- ~~**The contribution generalization (§4.2) is a reading of a shipped contract,
  not an executed integration.** `fleet-contribution.ts` was read; no project
  contribution exists, and whether its four decisions survive contact with a
  non-model resource axis — execution for a repo has a *binding* behind it,
  which a model connection does not — is unproven until slice 2.5.~~
  **CLOSED by slice 2.5 (station#1500): all four survived.** One WIDENED rather
  than carrying over unchanged — decision 3's clock. A model connection's
  observation is the inventory's single `observedAt`; execution's is a
  *per-binding* `verifiedAt`, one per repo. So `sourceObservedAt` is derived as
  the OLDEST observation across every axis, and the per-repo timestamp is
  additionally carried on the `execution[]` entry because §6.1's constraint asks
  about one repo rather than about the projection as a whole. Nothing was
  dropped and no decision was relaxed: one scalar became a scalar plus a
  per-resource column, and the aggregate stays honest by taking the oldest —
  a projection is only as fresh as its stalest source. Decision 2 gained
  evidence rather than tension: `contributed-unavailable` is now derived from
  SERVEABLE resources rather than from list length, because an `execution[]`
  entry with `bound: false` is present by design and is exactly the thing that
  cannot be served. Decisions 1 and 4 needed no change at all; decision 4 is now
  *enforced* on the read (`isWellFormedContributionProjection` refuses a body
  carrying `stationId`/`environmentId`/`memberId`) rather than merely absent
  from the type.

  Two slice-2.5 decisions the doc left open, recorded here:
  - **`station.fleet-contribution/v1` is KEPT ALONGSIDE, not aliased.** The two
    wire bodies differ (the fleet manifest carries the full model record; this
    projection's `inference[]` is `{id, connectionId}`), so one schema id over
    both would be a false claim of wire compatibility; an alias would also
    change what an existing fleet consumer reads today. Slice 6 owns the first
    real consumer and is where a migration can be made against a reader instead
    of against an argument.
  - **The fleet scope has ONE writable home.** `AppConfig.contribution` carries
    both scopes as §4.2 requires, but `resolveScopedContribution` reads the
    `fleet` scope from `AppConfig.fleetContribution` and REFUSES a shadowing
    `contribution["fleet"]` entry by name. Merging or preferring the map would
    give one consent two editable copies, and refusing contributes strictly
    less — the only direction decision 1 permits an ambiguity to resolve in.
- **There is no presence or liveness contract**, so §4.7's "last seen" column
  is specified against `AccessEndpoint.lastVerifiedAt` — a handshake timestamp
  that exists only for environments this client has actually handshaken with.
  Whether it is populated often enough to be useful in a backing view is
  unmeasured.
- **`WorktreeProvisioningService` being dead code is a grep-based claim**
  (only importer is its own test). A dynamic or string-keyed invocation would
  not appear.
- **No measurement exists of how many real Station projects already share a
  directory**, so the practical severity of the §2.6 mis-attribution bug is
  unknown. It is argued from code, not from field data.
- **The datum idiom (§3.4) was read from the locally checked-out `../datum`
  README and `CONTEXT.md` at an unpinned revision.** No version is asserted and
  no import relationship exists today; slice 1 should pin the behavior it
  copies rather than the package.
- **§4.4 is unsettled by construction**, not merely unverified: the four-state
  outcome taxonomy, the enforcement points, and the requirements vocabulary are
  a starting position for OQ-12. No part of it has been checked against a
  consumer, and the claim that the fleet's admission machinery generalizes
  cleanly to a project is an argument from shape, not an integration.
- **The local-only invariant (§4.6) is stated, not enforced.**
  `tests/first-run-live.spec.ts` is named as its pin, but that test asserts
  today's journey — it would not fail merely because a *new* concept appeared
  elsewhere in the product for a purely local user. Whether the invariant needs
  its own guard, and what it would assert, is an open slice-4 question.
- **The privacy claims in §4.3 and §6.1** — that a contribution projection
  discloses only what was deliberately offered, and that occupancy stays local
  — are arguments, not a threat-model review. Slice 6 owes a real one,
  including whether projection *timing* is itself a signal.
- **#1392's channel mapping (§6.3) is inferred from the epic body.** No channel
  code exists; the manifest `id` being the right join key is a design claim
  that the multi-tenant arc can still invalidate.
- **The seven resolution states have no UI test**, and §4.1's not-backing path
  has no design mock. Whether `unbound` / `missing` / `drifted` / `stale` are
  distinguishable enough to be worth four separate states, or collapse in
  practice, is unproven until slice 4.

### 11.2 What slice 5 (station#1503) established by shipping

- **The compat working-directory fallback stands in for AT MOST ONE resource.**
  §5 makes `workingDirectory` the compat-era binding, and one declared directory
  can realize one repo. Handing it to every unbound resource of a multi-resource
  manifest did not merely over-claim: a secondary repo was verified against the
  PRIMARY's checkout and came back `drifted` ("a different repository is at that
  path"), sending the operator to repair a directory that was doing exactly what
  it should. The fallback is now the primary's only; every other unbound
  resource is `unbound`, and when no single resource is THE primary, none
  inherits it.
- **The resolution view carries a LIST and the primary selection.** Resolving
  per declared id would have silenced the ambiguity signal: a manifest with two
  primaries renders N healthy rows while every no-`resourceId` consumer (the
  session cwd, the knowledge scan, the task workspace) still fails. The view
  therefore carries `resources[]` *and* `primary`, and its predicate enforces
  that the two agree — an empty list is legal only beside an unnamed primary.
- **`ProjectKnowledgeRef`'s repo arm had no producer.** `composeManifest` mapped
  every namespace to `{kind: 'station-managed'}` unconditionally.
  `KnowledgeNamespaceConfig.repoRoot` is that producer, and the scanner resolves
  it through the resolver with the resource id rather than through "the
  project's directory" — which on a multi-repo project is a different
  repository's tree.
- **`repoId` on a coding layout is a REFERENCE, not the copy §1497 removed.** A
  resource id is a portable fact about the project and is safe to persist; the
  path stays derived on every read, and a named repo that is not bound here
  derives NO working directory rather than falling back to the project's.
- **The bind repair action names its resource.** A multi-repo project renders
  one form per row, and a bind that ignored `resourceId` would write the
  primary's record whichever row was used. An unknown id is refused by name,
  never answered by binding the primary.

### 11.1 Corrections that slice 4 (station#1502) established by shipping

- **§10's "includes the single-repo bind/clone convenience" was over-promised
  by the slice-1 contract.** Slice 4 ships the **bind** half. The clone half is
  not blocked by the remote being unavailable — a git resource's `id` *is* its
  `canonicalRemote` — but by a canonical remote not being a clone **URL**:
  `normalizeGitOrigin` strips scheme and credentials, so Station would have to
  guess one. An authorization failure against a URL Station chose is not the
  §3.6 `unresolvable` fact ("nothing local; the gap is upstream"), because the
  local repairs still exist, so building the convenience on a guess would
  manufacture the one assertion §3.6 rule 2 forbids. A clone action needs a
  resource-level clone **source** — an author-written URL or a per-member
  preferred protocol — which is a contract addition. Deferred to slice 5.
- **`unresolvable` and `not-portable` ship as renderers with no producer.**
  Nothing in Station asserts either today: `unresolvable` is scoped to an
  attempt that was denied and slice 4 performs no authenticated remote
  operation, and `not-portable` needs the membership model (#1392) to know a
  `local-only` resource was authored by someone else. Both arms exist and are
  covered by tests over the contract type; neither is reachable from the
  server. This is disclosed rather than implied — a reader-without-a-producer
  is the same defect class as a fabricated value when it is left unsaid.
- **§4.1's not-backing derivation is the single-Station reading, not the §4.1
  claim.** Membership does not exist yet, so "backs nothing" is implemented as
  "nothing declared here and nothing realized here". True on every install
  today; not the multi-Station statement §4.1 makes. Recorded on
  `describeProjectResolution` rather than glossed.
