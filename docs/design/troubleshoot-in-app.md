# Design: troubleshoot with an agent

> **Reading status: current in-app troubleshooting contract (#4470, Phase 1).**
> The [prepare route](../../src-server/routes/system/diagnostics.ts),
> [troubleshoot service](../../src-server/services/infra/troubleshoot-service.ts),
> [shared context rules](../../packages/shared/src/triage-context.ts),
> [playbook](../../packages/shared/src/troubleshoot-playbook.md),
> [station-control tools](../../src-server/tools/station-control-troubleshoot-tools.ts)
> and [start flow](../../src-ui/src/components/troubleshoot/useStartTroubleshoot.ts)
> own this path. The CLI half is [bounded guided triage](cli-triage.md).
> Phase 2 (entry points where errors appear) and Phase 3 (an interactive CLI)
> are planned in #4470 and not built.

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
the deferred overlays chunk, runs the start flow.

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
`{ surface?, seed?: { route?, errorSummary? } }` (strict, at most 16 KiB).
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
  or an error summary over 2,000 characters is refused with 400 and a closed
  `code` (`route-too-long`, `route-not-in-app`, `error-summary-too-long`)
  plus both limits. Nothing is truncated. The route keeps only its path; the query and fragment are dropped.
- **Run.** The service writes `context.json`, `playbook.md` and `seed.md` to a
  new `<Station home>/cache/triage/<uuid>` with the same owner-only rules as
  `station triage` (directory `0700`, files `0600`, no symlinked cache
  leaves). It uses the serving Station's home rather than the shared
  `$STATION_ROOT` that `station triage` writes to, so a run belongs to the
  Station that prepared it and an isolated instance keeps its runs to itself. The context records the Station name, environment id, version,
  channel, stamped source revision, platform, the doctor summary, server-log
  availability, the caller's role and surface, and the seed.
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
and validator from there, so its behavior did not change.

Persisted context passes through `redactDeep`. Text that may leave the machine
in an issue passes through `redactTroubleshootReportText`, which removes known
credential shapes, 43-character Station credentials, non-public URLs (only
`https://github.com/` and `https://kontourai.github.io/` are kept) and home
directories (shown as `~`). Redaction is pattern-based; the person reviews the
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
- Start flow, agent selection and fallback:
  `src-ui/src/components/troubleshoot/__tests__/TroubleshootHost.test.tsx`.

These tests do not prove how a given engine follows the playbook.
