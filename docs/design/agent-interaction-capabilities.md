# Agent browser and computer access

Status: Proposal — unscheduled; no tracking issue as of 2026-10-20.
The common capability layer below is not implemented.

## User experience

Agents expose **Browser access** and **Computer access** in the same place across
engines. A user enables the capability and chooses a target when needed. Station
handles tool attachment, engine configuration and model-specific action formats.
These are Agent settings, not another collection for users to install or manage.

| Capability | Default target | Visible status |
| --- | --- | --- |
| Browser access | The Project browser and the caller's profile | Ready, needs setup, or unavailable |
| Computer access | An explicitly selected computer and display | Off until a target is authorized |

The normal view shows the target, whether access is ready, and a way to watch or
take control. Backend selection belongs in optional connection details. Enabling
access must not imply that a Project member may run the Agent or control the
operator's computer.

## Current implementation

- The [Agent editor](../../src-ui/src/views/agent-editor/AgentEditorToolsTab.tsx)
  records `tools.browser`. The
  [session resolver](../../src-server/services/orchestration/session-agent-resolution.ts)
  carries it as `browserTools`.
- The [Claude adapter](../../src-server/providers/adapters/claude-adapter.ts)
  delivers Station's browser server in process. This drives the Project's Station
  browser; it does not select a separate Claude-owned browser.
- [Browser authority and control](../guides/browser-workspace.md) already bind
  access to a principal, Project, profile and live session. JavaScript has a
  separate default-off permission; a person can preempt Agent control.
- [Device sessions](../../src-server/services/devices/device-session-service.ts)
  expose local `device_*` tools to bound, verified Sessions through the shared
  lease and per-device shares. Human takeover fences input. Automatic pane
  reveal, remote-host Agent tools and weaker-custody engine credentials remain
  outside this slice; see the [Device guide](../guides/mobile-device-workspace.md).
  This does not implement a general desktop computer-use backend.
- Codex and managed Station do not gain browser or computer support from the
  editor setting alone. Their delivery paths still need implementation and
  qualification.

## Backend resolution

Resolve against the selected engine, model, execution computer, target and current
permissions before starting a run. Preserve the chosen browser profile or display
when changing engines.

Prefer native engine support when it can honor the same target, permission,
approval, observation and takeover contract. Otherwise use a Station-managed
backend where supported: for example, an MCP browser bridge, or a packaged
computer driver with an engine-specific screenshot/action adapter. Some models
need a provider-specific computer-use loop rather than ordinary function tools.
An MCP connection alone does not establish support.

If no backend meets the contract, show setup or unavailable state. Do not silently
switch to a different signed-in browser, computer, or display. Do not replay a
click, form submission or keystroke on another backend after an uncertain result.
Explicit backend preferences may live in advanced connection details; automatic
selection should be the normal experience.

## Permission and lifecycle contract

- Separate observing a target from interacting with it. Screenshots and page reads
  can expose signed-in accounts, so they do not inherit unconditional read grants.
- Bind each run to its principal, Project, execution host and target generation.
  Project membership and source installation do not authorize desktop access.
- For computer access, the operator authorizes a concrete host/display or isolated
  desktop and any OS permissions. Project policy can narrow that grant.
- Keep human takeover, stop, approval and revocation visible. Report engine limits
  when interruption cannot stop an already-sent effect.
- Engine changes must recheck the contract. A more permissive backend must not
  silently replace one that required approval or used an isolated profile.

## Implementation and acceptance

Start with browser access over one Station-owned profile across Claude, Codex and
managed Station; then qualify native alternatives against the same contract.
Explore computer access separately over an explicitly authorized target, reusing
the live-surface control owner where it fits.

For each engine/backend pair, verify real execution and its evidence: enable,
save/reopen, observe, interact, approve/deny, human takeover, cancellation,
revocation, restart and unavailable prerequisites. Switch engines and prove that
the target/profile and permissions remain consistent. For computer access, also
test display selection, OS permission refusal and removal, and isolation from
other Projects. Until those pass, UI availability is not runtime qualification.
