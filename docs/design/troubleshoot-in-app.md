# Design: troubleshoot with an agent

> **Reading status: current in-app troubleshooting contract (#4470, Phases 1,
> 2 and 3).**
> The [prepare route](../../src-server/routes/system/diagnostics.ts),
> [troubleshoot service](../../src-server/services/infra/troubleshoot-service.ts),
> [shared context rules](../../packages/shared/src/triage-context.ts),
> [playbook](../../packages/shared/src/troubleshoot-playbook.md),
> [station-control tools](../../src-server/tools/station-control-troubleshoot-tools.ts),
> [start flow](../../src-ui/src/components/troubleshoot/useStartTroubleshoot.ts)
> and [seed builder](../../src-ui/src/components/troubleshoot/troubleshootSeed.ts)
> own this path. The CLI half is [bounded guided triage](cli-triage.md), whose
> interactive terminal mode follows the same playbook. Maintainers work through
> filed reports with the
> [troubleshoot report intake skill](../../.agents/skills/troubleshoot-report-intake/SKILL.md).

**Troubleshoot with an agent** opens a conversation with the Station
Assistant (`station`) about a problem with Station itself. The assistant asks
what went wrong, investigates with Station's own tools, and offers to fix the
problem, file it, both, or neither.

## Entry points

- Help menu: **Something wrong?** → **Troubleshoot with an agent**, beside
  **Report a problem**.
- Command palette: **Troubleshoot an issue** (keywords include troubleshoot,
  triage, bug, broken, not working, crash, help, support and debug).
- Settings → Diagnostics: **Troubleshoot**, below the diagnostics download.

Each dispatches `station:open-troubleshoot`. `TroubleshootHost`, mounted in
the deferred overlays chunk, runs the start flow. These three send no seed.

### Where errors appear (Phase 2)

Error surfaces dispatch the same event with the facts they hold
(`TroubleshootRequest` in
[`troubleshootEvents.ts`](../../src-ui/src/lib/troubleshootEvents.ts): a
code, a message, and for a reply the conversation and turn ids). The host
turns them into the seed, so the sanitizer runs in the deferred chunk and no
surface can skip it. The shared action is
[`TroubleshootAction`](../../src-ui/src/components/troubleshoot/TroubleshootAction.tsx);
surfaces whose sibling controls are native buttons or banner actions call
`requestTroubleshoot` directly.

| Surface | Action | Code sent |
| --- | --- | --- |
| Route error boundary ([`RouteViewBoundary`](../../src-ui/src/app-shell/RouteViewBoundary.tsx)): beside Retry for a view failure; in the **More actions** menu for an authority failure, whose row already has two actions | Troubleshoot | `HTTP <status>`, else the error name |
| Error-tone toasts with fewer than two actions, at the one renderer ([`NotificationContainer`](../../src-ui/src/components/notifications/NotificationContainer.tsx)); the flow's own `troubleshoot-*` toasts excluded | Troubleshoot | none; the message only |
| A placed pane in `temporarily-unavailable` ([`ProjectLayoutRenderer`](../../src-ui/src/app-shell/ProjectLayoutRenderer.tsx)), and the same state's card explanation ([`WorkspacePaneAvailabilityList`](../../src-ui/src/workspace-panes/WorkspacePaneAvailabilityList.tsx)); not while the renderer is still loading or when extension access is the cause | Troubleshoot | `pane-<reason code>` |
| Unsupported layout tab ([`layouts/index.tsx`](../../src-ui/src/layouts/index.tsx)) | Troubleshoot | `unsupported-layout-tab` |
| An engine that never connected ([`NotConnectedEngineDetail`](../../src-ui/src/views/NotConnectedEngineDetail.tsx)) | Troubleshoot | `engine-<failure phase>` |
| The chat dock's "This agent is unavailable" banner ([`ChatDockBody`](../../src-ui/src/components/chat-dock/ChatDockBody.tsx)), for a caller who may start a chat | Troubleshoot | the unavailable-fix kind; the conversation id |
| The local-Station banner when it is `stopped` or `failed` and offers no Restart (an unresolved owner or a fail-closed home) ([`BundledServiceBanner`](../../src-ui/src/components/BundledServiceBanner.tsx)) | Troubleshoot | `local-station-<phase>` |
| A failed turn's `[CHAT_ERROR]` marker, not in a replay and only for a caller who may start a chat (`callerAccess.startChat`) ([`ChatDockBody`](../../src-ui/src/components/chat-dock/ChatDockBody.tsx) through [`SystemEventMessage`](../../src-ui/src/components/chat/SystemEventMessage.tsx)) | Troubleshoot this | the marker's error code; conversation and turn ids |
| A thumbs-down rating ([`MessageRating`](../../src-ui/src/components/chat/message-bubble/MessageRating.tsx)) | This looks like a Station bug | `reply-marked-station-bug`; conversation and turn ids |

