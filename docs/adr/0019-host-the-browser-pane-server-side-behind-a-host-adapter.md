# ADR 0019 — Host the Browser pane server-side, behind a host adapter

**Status:** Accepted, 2026-09-22. Records four owner decisions (D1–D4) made
for epic #90 on that date. It **supersedes in part** ADR 0017
([Keep browser-preview hosting adapter-local](0017-browser-preview-host.md))
and the #1376 [host spike](../design/browser-preview-host-spike.md); each of
those records names the parts superseded. No code ships with this ADR. Every
module it describes as *planned* does not exist yet.

## Context

Epic #90 wants a Browser pane that a user and an authorized agent operate
together: one visible page, explicit control arbitration, scoped tools, and
bounded artifacts (BA-R1 to BA-R6). The epic was blocked until a production
host was chosen.

The previous host record could not carry that. ADR 0017 and the spike selected
a separate Tauri `WebviewWindow` confined to one approved loopback origin, on
desktop only. Its go/no-go forbade expanding it to remote targets, automation,
or a web/mobile renderer, and it marked a screenshot/stream transport as out of
scope. Station's clients are not only the desktop app: the web/PWA client and
paired phones reach the same Station. A desktop-local window cannot show them
the page, and it cannot be driven while no desktop UI is open.

Facts this decision depends on, checked on this branch:

- Hosted and personal deployments are already told apart at route mount. The
  mobile device routes mount only when there is no hosted tenant registry and
  hosted tenant execution is not required
  (`src-server/runtime/routes/runtime-routes.ts`, the `/api/mobile-devices`
  mount).
- Station already owns child-process lifetime through `spawnOwnedChild`
  (`src-server/services/infra/process-utils.ts`), which records children in
  its orphan registry.
- The remote relay's application channel is stop-and-wait. The producer sends
  one chunk of at most 16 KiB, base64-encoded, per `credit` frame from the
  peer (`APPLICATION_CHANNEL_CHUNK_BYTES` in
  `packages/connect/src/core/applicationChannelFrames.ts`; the credit loop in
  `packages/connect/src/core/applicationChannel.ts`). The planner estimated
  about 5 fps for screen-sized frames over it. That figure depends on
  round-trip time and frame size, and it has not been measured.
- The station-control MCP token is per-session in lifetime but not in
  authority. A live token opens the whole station-control tool surface and is
  not scoped by the session that minted it
  (`src-server/runtime/mcp/station-control-mcp-token.ts`, module docblock).
- Upstream, Tauri 3's CEF runtime (`tauri-runtime-cef`) published
  `v3.0.0-alpha.2` on 2026-09-21. Tauri child webviews still carry the open
  defects the spike cited: tauri-apps/tauri#15682 (child webview covers the
  main webview), #15656 (Wayland bounds) and #11794 (no mobile `add_child`).
  All three were open on 2026-09-22.

Prior art: [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT) runs
an Electron webview driven over the Chrome DevTools Protocol (CDP), a
server-side automation broker, human-input control epochs, and Playwright's
injected script for locators. Station borrows its broker, tool and arbitration
model. The host is different.

## Decision

### D1 — Stream first, from a server-side Chromium; native rendering is a later adapter

**Phase 1.** The Station host runs a Chromium process, and the page is
streamed into the Browser pane as frames. Input travels back as typed events.
The same stream serves the desktop (Tauri 2), web/PWA and mobile clients.

Why stream first:

- **Client parity.** A server-side page with a frame stream is the only host
  that renders identically in every client Station ships, with no per-platform
  embedding. A desktop-local webview reaches one client.
- **The agent does not need a UI.** The browser belongs to the Station host,
  not to a window. An agent can open, navigate and act on a page while no
  client has the pane open, and a user who opens the pane later sees the same
  live page (BA-R1).

**Phase 2 (later).** A native desktop renderer on Tauri 3's CEF runtime, which
exposes CDP per webview in Rust. It is a **thin adapter**. Tools, the
automation broker, pane state, control arbitration and artifacts never branch
on host kind. The host interface carries a kind (`'server-chromium' |
'desktop-cef'`) for diagnostics and capability reporting, not for control flow
elsewhere.

**Streaming stays universal in Phase 2.** Every host offers a screencast
producer, because web and phone viewers need frames whatever renders the page.
A native CEF surface is an extra per-viewer option, available only to a viewer
on the same desktop as the renderer.

### D2 — Any `http:`/`https:` URL, on personal hosts only

- **Personal hosts only.** The feature mounts behind the same gate as the
  mobile device routes. On hosted or multi-tenant deployments the routes are
  not mounted and the browser tools report *unavailable*. They do not fail
  late or silently.
