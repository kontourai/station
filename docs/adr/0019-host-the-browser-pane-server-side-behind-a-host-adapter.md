# ADR 0019 — Host the Browser pane server-side, behind a host adapter

**Status:** Accepted, 2026-09-22. It records six owner decisions (D1–D6) made
that day for epic [#90](https://github.com/kontourai/station/issues/90). It
**supersedes in part** three records, and each names the parts superseded:

- ADR 0017 ([Keep browser-preview hosting adapter-local](0017-browser-preview-host.md));
- the archive#1376 [host spike](../design/browser-preview-host-spike.md);
- the archive#1375 [Browser Preview Pane MVP](../design/browser-preview-pane-mvp.md).

It also amends two requirements of #90 (BA-R1, and BA-R4 twice). It amends
one of #90's non-goals and reconciles another without amending it. It amends
one acceptance criterion of
[#121](https://github.com/kontourai/station/issues/121). No code
ships with this ADR, and every module it calls *planned* does not exist yet.
Where a rule is an engineering addition rather than an owner decision, the
text says so.

Related: [#2339](https://github.com/kontourai/station/pull/2339), a separate
fix that requires a Station origin for browser WebSocket upgrades on
loopback.

Issue references follow `AGENTS.md`. Bare numbers of #550 and above refer to
this repository. #90 and #121–#125 are below 550 but belong to this
repository too, so they are linked in full on first mention. `archive#` names
the archived backlog.

## Context

Epic #90 wants a Browser pane that a user and an authorized agent operate
together. They share one page, arbitrate control explicitly, use scoped tools,
and produce bounded artifacts (BA-R1 to BA-R6). The epic stayed blocked until
a production host was chosen.

The previous host record could not carry that. ADR 0017 and the spike chose a
separate Tauri `WebviewWindow` confined to one approved loopback origin, on
desktop only. Their go/no-go ruled out remote targets, automation and a
web/mobile renderer, and put a screenshot or stream transport out of scope.
But Station's clients are not only the desktop app: the web/PWA client and
paired phones reach the same Station. A desktop-local window cannot show them
the page, and cannot be driven while no desktop UI is open.

Facts this decision depends on, checked on this branch:

- **Hosted and personal deployments are distinguished at route mount.** The
  mobile device routes mount only when there is no hosted tenant registry and
  hosted tenant execution is not required. See the `/api/mobile-devices`
  mount in `src-server/runtime/routes/runtime-routes.ts`.
- **A personal host is not a single-principal host.** A non-hosted Station can
  enable local accounts (`STATION_LOCAL_ACCOUNTS`, read in
  `src-server/services/identity/local-account-runtime.ts`). It can load a
  deployment authentication module (`STATION_AUTHENTICATION_MODULE`, read in
  `src-server/services/identity/deployment-authentication-loader.ts`). Projects
  carry per-principal access roles (`viewer`, `contributor`, `admin`,
  `owner`) in `src-server/services/projects/project-membership-store.ts`,
  served by the `/api/projects` membership routes and the operator's
  `/api/operator/accounts` routes in `runtime-routes.ts`. "Not hosted"
  therefore does not mean "one person".
- **Station owns child-process lifetime.** `spawnOwnedChild`
  (`src-server/services/infra/process-utils.ts`) writes a host-wide registry
  record for each child, keyed to its owning Station. A later startup sweep
  reaps the child if that owner died without running cleanup. The record is
  best-effort: a registry write failure is swallowed so the spawn still
  succeeds, and that child is then not sweep-protected. It also removes
  the boot-internal secrets from the child's environment (`scrubBootInternalSecrets`
  in `src-server/utils/child-process-environment.ts`).
- **Station runs five listeners per instance, not one.** They are the HTTP
  server, the terminal WebSocket (`port + 1`), the voice WebSocket
  (`port + 2`), the consent listener, and the UI. The CLI enforces that all
  five are distinct (`packages/cli/src/commands/lifecycle.ts`). The server
  side self-allocates a contiguous block of four for the first four
  (`src-server/runtime/bootstrap/allocate-port-block.ts`). Several Station
  instances can run on one host, and a Station can also listen on LAN or
  tailnet addresses.
- **The remote relay's application channel is stop-and-wait.** The producer
  sends one chunk of at most 16 KiB per `credit` frame from the peer. Each
  chunk is base64-encoded
  (`APPLICATION_CHANNEL_CHUNK_BYTES` in
  `packages/connect/src/core/applicationChannelFrames.ts`; the credit loop in
  `packages/connect/src/core/applicationChannel.ts`). A rough estimate puts
  screen-sized frames at about 5 fps. That figure depends on round-trip time
  and frame size, and has not been measured.
- **The station-control MCP token is per-session in lifetime, not in
  authority.** A live token opens the whole station-control tool surface and
  is not scoped by the minting session
  (`src-server/runtime/mcp/station-control-mcp-token.ts`, module docblock).
  The env-delivered built-in station-control child is no better. It carries
  the single global internal API token (`INTERNAL_API_TOKEN`, re-attached by
  `src-server/runtime/bootstrap/station-control-runtime-env.ts`), which does
  not identify a session at all.
- **Upstream Tauri.** Tauri 3's CEF runtime (`tauri-runtime-cef`) published
  `v3.0.0-alpha.2` on 2026-09-21. The Tauri 2 child-webview defects the spike
  cited were all open on 2026-09-22: tauri-apps/tauri#15682 (the child covers
  the main webview), #15656 (Wayland bounds) and #11794 (no mobile
  `add_child`).

