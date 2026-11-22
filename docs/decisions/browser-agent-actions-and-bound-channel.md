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
  - kind: issue
    ref: https://github.com/kontourai/station/issues/2376
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
  default. With it on, the stream also carries Station Control
  ([below](#station-control-on-the-codex-bound-channel)). ACP passthrough
  remains `caller-not-bound`.

It builds on frozen
[ADR 0019](../adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md),
whose historical text remains unchanged. The [Browser guide](../guides/browser-workspace.md)
owns the current inventory.

The workspace tab workflow preserves exact server session identity. Popup
adoption creates a separate session in the opener's profile and continues the
original request; selecting a tab does not retarget an Agent's tools. Title and
navigation observations confer no authority. The twelve-session profile bound
includes live and opening sessions. Tab/popup fixture coverage does not establish
a real-browser or external-provider journey; the real-host suite's
popup-admission case covers only the host's adoption of a popup.

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

### Agent evaluation on a blank tab

Chrome for Testing 158 aborts the whole browser, and so every tab in the
pane, when script on an `about:blank` page with no site adds a
`sandbox="allow-scripts"` `srcdoc` frame while sandboxed frames get their own
process (`site_instance_impl.cc` CHECK `has_site_`). Chrome 157 does not. A
new tab and a tab sent to `about:blank` through the address bar or
`browser_navigate` are such pages. They run no page script, so only an Agent's
`browser_evaluate` can trigger the abort there. An `about:blank` that a page
opened (`window.open('')`) or navigated to itself inherits that page's site;
on 158 the same frame loads there without an abort.

`browser_evaluate` first asks the page whether its address is an `about:`
page (`location.protocol`, which covers `about:blank#x` and `about:blank?x`,
both site-less and both aborting 158 when a browser-initiated navigation
reaches them), then decides the origin half from the origin the browser itself
reports for that script context in `Runtime.executionContextCreated`, which a
page cannot alter, where the page's own `self.origin` it can. On 158 that
event reports `://` for a new tab, for `about:blank#x`, and for a `data:`
page, and the real origin (`http://127.0.0.1:<port>`) for an http page, for a
page that navigated itself to `about:blank`, and for `window.open('about:blank')`
from an http page. It refuses with `browser-refused` unless the address is not
`about:` or the reported origin has a scheme and host; an unanswered check, a
missing report and an unrecognised origin refuse. The check also refuses
opaque-origin blank pages that did not
abort on 158, such as the blank page Station leaves after refusing a page's
own `blob:` navigation. It applies on every Chrome version, 157 included:
a version gate would be one more thing to get wrong, and the pinned browser
is 158. The cost is real for one use: with `data:` and `blob:` already
blocked, writing throwaway HTML into a blank tab was the only way to show
generated HTML in the pane, and it is now refused. The refusal tells the
Agent to open a real page first, or to show generated HTML with
`html_preview` or `html_render`.

The check and the Agent's script are two CDP calls, and a person's
navigation does not wait for an Agent's call: the address bar, Back, Forward
and Reload act at once. On 158, an address-bar navigation to `about:blank`
sent 0 to 11 ms after the Agent's call aborted the browser in 6 of 6 runs,
and a Forward onto a browser-made `about:blank` entry aborted it too. Both
calls are therefore bound to one page-world script context, named by the
`uniqueContextId` the host records from `Runtime.executionContextCreated`.
A navigation that replaces the document destroys that context, so a script
sent after it fails ("uniqueContextId not found") and the tool answers that
the page navigated before the script ran, instead of running it in the new
document. The check runs in that page world rather than Station's isolated
world, because only the page world can be bound this way. The
refusal cannot be talked away from inside the page: the address is the
document's own `location`, the origin is the browser's report for the same
context the script is bound to, and a site-less blank page has run no page
script and is reachable from no other document. On 158,
300 rounds each of an Agent's trigger racing an address-bar navigation to
`about:blank` (either order), a Back and a Forward onto such an entry ended
with no abort; with the binding removed, the Forward race aborted again
(Back did not abort in 150 unbound rounds). Reload was not raced: it reloads
the same address, so it cannot turn a page with a site into a site-less one.

Station does not turn off `IsolateSandboxedIframes`, which would remove the
process boundary around sandboxed content, and does not change the blank
start page a person sees.

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
Coordinator-derived station-control entries never grant Codex device tools. This
is stricter than Claude's generation-checked coordinator-control path.
An expired in-process credential requires restarting the Session. If an effect
has run but its result cannot be safely returned, the response says it executed
and its result was withheld. Cancellation, process exit,
stop and replacement close the binding and pending approvals. Preview
withdrawal invalidates authority, including while an approval is pending; a
later re-enable requires a fresh Session. An
effect already dispatched cannot be undone by cancellation.

Codex 0.164.0 exposes dynamic registration on `thread/start`, but its
`thread/resume` schema has no registration update. Codex 0.167.0's schema is the
same, and `thread/fork` takes none either. On resume Station rebuilds
the current catalog as an allowlist and refuses persisted names outside it.
Tools added since the thread started become available on a new thread. A
persisted name is never authority by itself. Earlier Windows probes of Codex
0.166.0 observed calls after resume even with experimental API disabled, so
omitting registration or disabling the preview alone cannot be the guard.

The same-user copied-header test protects this narrow invocation boundary; it
does not claim isolation from arbitrary code that can compromise the Station
process or its operator. ACP remains unavailable until both the provider-facing
connection and the Station-owned child identity can be independently proved.

### Station Control on the Codex bound channel

Owner decision (#2376, 2026-11-16): with the preview on, a new Codex thread
receives the whole Station Control catalog as `dynamicTools`, listed at `bound`.
Station mints no header token for that Session and gives Codex no
`station-control` MCP entry. Codex has no other route where the credential never
leaves Station; an environment-variable bearer or a stdio shim would hold no
better custody than the header. The cost is the full catalog on every thread,
113,759 bytes of `dynamicTools` with the browser tools, and no progressive
disclosure on this channel.

- **Listing.** The same registrations and filters as Claude's in-process
  server: listed at `bound`, narrowed to the Agent's
  `(allowedTools ?? toolNames ?? []) − disabledTools` selection, and to the
  network-restricted allowlist when Station restricts the Session's network.
  The adapter holds every call to that selection again.
- **Credentials.** Browser and device calls keep the request-proof
  credential above. Every other call runs as Claude's in-process server does,
  with the Session's `sdk-in-process` Station Control token, which travels only
  in loopback requests Station sends to itself. The authority guard sees a
  `bound` caller either way.
- **Approval.** Every call goes through Station's external pre-tool policy, as a
  Claude in-process call does, instead of Codex's own MCP approval prompt. The
  argument limit is set per tool: the HTTP route's 1 MiB for catalog tools (an
  `html_render` page can be 256 KiB), and 40,000 bytes for browser and device
  tools in every Session, since their whole input is recorded in the approval
  event. An MCP-app result's structured content is returned to the model as
  JSON text beside its summary.
- **Resume.** Codex 0.167.0 persists a thread's `dynamicTools` from
  `thread/start` and restores them on `thread/resume` and `thread/fork`.
  Station records `boundCatalog` on the resume cursor of a thread that started
  with the catalog, and only while the resumed native thread is the same one.
  Only such a thread resumes without the header token; its calls are still
  held to the current catalog. Any other resume (a thread started with the
  preview off, or before this change) and a coordinator-derived Station
  Control entry keep the header-token server at `delegated-custody`, with
  browser and device tools on the bound channel as before.
- **Continuations that still hold the catalog.** A marked thread resumed with
  the preview off, or after its Station Control became coordinator-derived,
  gets the header-token server; Codex still shows the model its persisted
  catalog copies, and Station refuses each with a message naming the
  station-control MCP tool of the same name. Station does not keep serving
  them: turning the preview off withdraws the bound channel's authority, and
  coordinator-derived authority never rides it. The thread keeps its marker,
  so a later resume with the preview on uses the catalog again. A resumed
  adopted lineage (a fork of a thread Station holds no cursor for) gets the
  header-token server and, with the preview on, the bound catalog too, so
  persisted copies from a catalog source thread keep working. The model may
  then see both copies of a tool; both run as this Session's caller, the bound
  ones at `bound`. Their credentials use separate keys (`station-control`
  for the header, `codex-control` for the bound catalog), so minting or
  closing one channel does not revoke the other; Session shutdown revokes
  both. Station cannot tell whether such a source carried the
  catalog: Codex's fork and resume responses do not list a thread's
  `dynamicTools`. An adoption's first start carries no Agent tool servers,
  so during that first Session any catalog copies inherited from the source
  are refused; only its later resumes serve them. Saved browser and device
  copies have no MCP twin, so they are refused without the pointer.
- **Station Knowledge** stays on its header-token server.
- **Instructions.** The orchestration text for such a Session is composed at
  `bound`, so it names the tools the Session is offered (for example
  `list_delegation_targets`).

Evidence: on 2026-11-16, Codex CLI 0.167.0 on macOS ran `codex app-server`
against a local mock Responses endpoint (no network model, no account). A
thread started with the 162-tool catalog offered all 162 to the model. After the
app-server process exited, a new one resumed the thread with no `dynamicTools`
and offered all 162 again; a fork offered all 162. A model `function_call` on
the resumed and forked threads reached the client as `item/tool/call`. Adapter
and runtime tests cover the request builder, the resume fallback and a `bound`
caller at the authority guard. No real-model Session has used the catalog yet.

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