- **Schemes.** Only `http:` and `https:` are allowed, plus `about:blank`.
  `file:`, `chrome:`, `data:`, `javascript:`, `view-source:`, `devtools:` and
  every other `about:` URL fail closed. This applies to tool-initiated
  navigation **and** to navigation started inside the page.
- **Downloads are denied.** Popups load in the same tab (t3code's behaviour).
  No second target opens.

This is the SSRF posture. On a personal host there is one operator, and the
browser reaches what that operator's machine can reach. That includes loopback
dev servers, which are the main reason for the feature. On a hosted
deployment, a server-side browser that fetches an arbitrary URL is a
server-side request forgery primitive against the provider's internal network
and metadata endpoints. No per-URL policy is strong enough to justify it, so
the feature is absent there.

### D3 — Use an installed Chrome or Edge, else download a pinned build with consent

- Prefer an installed Google Chrome or Microsoft Edge, found in the standard
  per-OS install locations.
- Otherwise, download a **pinned** Chrome-for-Testing build on first use,
  **only after explicit user consent**, into
  `<STATION_HOME>/browser/chromium/<version>/`. Station never bundles a browser
  in the app.
- Station launches the browser itself through `spawnOwnedChild` with
  `--remote-debugging-pipe`, so the process is in the orphan registry. It
  speaks raw CDP over the pipe. No debugging port opens on the network.
- Profiles are Station-owned, one per Project, under
  `<home>/projects/<slug>/browser/profile`. Station never launches against the
  user's own browser profile. Cookies and history persist only inside that
  Project's profile, as #90's scope requires.
- Playwright's Page and Locator APIs are **not** used at runtime, because a CEF
  host gives raw CDP only. Playwright's injected script (from
  `playwright-core`) may be installed through `Runtime.evaluate` for locators,
  as t3code does.

### D4 — JavaScript evaluation exists, behind a per-Project permission that defaults off

The evaluation tool ships. It is gated by a per-Project permission that is
**off by default**. When the permission is off, the tool fails closed with a
typed *not permitted* result that says how to enable it.

This **amends BA-R4**. "Arbitrary evaluation fails closed" becomes "arbitrary
evaluation fails closed unless the Project enables it". Downloads, browser
permissions, filesystem paths and non-`http(s)` navigation still fail closed
unconditionally.

Station's own vetted scripts, such as the locator engine above, are not
*arbitrary evaluation* and are not governed by this permission. The permission
governs agent-supplied source only.

### Shared live-surface primitive and control lease