Prior art: [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT) runs
an Electron webview driven over the Chrome DevTools Protocol (CDP). It has a
server-side automation broker, human-input control epochs, and uses
Playwright's injected script for locators. Station borrows its broker, tool and
arbitration model. The host is different.

## Decision

### D1 — Stream first, from a server-side Chromium; native rendering is a later adapter

**Phase 1.** The Station host runs a Chromium process, and the page is
streamed into the Browser pane as frames. Input travels back as typed events.
The same stream serves the desktop (Tauri 2), web/PWA and mobile clients.
Chromium runs headless; that is an implementation detail (see D6).

Why stream first:

- **Client parity.** A server-side page with a frame stream is the only host
  that renders identically in every client Station ships, with no
  per-platform embedding. A desktop-local webview reaches one client.
- **The agent does not need a UI.** The browser belongs to the Station host,
  not to a window. An agent can act on a page with no client open. A user who
  opens the pane later sees the same live page and its history (D6).

**Phase 2 (later).** A native desktop renderer on Tauri 3's CEF runtime, which
exposes CDP per webview in Rust. It is a **thin adapter**. Tools, the
automation broker, pane state, control arbitration, authorization and
artifacts never branch on host kind. The host interface carries a kind
(`'server-chromium' | 'desktop-cef'`) for diagnostics and capability
reporting only.

**Streaming stays universal in Phase 2.** Every host offers a screencast
producer, because web and phone viewers need frames whatever renders the page.
A native CEF surface is an extra option, and only for a viewer on the same
desktop as the renderer.

### D2 — Any `http:`/`https:` URL, on personal hosts only

- **Personal hosts only.** The feature mounts behind the same gate as the
  mobile device routes. On hosted or multi-tenant deployments the routes are
  not mounted and the browser tools report *unavailable*. They neither fail
  late nor fail silently. Being a personal host is **necessary but not
  sufficient**; D5 adds per-principal authorization.
- **Schemes.** `http:` and `https:` are allowed. Every other scheme fails
  closed: `file:`, `chrome:`, `data:`, `javascript:`, `view-source:`,
  `devtools:`, `blob:`, and every `about:` URL. This covers tool-initiated
  navigation and navigation started inside the page, in the top frame and in
  subframes.
  - `about:blank` is allowed. That is an **engineering addition, not an owner
    decision**: the browser opens new targets on it. `about:srcdoc` is allowed
    for subframes only, as the same kind of engineering exception, because
    that is how an `<iframe srcdoc>` document loads.
  - The `blob:` and `data:` denial is an engineering reading of D2. It applies
    to *navigation*. A page loading its own `blob:` or `data:` images,
    scripts or workers is subresource use, not navigation, and is allowed.
- **Downloads are denied.** **File choosers are denied too**, because an
  upload dialog would expose host filesystem paths (BA-R4). Popups load in the
  same tab, as t3code does, so no second target opens.

**This amends #90 BA-R4 a first time.** "External navigation fails closed"
becomes "navigation outside `http(s)` fails closed, and on personal hosts
`http(s)` navigation to any destination is allowed". The destination limit
that remains is the listener denial below.

**SSRF posture.** On a personal host, the browser reaches what that host can
reach. That includes loopback dev servers, which are the main reason for the
feature. On a hosted deployment, a server-side browser fetching arbitrary URLs
is a server-side request forgery primitive against the provider's internal
network and metadata endpoints. No per-URL policy is strong enough to justify
that, so the feature is absent there.

Even on a personal host, **the browser must never reach any Station listener
on this host**. See "Hostile pages" under Consequences for the threat and the
enforcement rule.

