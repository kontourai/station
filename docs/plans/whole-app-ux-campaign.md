# Whole-app UX campaign

> **Activity retirement amendment:** Activity and its Quick review pane are
> removed. Home and the inbox list work; Session links and child transcripts
> open in Chat. The Activity-specific delivery notes below describe the earlier
> design. See [placement](../design/placement.md) for migration and URL compatibility.


This execution plan belongs to [#4506](https://github.com/kontourai/station/issues/4506).
The issue owns changing runner grants, journey results, prerequisites, findings and
PR state. This document owns scope, source routing, acceptance and handoff rules.
An inventory or an existing test does not establish that a journey works.

## Authority and scope

Reconcile the live implementation against the [browser manifest](../../tests/e2e-manifest.mjs)
and [coverage matrix](../guides/e2e-coverage-matrix.md). The matrix routes to
representative assertions and explicitly does not claim complete coverage.
The source inventory began at `d121805f3a3ec71b4e69b37b5302f7eb0828e5cb`;
this plan's checkout started at `3826fd7df9f373faa3349e87724816af783c86d0`.
Each executed journey records its own exact revision and environment in the issue.
These revisions are historical inventory inputs, not a claim about current main.

Classify each capability as implemented, preview, installable example, experimental,
or designed. Trace the entry point and consuming branch before classifying it.
A design proposal, catalog entry, available method or test filename is not execution
evidence. Defaults and runtime-offered previews can vary by deployment.

The ultimate orchestrator owns integration and merge order. Feature owners publish
small coherent PRs, link them immediately, and continue their remaining journeys
after a fair runner rotation. They do not merge or arm another owner's PR.
One repair or a published PR does not complete a feature lane.

## Ownership map

Thread links and current ownership are maintained in the issue roster. Stable lane
IDs below let results survive thread/context changes without copying live status here.

| Lane | User journeys | Source and guide route |
| --- | --- | --- |
| UX-01 Entry | Access, fresh setup, import review/apply, tour, Home start/continue, sidebar, palette/search, deep links and guarded navigation | `src-ui/src/components/first-run/`, `components/setup/`, `views/home/`, `app-shell/destination-registry.ts`, `app-shell/routing.ts`; [getting started](../user/getting-started.md) |
| UX-02 Chat | Compose/attachments/drafts, stream/Stop/steer/queue, retry/reconnect, history/import/lineage, approvals/goals, inventory/Basis and answer-share launch | `components/chat-dock/`, `chatDraftsStore`, queue drain and conversation recovery owners; [chat composer](../design/chat-composer.md) |
| UX-03 Connections | Models/Engines/Tools/Knowledge/Computers, account/OAuth recovery, Agent create/edit/copy/readiness/defaults, authority and capability admission | `views/connections-hub/`, `ProviderSettingsView`, `AgentConnectionView`, Agent editor; [connections](../guides/connections.md), [Agent configuration](../guides/agent-configuration.md) |
| UX-04 Projects | Project lifecycle and bindings, Task create/shape/accept/dispatch/status, list/board/collections, room documents/drafts/review/checkpoints, references and return | Project settings/page, `TaskWorkspaceView`, `TaskRoomPage`, Task room editor/conversation; [workspaces](../user/workspace-checkpoints.md) |
| UX-05 Boards | Personal Board authoring/proposals/organize, Work Board references/geometry/undo, Session/reference Boards, pane tree and region placement/persistence | `PersonalBoardView`, `personal-board/`, `workspace-panes/`, `regions/`; [personal Boards](../user/personal-boards.md), [Work Board](../user/work-board.md) |
| UX-06 Workspace | Files/CRUD/filter/preview, Git/diff/annotations, terminals, PR guides/review, checkpoints, Developer and Plan/Readiness/Trust | `components/coding-layout/`, pane renderers and Developer; [PR guides](../user/pull-request-guides.md) |
| UX-07 Extensions | Skills CRUD/import/commands, Registry categories/marketplaces/Kits, plugin preview/permission/install/update/recovery/remove, dynamic pane availability | Skills, Registry and plugin views plus runtime catalog; [plugin delivery plan](plugin-core-delivery.md) |
| UX-08 Automation | Cron/every/at lifecycle, run/history/output/exact receipt, chat targets/check-backs, background tasks, bounded GitHub automation/repair and budgets | Schedule view/dialog/detail, scheduler/background owners; [Automations](../user/automations.md) |
| UX-09 Knowledge | Personal store, Project Sources/import, Library, Meeting Notes, speech/walkthroughs, previews, offline reading, root custody/learning and host images | Knowledge settings, source/import views and examples; [knowledge](../guides/knowledge.md) |
| UX-10 Collaboration | Profile/My access/People, invitations/roles/member views, Task sharing/presence/revocation, account/passkey and answer-share boundaries | Profile, account/member and sharing controls; [sharing answers](../user/sharing-answers.md) |
| UX-11 Browser/Device | Browser setup/profiles/navigation/control/dialogs/capture, Device setup/session/input/hosts, artifact/developer tools and Chat/Task transitions | Browser/Device panes and routes; [Browser](../guides/browser-workspace.md), [Device](../guides/mobile-device-workspace.md) |
| UX-12 Attention | Inbox/history/input replies/snooze, delivery/sound/push, Activity/Related return, usage/feedback/export/Personal views and monitoring | Notifications, Activity, Insights and telemetry owners; matrix Activity/Monitoring routes |
| UX-13 Preferences | Settings topics/search/deep links/scopes/save/discard, themes/accent/loading, shortcuts/conflicts, account sync/import, keyboard/focus/contrast | Settings catalog and views, Appearance, shortcut preferences; [settings](../user/settings.md) |
| UX-14 Native | Cold/warm startup, restart/service ownership/reconnect, updater, tray/window restore, mobile foreground/background/intake and permission recovery | `src-desktop/` and native adapters; [native recovery](../user/native-recovery.md), [native verification](../guides/native-shell-verification.md) |

### Routes, panes and settings

The [destination registry](../../src-ui/src/app-shell/destination-registry.ts) owns
root destinations and advertisement. Include Home, Agents, Skills (`/guidance`),
Connections, Registry, Plugins, Notifications, Automations, Developer, Appearance,
Settings and Profile. Activity is a region surface with a canonical deep link.
The [domain parser](../../src-ui/src/app-shell/routing.ts) also owns Agent and
connection children, project creation/editing/layouts/panes, Task and Board URLs.
Include legacy redirects and browser Back/Forward; palette aliases are entry
paths, not additional features.

Registry's implemented categories are Agents, Skills, Integrations, Plugins,
Layouts and Kits; marketplace sources and installed-state queries are separate
failure/retry owners. A catalog response is not proof of installation or use.

The [built-in renderer registry](../../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx)
and resolved pane catalog route Chat, Task editor/conversation, Coding/files/diff/
terminal, Plan/Readiness/Trust, Browser, file preview, plugin draft, PR, layout,
Home, Activity/review, Agents, Device, terminal sessions, spatial Board, Board and
Basis. Installed plugin descriptors/renderers add catalog entries: test availability,
permission, removed bindings and recovery, not only built-in renderers.

The [Settings catalog](../../src-ui/src/views/settings/settings-catalog.ts) owns
topic/row identities. Preferences owns navigation and persistence presentation;
domain owners prove the resulting behavior of their settings. Cover account,
Agent runs, answer shares, appearance/chat, browser/device hosts, diagnostics,
developer tools/previews, host/runtime, shortcuts, knowledge, notifications,
pairing/people/permissions, plugin visibility, sources/Station routes, system,
telemetry, voice and About. Do not count a setting click as proof of its consumer.

A direct project-session-board placement defaults to Builder-run admission in
`ConsoleBoardView`. The configured Session Board Layout adapter explicitly opts
out with `requireBuilderRun=false`. Do not apply the direct-route prerequisite
universally. Also trace `/board/session/:id` and `/board/task/:projectId/:id`
callers, access denial and missing-reference recovery.

### Preview and designed boundaries

The [preview guide](../guides/feature-previews.md) and runtime bindings own offered
previews. Exercise off/on, direct entry/refusal, persisted reload, current authority
and retained cancellation/audit where applicable. Catalog membership is not access.

| Consumer owner | Preview families to reconcile |
| --- | --- |
| Chat/Connections/Native | Session goals, interrupted Continue, compaction, durable Station Agent, coordinator picture, CLI reads, conversation resolution and paired chats; distinguish Agent binding/advertisement, UI control and same-home process restart |
| Projects/Collaboration | Task review, Task capabilities, Task collaboration, member passkeys and project-sharing controls; presentation gates do not replace independent membership/incarnation checks |
| Browser/Device | Browser experience/artifacts, Device developer loop and Codex-bound Browser/Device tools |
| Extensions | Plugin recovery inventory, visual skills and chat apps; CLI/API recovery inventory differs from activation recovery UI |
| Knowledge | Local speech, walkthroughs, reviewed learning lifecycle and host-image consumers; host-image binding was enabled by default in the inventory revision |
| Automation | GitHub observations/actions, isolated repairs, workload budget settings and Project supervision; general management UI remains designed where no caller exists |
| Attention/Connections | Attention snooze, reviewed usage tariffs and fleet consumer probes |
| Workspace/Preferences | Device developer tools plus independent flow, readiness, trust, sheet gesture and Station route switches |

Knowledge coordinates source/asset trust consumers; Extensions owns
`integration-content-trust` and `visual-skills`. Experimental read-only S3
sources require their explicit environment opt-in and separate AWS acceptance;
no provisioning is authorized by this campaign. Library and Meeting Notes are
installable examples, not unconditional built-in pages. Meeting Notes compile
needs an Agent; Ask additionally needs an embedder and explicit index.

Do not count instance-shared Boards, Board Review kind, arbitrary Board editor
plugin composition, Board-list reorder or API-only clone/template UI as shipped
user journeys without implementation evidence.

## Journey record and proof

Each implemented journey in the issue needs:

- Stable lane/journey ID, entry point, expected outcome and priority.
- Capability classification, owner, source/guide/manifest references and prerequisites.
- Exact revision/environment and next executable action.
- Create/edit/use/remove where applicable; reload/persistence; cancellation/unsaved
  work; loading/empty/error/retry; denial and cross-surface return.
- Desktop and narrow-phone actions, keyboard/focus, target size and theme checks
  appropriate to the changed behavior.
- Baseline/injected failure/restored result for defects, finding/PR links and limits.

Keep evidence types explicit: source inspection; controlled mounted caller; browser
with intercepted responses; real isolated Station/storage; real engine/provider;
packaged native shell; physical device; observed release. A real local deterministic
model is not a paid/provider-account qualification. A browser Android project is
not an installed Android app. A successful HTTP stream response does not prove
subscription completion. Missing prerequisites are blocked, never passed.
A skipped/empty test, partial worker crash, deferred selector or invalidated
readiness run is not completion evidence.

Use one primary regression at the strongest useful caller boundary. Follow
[test effectiveness](../guides/testing.md#fixture-fidelity-and-test-effectiveness);
observe the intended failure before production repair, preserve state and prove
retry without duplicate effects. Do not replay a fixture's asserted behavior as
proof of a production owner.

## Execution phases and resource leases

1. Inventory the shipped routes, panes, settings, flags and guides in both directions
   against manifest owners. Record omissions and exact next actions in the issue.
2. Bootstrap fresh owners in bounded slices: pinned managed dependencies, exact
   pre-edit gate and existing focused baseline. Release heavyweight capacity for
   lightweight regression authoring and PR drafting.
3. Execute intended regressions under renewed leases, repair concrete defects,
   validate focused behavior/recovery and publish coherent PRs through normal hooks.
4. Rotate at command/repair/PR boundaries while other owners wait. Requeue the
   remaining feature journeys; publication does not complete a lane.
5. After actual landing, exercise the cross-lane journeys against the integrated
   revision, then reconcile remaining external blockers and qualification limits.

At most three heavyweight leases cover installs/builds/tests/app exercise/gates/
hooks. Serialize whole-graph selectors. A lease is permission for useful sequential
work, not a request for approval at each command; release it during idle authoring
or a real blocker. The coordinator reactivates the next concrete action on release.
Do not require machine-wide idleness or interrupt unrelated work.

Use isolated Station homes, instance names, disposable projects and verified port
bands. Reserve backend base through base+3 and keep UI outside it. The issue owns
allocations; user ports 3141 and 3000 are unavailable. Native work follows the
repository's Tauri skill. Do not bypass an approval rejection, alter governance,
skip hooks, inflate timeouts or rerun blindly to green.

For this campaign, the user authorized isolated T3-managed C-drive worktrees;
never use the primary checkout. Preserve recovery data in
`E:/pnpm-store/v11/projects` and the remaining C-drive store entries: no cleanup,
store pruning or traversal through their project links.

Readiness evaluates frozen inputs: complete content/review commits before starting
it. A mutation during the run invalidates the receipt. Diagnose actual failures;
source review cannot turn a failed or incomplete gate green. Hosted required
checks and the merge queue own final integration qualification.

## Cross-workflow acceptance

| ID | Expected user outcome | Joint owners and evidence prerequisites |
| --- | --- | --- |
| INT-01 | Fresh zero-provider Home → Connections → Agent → first Chat → history/reload | Entry, Connections, Chat; distinguish controlled engine from real account |
| INT-02 | UI-create Project/Task → accept/dispatch → Activity waiting/input reply → status/return/reload | Projects, Chat, Attention; verify Session association and no lost/duplicate proposal |
| INT-03 | Registry preview/deny/install → layout/pane → reload → disable/remove/recover | Extensions, Boards, Preferences; current permissions and dynamic catalog |
| INT-04 | File/diff/terminal → Add to chat → PR guide/review → Task return | Workspace, Chat, Projects; integrated terminal revision and disposable repository |
| INT-05 | Browser/Device capture → Task review/comment/resolve → share/revoke | Browser, Knowledge, Projects, Collaboration; distinguish seeded clip from actual capture |
| INT-06 | Dirty draft/save failure → cancelled navigation/retry → reconnect/restart → recover once | Entry, Chat, Projects, Native; exact text/identity/URL preserved |
| INT-07 | Paired/member access → role denial/revoke → stale state/refusal/retry | Collaboration, Connections, Native; synthetic browsers vs separate humans/devices |
| INT-08 | Theme/shortcut/voice/notification choice → consumer → reload/device scope | Preferences and domain owners; actual permission/physical haptic boundaries |
| INT-09 | Automation run → exact output receipt/deep link → Chat/Task follow-up → cancel/history/restart | Automation, Chat, Projects; actual approval/provider where required |
| INT-10 | Native cold/warm/background/tray/update → current project/pane/chat recovery | Native with Entry/Chat; packaged/physical evidence and same-home process identity |

## Completion and handoff

Every implemented journey has appropriate caller/user-action proof and recovery,
persistence and accessibility checks, or an exact external prerequisite with a
next action. No critical finding is left untriaged. Each fix has a reviewable PR,
exact head and evidence limits; integration state comes from GitHub, not this plan.
Required reproduced-defect fixes must land, and cross-workflow acceptance must
pass at the exact integrated revision, except for explicitly recorded external
prerequisites. An open PR or a triaged known defect is not delivered work.
Retain a concrete unexecuted set. Do not declare whole-app completion from test
counts, route screenshots, a clean source scan or merged fixes alone.

The ultimate orchestrator handles live PR review/watch/queue/merge decisions.
Coverage reconciles final integrated journeys and omissions. Existing automation
is a persistence safeguard, not a substitute for release-driven progress; do not
create duplicate schedules.