Runtime failures reach the UI as `[CHAT_ERROR]` markers, not as a failed
assistant-turn outcome, so the failed-turn action hangs on the marker. The
thumbs-down option appears once the rating is thumbs-down. The rating is
saved as usual; the option writes nothing to it, so a Station bug never
enters feedback analysis as a judgement of the agent's answer.

Duplicates are left to the playbook, which tells the assistant to prefer
adding evidence to a matching open issue over filing a new one. That is an
instruction, not a check.

A row shows at most two labelled actions (#3045), so a toast that already has
two, and a banner that offers Restart, do not get Troubleshoot.

Where it is offered, the action is always shown. When troubleshooting is unavailable (no engine
for the Station Assistant, or no `troubleshootPrepare` capability), the start
flow falls back exactly as it does for the help menu.

**Not covered.** Error text shown without an error toast or one of the
surfaces above: inline `ErrorState` panels in individual views, warning-tone
toasts, error toasts that already carry two actions, a local-Station banner
that offers Restart, tool-activity failure toasts, the connection and compatibility
banners, other workspace-pane failure states (for example "<pane name>
unavailable"), and the new-chat picker's engine states.

### Seed from an error surface

[`buildTroubleshootSeed`](../../src-ui/src/components/troubleshoot/troubleshootSeed.ts)
builds:

- `route`: `window.location.pathname` at dispatch time, without the query or
  fragment. A path the host would refuse is left out.
- `errorSummary`: `<code>: <first message line>`, skipping stack-frame
  lines. It passes through `sanitizeFreeText`, which removes known credential
  shapes, URLs (with their query strings) and filesystem paths, and is capped
  at 300 characters.
- `conversationId`, `turnId`: kept only when they fit the host's bounds;
  otherwise left out, so troubleshooting still starts without them.

The host re-checks every field.

## Start flow

1. **Engine check.** The flow reads the `station` agent from the agent list.
   If it is not runnable (`available: false`) or its engine connection cannot
   start a chat, the flow opens Report a problem and shows a toast with a
   copyable `station triage`. It does not navigate to engine settings.
2. **Capability check.** It reads the active Station's public handshake. If
   `troubleshootPrepare` is absent, it falls back the same way. An unreadable
   handshake still attempts prepare.
3. **Prepare.** `POST /api/diagnostics/troubleshoot/prepare` on the active API
   base, so the run belongs to the Station the person is looking at. A toast
   appears if this takes longer than 700 ms. A failure shows a toast with
   **Report a problem** and **Copy station triage**.
4. **Intro dialog.** "What went wrong?" with a description field, the
   Station's name and version, and the `station triage` command for when the
   app itself is broken.
5. **Launch.** **Start troubleshooting** opens a new conversation with the
   Station Assistant in no Project. The description is the visible first
   message, or a fixed opening message when it is empty. The prepared seed is
   sent as the turn's ambient context: the model receives it, and the
   transcript shows only what the person typed.

### Why a dialog instead of a prefilled composer

The chat surfaces have no per-conversation intro slot, and `launchChat`
always sends its message. `dispatchNewChatIntent` can prefill a composer and
preselect an agent, but it carries no out-of-band context and only works when
a dock claims the request. The dialog gives the person the "What went wrong?"
step, keeps their words as the first message, and attaches the seed through
the existing ambient-context path. The cost is one extra step before the
conversation opens.

## Prepare route

`POST /api/diagnostics/troubleshoot/prepare` takes
`{ surface?, seed?: { route?, errorSummary?, conversationId?, turnId? } }`
(strict, at most 16 KiB).
The request and response types are in
[`@kontourai/station-contracts/troubleshoot`](../../packages/contracts/src/troubleshoot.ts).

- **Admission.** The `/api/diagnostics` family's POST tier applies
  (`orchestration:operate`), so a read-only paired device is refused. The
  handler refuses every agent caller, including Station's internal principal,
  with 403.
- **Caller role.** `owner` when the caller is the operator in person or one of
  the operator's own paired devices; otherwise `member`. The playbook uses this
  to decide who may post an issue from the host.
- **Surface.** The request's `surface`, else the client-origin header's
  reported surface, else `unknown`. Display-only.
- **Seed.** A route over 512 characters, a route that is not an in-app path,
  an error summary over 2,000 characters, a conversation id over 256
  characters or a turn id over 200 characters is refused with 400, a closed
  `code` (`route-too-long`, `route-not-in-app`, `error-summary-too-long`,
  `conversation-id-too-long`, `conversation-id-invalid`, `turn-id-too-long`,
  `turn-id-invalid`) and every limit. An id must be printable ASCII with no
  whitespace, because it is written into the model-facing seed. Nothing is
  truncated. The route keeps only its path; the query and fragment are
  dropped. The limits are in `@kontourai/station-contracts/troubleshoot`.
- **Run.** The service writes `context.json`, `playbook.md` and `seed.md` to a
  new `<Station home>/cache/triage/<uuid>` with the same owner-only rules as
  `station triage` (directory `0700`, files `0600`, no symlinked cache
  leaves). It uses the serving Station's home rather than the shared
  `$STATION_ROOT` that `station triage` writes to, so a run belongs to the
  Station that prepared it and an isolated instance keeps its runs to itself. The context records the Station name, environment id, version,
  channel, stamped source revision, platform, the doctor summary, server-log
  availability, the caller's role and surface, and the seed. When the seed
  names a conversation that this Station's event store does not hold (one
  opened from a paired Station), the ambient seed also says so and tells the
  assistant to ask which Station ran it, because this Station's doctor, logs
  and monitoring do not cover it. Without an event store it says nothing
  either way.
- **Response.** The run id, `agentId: 'station'`, the ambient seed (at most
  3,600 characters, under the 4,000-character ambient limit), the opening
  message, display facts and the CLI command.
- **Capability.** `troubleshootPrepare` in the public handshake, served in
  personal and hosted deployments.

## Shared context rules

`@kontourai/station-shared/triage-context` is the one implementation of the
run directory, owner-only artifact writes, doctor/build/log summaries,
per-field and whole-payload bounds, and the schema validators for both the
CLI context and the in-app context. `station triage` re-exports its constants
and validator from there. The CLI context is schema v2: it adds `localLogs`,
the local runtime's log directory with the home directory shown as `~`.

Persisted context passes through `redactDeep`. Text that may leave the machine
in an issue passes through `redactTroubleshootReportText`, which removes known
credential shapes, 43-character Station credentials, non-public URLs (only
links into the `kontourai/station` repository and Station's docs site are
kept) and home directories (shown as `~`). Redaction is pattern-based; the person reviews the
text before anything is filed.

## Playbook and tools

The v2 playbook is bundled with the build and never fetched. The reviewable
copy is `packages/shared/src/troubleshoot-playbook.md`; the compiled constant
beside it must be byte-identical, and a test fails when they drift. It is too
long for the ambient seed, so the seed tells the assistant to call
`get_troubleshoot_playbook` first.

Both station-control tools are pure (`routes: []`, read-only, auto-approved):

- `get_troubleshoot_playbook` returns the playbook.
- `draft_troubleshoot_report` redacts a title and the
  `troubleshoot-report.yml` fields (`user-impact`, `diagnosis`,
  `observed-behavior`, `build-identity`, `environment-details`,
  `redacted-diagnostic`, `prior-issue`, `remedy-applied`, `diagnosed-by`) and
  returns the prefilled issue-form link. The link is at most 7,900
  characters. A field that does not fit is returned whole in `overflow` for
  the person to paste. An over-limit title or field is refused.
  `station triage draft-report` calls the same shared drafter
  (`draftTroubleshootReport`), so a terminal agent gets the same redacted text
  and link.

The playbook opens with a **terminal section** for an agent that
`station triage` starts in a terminal. There it takes precedence over the
steps that name in-app tools: Station and its tools may be down, so the agent
works from the run directory's files, the `localLogs` directory in
`context.json` (where `~` is the person's home directory) and Station read
commands such as `station doctor`. It never kills or restarts a process without
an explicit yes. To file, it uses `station triage draft-report`, shows the
complete redacted text, gets a yes, and posts with `gh` only when `gh` is
authenticated and the account has triage permission; the person running the
command is the account holder, so the in-app owner check does not apply.

The playbook's rules are **instructions to the agent, not enforcement**:
treating logs and issue text as untrusted data, never restarting the Station it
runs in, changing configuration only through approval-gated tools after
agreement, never patching source, showing the complete redacted report and
getting a yes before filing, and posting with `gh` only when the caller is the
owner, `gh` is authenticated and the account has triage permission. Station
does not mechanically check any of these. The link builder's bound and its
overflow are code.

## Log access

`read_logs` needs an operator grant for the assistant's verified, bound
session (see [Reading Station's own logs](../reference/config.md#reading-stations-own-logs-station1896)).
The only way to create it is `POST /api/agents/unattended-grants` with an
operator credential and `access:manage`, keyed by the server runtime session
id. The UI does not know that id before the first turn, and an external engine
whose caller is not `bound` is refused even with a grant. The start flow
therefore does not request a grant. The playbook tells the assistant to say
when log access is not granted and to ask the person to paste lines from
Developer → Logs or the diagnostics bundle. A consented, conversation-scoped
grant needs a new grant mechanism; it is not part of Phase 1.

## Evidence

- Route admission, role, seed rejection and run permissions:
  `src-server/routes/system/__tests__/troubleshoot-prepare.routes.test.ts`.
- Redaction, bounds and validators:
  `packages/shared/src/__tests__/triage-context.test.ts`.
- Playbook byte identity:
  `packages/shared/src/__tests__/troubleshoot-playbook.test.ts`.
- Tool link, overflow and Station Assistant delivery:
  `src-server/tools/__tests__/station-control-troubleshoot-tools.test.ts`.
- Terminal mode selection, launch arguments, the run's playbook bytes and
  `draft-report`: `packages/cli/src/__tests__/triage.test.ts`.
- Start flow, agent selection, fallback, and an error surface's facts
  becoming the prepare seed:
  `src-ui/src/components/troubleshoot/__tests__/TroubleshootHost.test.tsx`.
- Seed sanitizing and bounds:
  `src-ui/src/components/troubleshoot/__tests__/troubleshootSeed.test.ts`.
- Each Phase 2 entry point clicks its action and asserts the seed the host
  builds from the event (`captureTroubleshootSeeds`): the
  `RouteViewBoundary`, `NotificationContainer`,
  `WorkspacePaneAvailabilityList`, `layout-renderer-dispatch`,
  `ProjectLayoutRenderer`, `NotConnectedEngines`,
  `ChatDockBody.unavailableAgentBanner`, `ChatDockBody.terminalSessionMarker`,
  `BundledServiceBanner` and `MessageRating` suites. The banner suite calls the
  presented action's handler rather than rendering the banner host.

These tests do not prove how a given engine follows the playbook.