### D3 — Use an installed Chrome or Edge, else download a pinned build with consent

- Prefer an installed Google Chrome or Microsoft Edge, found in the standard
  per-OS install locations.
- Otherwise, download a **pinned** Chrome-for-Testing build on first use,
  **only after explicit user consent**, into
  `<STATION_HOME>/browser/chromium/<version>/`. The app never bundles a
  browser.
- **Launch.** Station launches the browser itself through `spawnOwnedChild`
  with `--remote-debugging-pipe` and speaks raw CDP over the pipe. No
  debugging port opens on the network.
- **Environment.** The child environment is scrubbed of the boot-internal
  secrets. The internal API token is scoped to the built-in station-control
  MCP child alone, and the browser process never receives it or any other
  Station credential.
- **Profiles.** Station owns them, one per Project, keyed by the **canonical
  Project ID** rather than the slug, so a rename does not orphan or alias a
  profile. Station never launches against the user's own browser profile.
  Cookies and history persist only inside that Project's profile, as #90
  requires.
- **No Playwright at runtime.** Playwright's Page and Locator APIs are not
  used, because a CEF host gives raw CDP only. Playwright's injected script
  (from `playwright-core`) may be installed through `Runtime.evaluate` for
  locators, as t3code does.

### D4 — JavaScript evaluation exists, behind a per-Project permission that defaults off

The evaluation tool ships behind a per-Project permission that is **off by
default**. When the permission is off, the tool fails closed with a typed *not
permitted* result that says how to enable it. Only principals D5 authorizes
may toggle it.

**This amends #90 BA-R4 a second time.** "Arbitrary evaluation fails closed"
becomes "arbitrary evaluation fails closed unless the Project enables it".
Downloads, file choosers, browser permissions and filesystem paths still fail
closed unconditionally.

It is an **engineering addition, not an owner decision**, that Station's own
vetted scripts (such as the locator engine) are not *arbitrary evaluation* and
are not governed by this permission. The permission governs agent-supplied
source only.

### D5 — The operator and the Project's admins and owners; per-principal authorization on every operation

The following people may view a Browser session, send it input, claim its
control lease, toggle its eval permission, and use the browser tools through
their agents:

- the **Station operator**, as computed by
  `projectMembershipAuthority(request).operator()` in
  `src-server/runtime/routes/runtime-routes.ts`; and
- **admins and owners of the session's Project** (owner ⊇ admin: an owner
  holds every admin right here).

Project **viewers and contributors get nothing**: no view, no input, no tools.
Being a personal host (D2) is necessary but not sufficient.

- **Every route and every operation is authorized per principal**, including
  frame streams, input, lease claims, tool calls and permission changes. It is
  never inferred from network position, loopback, or possession of a surface
  id.
- **Input authorization is separate from view authorization.** Each is checked
  on its own, so a later change to one rule cannot widen the other.
