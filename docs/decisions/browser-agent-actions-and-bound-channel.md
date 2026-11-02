---
status: current
subject: Browser Agent actions and cross-engine binding
decided: 2026-10-17
evidence:
  - kind: adr
    ref: docs/adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md
  - kind: pr
    ref: https://github.com/kontourai/station/pull/3779
  - kind: issue
    ref: https://github.com/kontourai/station/issues/3530
  - kind: doc
    ref: docs/guides/browser-workspace.md
---

# Browser Agent actions and cross-engine binding

This record holds two things with different status:

- **Current and shipped:** the authority constraints for Browser Agent actions
  below, and the leased hover, pointer, select and color-scheme actions
  (#3779).
- **Preview:** Codex dynamic tools use its Session's Station-owned app-server
  stream. The `codex-bound-browser-device-tools` Feature Preview is off by
  default. ACP passthrough remains `caller-not-bound`.

It builds on frozen
[ADR 0019](../adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md),
whose historical text remains unchanged. The [Browser guide](../guides/browser-workspace.md)
owns the current inventory.

The workspace tab workflow preserves exact server session identity. Popup
adoption creates a separate session in the opener's profile and continues the
original request; selecting a tab does not retarget an Agent's tools. Title and
navigation observations confer no authority. The twelve-session profile bound
includes live and opening sessions. Tab/popup fixture coverage does not establish
a real-browser or external-provider journey.

## Threat model and decision

A logged-in website may hold credentials and private data. A page, another
Agent Session, an MCP-name impostor or a process holding a leaked external-engine
bearer must not acquire a Session's browser authority. Human takeover must stop
new Agent steps. This boundary does not isolate a fully compromised host operator
or arbitrary code running as the Station OS user.

Keep the verified Session owner, canonical Project, active operator/admin
standing and exact profile grant as the authority chain. A browser session ID,
locator, ref or cursor is a selector, never authority. Reads remain scoped to
the authorized profile; “read any tab” cannot mean crossing another principal's
profile. Existing drive policy is profile-scoped, not limited to tabs an Agent
opened. Close retains the stricter opened-by-Agent and same-conversation checks.
Changing those policies is separate work, not implied by parity tools.

Hover, pointer drag, native select and color-scheme emulation go through
`BrowserAutomation.withLive` and `withControl`. All changing CDP steps use the
captured fence; pointer steps use the registry's fenced input chain, including
held-button cancellation. No public CDP port or widened method allowlist is
needed. Select uses Station-owned code in an isolated world, with native
prototype getters/setters; it does not enable arbitrary evaluation. Values are
not included in action history. Select is hit-tested and uses `:disabled` to
include inherited fieldset disability. Human claims expire existing snapshot
refs. The listener is attached before reading; a human hold at any time during
the snapshot, including at its start, makes the result's refs unusable. Reads
without a bound lease also produce no usable refs.

Color-scheme requests are recorded when sent, even if the call is interrupted
or fails; this is an audit of the request, not proof of its outcome. Emulation
is target-local and survives navigation. The live-surface binder sends a reset
to system on every human control claim and logs reset failures. A human does
not intentionally inherit an Agent's override.

## Why passthrough tokens cannot simply become bound

The current owners are
[`station-control-mcp-token.ts`](../../src-server/runtime/mcp/station-control-mcp-token.ts),
[`station-control-mcp-route.ts`](../../src-server/routes/mcp/station-control-mcp-route.ts),
[`codex-mcp-passthrough.ts`](../../src-server/providers/adapters/codex-mcp-passthrough.ts)
and [`acp-mcp-passthrough.ts`](../../src-server/providers/adapters/acp-mcp-passthrough.ts).
Codex receives an HTTP-header token in private thread JSON-RPC configuration;
ACP receives one in its session payload. Neither credential is bound. Token records identify their minting Session, but possession
does not prove the presenting connection belongs to it. Echoing a Session ID,
MCP transport session ID, nonce or second bearer obtained with the first token
adds no independent evidence. Neither does moving the same capability from a
URL to a header. Preserve `caller-not-bound` for both channels.

## Bound channel and feasibility

| Engine | Channel | Qualification |
| --- | --- | --- |
| Claude | In-process SDK MCP | Existing bound path; its approval and lease policies remain in force. |
| Codex CLI 0.164.0 on macOS | Dynamic tools on the Session's app-server pipe | Preview. Station registers its own browser and device catalog, checks the emitting Session, native thread, active turn, name and call ID, and executes the existing registrations in process. On 2026-11-02 an isolated Station Session returned `ok: true` from `browser_status`, opened a local page in a live browser session, and returned `ok: true` from `device_list` (one host, no devices); the turn completed. This is one provider/host journey, not a physical-device qualification. |
| OpenCode 2.1.1 over ACP on macOS | Provider-launched stdio MCP | Unavailable. An extra pipe did not deliver its marker to the MCP child. A socket in a 0700 directory accepted a connection and `LOCAL_PEERPID` identified that shim, but OpenCode spawned it; Station had no independently established identity for the exact child. A path, same-user ACL and self-reported PID do not supply that identity. Node's socket API here exposes no peer-PID method. |
| Other ACP agents | Agent-dependent MCP | NOT_VERIFIED; unavailable without equivalent independent binding. |

Codex's private provider stream supplies the Session connection identity; a
tool name or request argument alone does not. Station uses a separate
in-process credential purpose and attaches proof to the exact Request object
dispatched to its own app. The bounded-body middleware transfers that proof to
its own replacement Request and consumes the original. A socket request or
independently cloned Request carrying copied headers has no proof. Only browser and device agent routes are in that
audience. The existing caller, owner, recorded Project, operator/admin,
per-tool approval, device shares, browser evaluation and lease checks remain
in force. A consumed call ID cannot be replayed within its turn; older turns are rejected.
Coordinator-derived station-control entries do not grant Codex device tools.
An expired in-process credential requires restarting the Session. If an effect
has run but its result cannot be safely returned, the response says it executed
and its result was withheld. Cancellation, process exit,
stop and replacement close the binding and pending approvals. Preview
withdrawal invalidates authority, including while an approval is pending; a
later re-enable requires a fresh Session. An
effect already dispatched cannot be undone by cancellation.

Codex 0.164.0 exposes dynamic registration on `thread/start`, but its
`thread/resume` schema has no registration update. On resume Station rebuilds
the current catalog as an allowlist and refuses persisted names outside it.
Tools added since the thread started become available on a new thread. A
persisted name is never authority by itself. Earlier Windows probes of Codex
0.166.0 observed calls after resume even with experimental API disabled, so
omitting registration or disabling the preview alone cannot be the guard.

The same-user copied-header test protects this narrow invocation boundary; it
does not claim isolation from arbitrary code that can compromise the Station
process or its operator. ACP remains unavailable until both the provider-facing
connection and the Station-owned child identity can be independently proved.

## Remaining slices and acceptance

- **Bound connection:** complete real-provider and adversarial qualification;
  keep ACP unavailable until a private, independently identified path exists.
- **Upload (#3530):** deny Agent file upload today. Future inputs must be
  authorized workspace/artifact handles from the Agent's recorded environment,
  never arbitrary host absolute paths. Resolve authority and canonical file
  identity at intake, refuse symlinks/escapes and non-regular files, bound count,
  bytes and lifetime, stage immutable bytes on the Browser host, and bind the
  chooser/input to profile, browser generation and current lease. Audit actor,
  admitted artifact identity and byte count without logging file contents or
  private host paths. Remote Agent paths are not paths on the Browser host.
  Test file replacement, stale chooser handles, takeover during staging and
  deletion on completion/failure. Human transfer admission remains separate.
- **Dialogs:** keep current human-held refusal and Agent/no-holder automatic
  handling. Explicit Agent accept/dismiss requires a bounded pending dialog
  tied to initiating actor, generation and lease; it must not answer OS/passkey
  prompts (#3531), steal a human dialog or deadlock the action serial slot.
  Test takeover, timeout, superseded dialogs and prompt-text redaction.
- **Recording:** consume authorized existing frames without taking over the
  screencast producer. Specify maximum duration, dimensions, bytes and concurrent
  recordings; reject over-limit starts, stop and clean up at runtime limits,
  bind output artifact access to profile/owner, and reject stale stop handles.
  Qualify encoder availability and failure cleanup; no video is produced here.
- **Environment port:** resolve a typed environment-port target through the
  recorded execution environment and existing local-target/egress authorities.
  Reject unregistered private targets and Station listeners; do not turn a port
  number into permission or assume the Agent and Browser hosts are identical.
- **Remaining parity:** frame-aware aria refs, viewport orientation, pending
  chooser status and explicit owner policy need their own acceptance journeys.
  Native CEF work (#3527) must preserve the same session/profile/generation and
  streamed viewers; this slice changes no native host or website permissions.

The tests use the real lease/session owners with scripted CDP for refusal and
interruption, plus installed Chromium for DOM effects and matchMedia. Those
receipts do not establish external-engine, native, mobile, packaged or released
behavior. Screenshot evidence demonstrates the exercised fixture only.