The frame stream, the input channel and control arbitration form one
host-neutral primitive, the **live surface**. It is built for the Browser pane
first. It is designed so the Device pane (#1969, and the device control
leases of #1970) can adopt it. The Device pane today uses bounded PNG capture
(`LocalMobileDeviceHost.capture` in
`src-server/services/mobile-device/mobile-device-host.ts`). Its adoption of
this primitive is planned, not done.

The planned modules are a `live-surface.ts` contract in the contracts package,
a `live-surface` service directory in the server (a surface hub and a control
lease), and a shared canvas component and hook in the UI. None of them exists
on this branch.

Semantics:

- **Producers.** Any frame-and-input source (a CDP screencast, later a device
  capture) implements one producer interface: start with stream parameters,
  acknowledge frames for backpressure, stop, and dispatch typed input
  (pointer, key, text).
- **Fan-out.** A surface hub fans one producer out to N viewers.
  **Latest-frame-wins:** a slow viewer skips frames and never receives a queue
  of stale ones. The producer is suspended when the surface has **zero
  viewers**.
- **Control lease.** One controller and any number of viewers. Watching never
  requires the lease. Each lease has an **epoch**, and every claim increments
  it. **Human input claims the lease automatically** at `epoch + 1`. That
  fences any in-flight agent operation: the operation checks the epoch before
  and after each CDP send, and aborts with a typed *interrupted* error when the
  epoch moved (BA-R3). Agents claim explicitly. A lease may carry an expiry.
- **Server-owned session.** A browser session is owned by the server and keyed
  by its own id. It records Project, optional thread, URL, viewport,
  generation, host kind and profile reference. Browser pane state v2 persists
  only the Project, the browser session id and an update time. It references
  the session and never embeds it. The existing v1 contract
  (`packages/contracts/src/workspace-browser-preview.ts`) is kept and migrated
  explicitly, never read implicitly as v2.

### Frame transport and the relay limit

Frames travel as a **length-prefixed binary fetch stream**, not SSE. The
stream is open only while a pane is visible, and closes at zero viewers.
Input is ordinary authenticated requests. ADR 0018 records how this fits the
connection budget.

Over the relay (see Context), throughput is bounded by stop-and-wait 16 KiB
chunks. Streams therefore **adapt fps and quality** to what the path delivers,
and keep latest-frame-wins end to end. They never buffer stale frames to
catch up. Improving relay throughput is separate work and overlaps #1973.

### Caller authority is a prerequisite

Browser tools act for a specific agent session, and the lease records which
one. They need the **verified** calling session. The current station-control
token does not establish it (see Context), and a `sessionId` supplied as a tool
argument never counts as authority. Verified caller identity for
station-control tools is a wave-1 slice of #90 (#122). The agent tools do not
ship before it.

## Consequences

- **Performance over the relay is limited.** On a remote phone, expect low
  frame rates on busy pages until relay throughput improves. The design
  degrades gracefully instead of falling behind, but it cannot make the relay
  faster.
- **A pinned Chrome-for-Testing build does not update itself.** A browser that
  loads arbitrary web pages accumulates known vulnerabilities as it ages. The
  pin needs a bump cadence, and an installed, auto-updating Chrome or Edge is
  preferred for this reason too. Installed browsers vary in version, so the CDP
  surface Station uses must tolerate a supported version range.
- **The host runs a real browser process** with its own CPU and memory cost.
  Suspending the screencast at zero viewers removes the encoding cost, but not
  the cost of a loaded page. Lifetime and orphan cleanup ride the existing
  owned-child registry.
- **Hostile pages are the new actor.** An agent's own tools may already reach
  the network. A page loaded in this browser is untrusted code running on the
  Station host's network position. Station treats some loopback callers
  specially. `isSameMachineBrowserCaller` in
  `src-server/runtime/routes/runtime-routes.ts` grants presentation and
  log-read locality to a loopback socket, and its own docblock says loopback
  is a transport position that any local process satisfies. A page in the
  host's browser that sends requests to Station's own listening origins is
  therefore a new path to that locality. The host adapter must deny
  navigation and subresource requests to Station's own origins, and the
  hostile-page suite (#125, BA-AC6) must prove it. This control is derived
  from existing code, not from D1–D4. See the open questions.
- **Remote viewers see host-local pages.** A paired phone that views the pane
  sees pages rendered from the host's network, including loopback dev servers.
  That is the feature on a single-operator host, and a second reason the
  feature is absent where the operator is not the only principal.
- **Viewing stays separate from control.** Opening or closing a pane never
  starts or stops the browser session, and never claims or releases the lease.
- **Previous desktop paths remain for now.** The external open action and the
  loopback-confined separate-window preview stay in place until the pane v2
  migration decides their fate.

### What stays NOT_VERIFIED

- The relay frame rate. The ~5 fps figure is an estimate, not a measurement.
- Chrome and Edge discovery on each OS, CDP compatibility across installed
  versions, and pipe transport on Windows.
- Chrome-for-Testing download integrity checks, consent UX and cleanup.
- Scheme and navigation enforcement against in-page redirects, `window.open`,
  meta refresh and service workers.
- Denial of Station's own origins to page subresource requests.
- Lease fencing under concurrent human and agent input, measured end to end.
- The Tauri 3 CEF adapter. It is an alpha upstream; no Station code, package
  size, signing or platform result exists for it.
- Frame streaming on the web/PWA client and on paired phones.

## Alternatives considered

- **Tauri 2 child webview inside the main window.** Rejected, as in ADR 0017.
  It requires the `unstable` feature, and tauri-apps/tauri#15682, #15656 and
  #11794 remain open. It would also reach the desktop client only.
- **Port Station to Electron** (t3code's host). Rejected. ADR 0017 already
  declined an Electron migration for this feature. It would buy an embedded
  webview on desktop only, at the cost of a new distribution, patch and signing
  programme. Web and mobile would still need a stream.
- **Wait for Tauri 3 CEF.** Rejected as the first step. It had reached
  `v3.0.0-alpha.2` on 2026-09-21, which is not a base to ship on, and it is
  desktop-only too. It remains the planned Phase 2 adapter, which is why the
  host interface is shaped around raw CDP.
- **Loopback-only targets** (the spike's containment, kept for a server
  browser). Rejected by the owner. It blocks the common case of opening
  documentation, staging sites or the user's own deployments beside a dev
  server. The personal-host gate takes the place of loopback confinement as
  the SSRF boundary.

## Open questions

- **Station's own origins.** Should the deny list be exactly the Station
  process's HTTP, terminal (`port + 1`) and voice (`port + 2`) origins, or all
  of loopback except user-chosen dev-server ports? This ADR assumes the former.
  It needs owner confirmation before the host-core slice lands.
- **Injected-script world.** Should the locator script run in an isolated
  world rather than the page's main world, so page script cannot tamper with
  it?
- **Several visible Browser panes.** Should they share one multiplexed frame
  stream, given the connection budget in ADR 0018?
- **Existing desktop preview.** Is the separate-window preview retired or
  retained once pane v2 ships?