- **An agent acts with the authority of its verified calling session's
  principal.** That principal must satisfy D5 for the session's Project. A
  `sessionId` supplied as a tool argument never counts. Neither current
  station-control credential establishes the caller: the per-session wire MCP
  token, or the global `INTERNAL_API_TOKEN` carried by the env-delivered
  built-in station-control child (see Context). Verified caller identity for
  both delivery paths is a wave-1 slice
  ([#122](https://github.com/kontourai/station/issues/122)), and the agent
  tools do not ship before it.
- **Human input always preempts an agent.** An agent claim never preempts a
  live human holder.

### D6 — Agents may drive with no viewer; no session is ever hidden

An agent **may** drive a Browser session while no viewer is connected. Every
session is **always discoverable**:

- it is listed to the principals D5 authorizes;
- it carries its full action history (who acted, which operation, when, and
  under which lease epoch);
- it can be opened and watched live at any time.

Chromium runs headless as an implementation detail. What D6 forbids is a
session the user cannot find, not a browser without a window.

**This amends #90 in two places:**

- **BA-R1** ("Agent and user share one visible browser state; hidden fallback
  automation is explicit…") becomes: agent and user share one browser state,
  which is always discoverable and watchable. A session may be driven while
  unwatched, but never while hidden.
- The **non-goal "Silent headless-browser substitution"** becomes: "a browser
  session hidden from the user". Headless rendering is not substitution when
  it is the same session every viewer attaches to.

**It reconciles #90's other non-goal without amending it.** "Unattended
general web automation outside an explicit Browser Workspace Pane" stays a
non-goal. A D6 session is not outside an explicit pane:

- every session is bound to a Project;
- it is listed as a Browser pane session;
- it carries its action history;
- it can be attached as a pane at any time.

Unwatched is not the same as outside the pane.

**It also amends #121 VB-AC2.** "Stale, hidden, wrong-context and non-owning
renderers are rejected" keeps rejecting stale, wrong-context and non-owning
renderers. *Hidden* now means undiscoverable. A session with zero connected
viewers is not hidden, and an authorized agent may drive it.

### Shared live-surface primitive and control lease

The frame stream, the input channel and control arbitration form one
host-neutral primitive, the **live surface**. It is built first for the
Browser pane. The Device pane (#1969, whose device control leases are #1970)
is meant to adopt it. Today the Device pane uses bounded PNG capture
(`LocalMobileDeviceHost.capture` in
`src-server/services/mobile-device/mobile-device-host.ts`), so that adoption
is planned, not done.

The planned modules are:

- a `live-surface.ts` contract in the contracts package;
- a `live-surface` service directory in the server, with a surface hub and a
  control lease;
- a shared canvas component and hook in the UI.

None of them exists on this branch.

Semantics:

- **Producers.** Any frame-and-input source implements one producer
  interface: a CDP screencast now, a device capture later. It can start with
  stream parameters, acknowledge frames for backpressure, stop, and dispatch
  typed input (pointer, key, text).
- **Fan-out.** A surface hub fans one producer out to N authorized viewers.
  **Latest-frame-wins:** a slow viewer skips frames and never receives a queue
  of stale ones. The producer is suspended when the surface has **zero
  viewers**; the session itself stays alive (D6).
- **Control lease.** There is one controller and any number of viewers, and
  watching never requires the lease.
  - Each lease has an **epoch**, which every claim increments.
  - **Human input from an authorized principal claims the lease
    automatically** at `epoch + 1`. That fences any agent operation already in
    flight: the operation checks the epoch before and after each CDP send, and
    aborts with a typed *interrupted* error if it moved (BA-R3).
  - Agents claim explicitly, and an agent claim fails while a human holds the
    lease (D5).
  - A lease may carry an expiry.
- **Server-owned session.** A browser session is owned by the server and keyed
  by its own id. It records the Project, an optional thread, the URL, viewport,
  generation, host kind, profile reference and action history. Browser pane
  state v2 persists only the Project, the browser session id and an update
  time, and it references the session rather than embedding it. The existing
  v1 contract (`packages/contracts/src/workspace-browser-preview.ts`) is kept
  and migrated explicitly, never read implicitly as v2.

### Frame transport and the relay limit

Frames travel as a **length-prefixed binary fetch stream**, not SSE, and only
while a pane is visible. Each client should use **one frame stream,
multiplexing all its visible panes**. Input goes as ordinary authenticated
requests and must never queue behind frames. ADR 0018 records how this fits
the per-origin connection budget.

Over the relay, throughput is bounded by stop-and-wait 16 KiB chunks (see
Context). Streams therefore **adapt fps and quality** to what the path
delivers. They keep latest-frame-wins end to end and never buffer stale
frames to catch up. Improving relay throughput is separate work that overlaps
#1973.

## Consequences

- **Hostile pages are the new actor, and the dominant threat is Station's own
  loopback listeners.** An agent's own tools may already reach the network.
  A page loaded in this browser is untrusted code running from the Station
  host's network position.
  - **The terminal and voice WebSocket listeners** admitted credential-free
    loopback peers without an `Origin` check until
    [#2339](https://github.com/kontourai/station/pull/2339). A page in the
    host's browser would have been such a peer. The rule below does not rely
    on that fix and stays unconditional.
  - **Lesser loopback locality.** `isSameMachineBrowserCaller` in
    `runtime-routes.ts` grants presentation and log-read locality to
    loopback callers on the UI-bootstrap path.

  Rule: **the browser must never reach any Station listener on this host**.
  That covers all five listeners of this instance, the listeners of every
  other Station instance on the host, and the LAN and tailnet addresses any
  of them listen on.

  Enforcement sits **below the page**:
  - It decides on the **resolved address and port** of each connection, never
    on the hostname.
  - It covers `ws:` and `wss:`, dedicated workers, shared workers and service
    workers as well as documents and fetches.
  - It survives DNS rebinding.
  - CDP `Fetch` interception alone is not sufficient, because it does not see
    every connection a page can open.

  The hostile-page suite ([#125](https://github.com/kontourai/station/issues/125),
  BA-AC6) must prove the rule. How it is enforced is a host-core design
  question, and every alias and rebinding case stays NOT_VERIFIED until that
  suite exists.
- **Credentials live in the profile.** The Station-owned profile will be
  launched with the password manager, autofill and sync disabled. Credentials
  a user types through the stream will still persist as session cookies and site storage
  in the per-Project profile. Anyone D5 authorizes can act as that logged-in
  user, and so can their agents. Eval and snapshots can read logged-in page
  state. That is why D4 defaults off and why D5 excludes Project viewers and
  contributors.
- **Clipboard stays inside the browser.** Page clipboard writes will stay
  inside headless Chromium and must never reach the host operating system's
  clipboard.
  This is NOT_VERIFIED.
- **Frame rates over the relay are limited.** On a remote phone, expect low
  frame rates on busy pages until relay throughput improves. The design
  degrades rather than falling behind, but it cannot make the relay faster.
- **A pinned Chrome-for-Testing build does not update itself.** A browser that
  loads arbitrary pages accumulates known vulnerabilities as it ages. The pin
  needs a bump cadence. An installed, auto-updating Chrome or Edge is
  preferred partly for this reason. Installed browsers vary in version, so the
  CDP surface Station uses must tolerate a supported range.
- **The host pays for a real browser.** Each live session costs a Chromium
  renderer process: typically hundreds of megabytes of memory, plus CPU for
  page scripts. That cost continues while nobody watches, because D6 allows
  unwatched driving. Suspending the screencast at zero viewers removes only
  the capture and encoding cost. Session count needs a bound, and so does
  idle-session teardown. Both are host-core design items.
- **Lifetime and orphan cleanup ride the owned-child registry.** Its startup
  sweep reaps a browser whose owning Station died without cleanup. Its
  process-group reaping is POSIX-shaped, and its Windows behaviour for a
  browser tree is NOT_VERIFIED.
- **Remote viewers see host-local pages.** An authorized phone sees pages
  rendered from the host's network, including loopback dev servers. D5 limits
  that to the operator and Project admins and owners.
- **Viewing is separate from control and from lifetime.** Opening or closing a
  pane never starts or stops the browser session, and never claims or releases
  the lease.
- **Existing desktop paths remain for now.** The external open action and the
  loopback-confined separate-window preview stay until the pane v2 migration
  decides their fate.

### What stays NOT_VERIFIED

- The relay frame rate. The ~5 fps figure is an estimate, not a measurement.
- Chrome and Edge discovery on each OS, CDP compatibility across installed
  versions, and pipe transport and process-tree cleanup on Windows.
- Chrome-for-Testing download integrity checks, the consent UX and cleanup.
- Scheme enforcement against in-page redirects, `window.open`, meta refresh
  and service workers.
- The Station-listener denial. That includes address aliases (other loopback
  addresses, IPv4-mapped IPv6, `0.0.0.0`, LAN and tailnet names), DNS
  rebinding, and WebSocket and worker connections.
- Per-principal authorization (D5) on every route and operation, and the
  separation of input from view authorization.
- Lease fencing under concurrent human and agent input, end to end.
- That page clipboard writes never reach the host clipboard.
- That the profile's password manager, autofill and sync are actually
  disabled by the launch flags on every supported browser.
- The Tauri 3 CEF adapter. Upstream it is alpha. No Station code, package
  size, signing or platform result exists for it.
- Frame streaming on the web/PWA client and on paired phones.

## Alternatives considered

- **Tauri 2 child webview inside the main window.** Rejected, as in ADR 0017.
  It requires the `unstable` feature, and tauri-apps/tauri#15682, #15656 and
  #11794 remain open. It would also reach only the desktop client.
- **Port Station to Electron** (t3code's host). Rejected. ADR 0017 already
  declined an Electron migration for this feature. It would buy an embedded
  webview on desktop only, at the cost of a new distribution, patch and
  signing programme, and web and mobile would still need a stream.
- **Wait for Tauri 3 CEF.** Rejected as the first step. At `v3.0.0-alpha.2`
  (2026-09-21) it is not a base to ship on, and it is desktop-only too. It
  remains the planned Phase 2 adapter, which is why the host interface is
  shaped around raw CDP.
- **Loopback-only targets** (the spike's containment, applied to a server
  browser). Rejected by the owner. It would block the common case of opening
  documentation, staging sites or the user's own deployments beside a dev
  server. The personal-host gate (D2), per-principal authorization (D5) and
  the Station-listener denial replace loopback confinement as the boundary.

## Open questions

- **Isolated world.** Should the locator script run in an isolated world rather
  than the page's main world, so page script cannot tamper with it?
- **The separate-window preview.** Is it retired or retained once pane v2
  ships?
