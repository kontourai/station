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
- **Decided, not implemented:** the cross-engine bound channel. Its decision
  is that Codex URL-token and ACP header-token passthrough stay
  `caller-not-bound` until a provider can supply independent proof, and the
  four-step design below is the required shape. No engine supplies that proof
  today, so no external-engine Session receives browser authority. #122 owns
  the implementation; the remaining slices are listed at the end.

It builds on frozen
[ADR 0019](../adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md),
whose historical text remains unchanged. The [Browser guide](../guides/browser-workspace.md)
owns the current inventory.

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
Codex receives a URL token in spawn argv; ACP receives an HTTP-header token in
its session payload. Token records identify their minting Session, but possession
does not prove the presenting connection belongs to it. Echoing a Session ID,
MCP transport session ID, nonce or second bearer obtained with the first token
adds no independent evidence. Neither does moving the same capability from a
URL to a header. Preserve `caller-not-bound` for both channels.

A safe implementation must use the existing passthrough token only to locate
and authenticate a pending binding; it must obtain independent, non-replayable
proof from a Station-owned provider connection before issuing browser authority:

1. Station creates a single-use pending binding containing Session, provider
   instance and execution generation, owner, canonical Project, tool audience,
   expiry and a fresh challenge. No identity comes from request arguments.
2. A provider transport that can prove an individual Session's tool invocation
   answers the challenge on a private Station-owned channel, bound to the exact
   pending MCP connection. The proof binds the challenge, connection, audience,
   generation and invocation. It must not be a secret distributed in argv or an
   ACP payload. Reject a provider unable to supply this independent proof.
3. Only that connection receives an opaque server-side binding handle. Every
   call rechecks live Session/generation, current owner/Project standing, binding
   currency and tool audience, then mints the ordinary BrowserAgentAuthority.
   The handle alone cannot reconnect or resurrect a binding. Disconnect, stop,
   failed start, restart, provider change, membership revocation and token
   expiry revoke it. Resumption needs a new proof.
4. The built-in server's authenticity and sensitive-tool approval must be
   established independently of its name. Keep #3422's approval scope and
   authenticity checks; do not extend an in-process Session grant to an external
   connection merely because it uses the same server name.

Current Codex/ACP HTTP MCP passthrough does not supply step 2. This PR therefore
does not claim a safe implemented bound channel. A future transport capability
or a separately reviewed delegated-authority policy is required. The latter
would change the security model and must not silently relabel `delegated-custody`
as `bound`.

## Remaining slices and acceptance

- **Bound connection:** qualify actual Codex and ACP protocol support for step 2;
  implement pending-binding ownership, challenge/proof admission, replay and
  audience rejection, revocation and reconnect lifecycle. Exercise swapped
  Sessions, stolen passthrough tokens, forged identities, stale generations,
  disconnect, concurrent calls and revoked memberships through the real route.
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
