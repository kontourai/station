# Browser workspace

The Browser pane shows a page running in a Station-owned Chromium process on
the selected Station host. The pane, an authorized Agent, and other authorized
viewers share that browser session. The page is not embedded in Station's
privileged web UI, and it does not use the viewer's ordinary browser profile.

This is the current implementation guide. [ADR 0019](../adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md)
records the original design; its dated future tense and verification gaps are
not a current feature inventory. Native CEF hosting remains planned. The
current [host resolver](../../src-server/services/browser/browser-host.ts)
accepts only `local`, meaning the selected Station host, even when the viewer
is on another machine.

## Open and use a session

Use a personal Station deployment and a Project. Hosted tenant runtimes do not
mount the browser or live-surface routes. The Station operator may view and
control browser sessions across profiles; an active Project admin or owner may
use sessions in their own profile for that Project. Project contributors and
viewers do not receive browser access. Pairing or knowing a session ID does not
replace those checks.

Open a Browser pane for the Project and choose a session or open a URL. The
[pane](../../src-ui/src/workspace-panes/browser-pane/BrowserPane.tsx) provides
the address bar, navigation history, viewport presets, session list, setup,
local-target registration and Agent access controls. A phone viewport preset
emulates a browser viewport; it is not an iOS/Android device or app test. Use
the [Device pane](mobile-device-workspace.md) for simulators and emulators.

If no supported browser is available, the operator can approve the displayed
Chromium download. [Acquisition](../../src-server/services/browser/chromium-acquisition.ts)
prefers a detected system Chrome, Edge or Chromium, then a previously installed
pinned Chrome-for-Testing build. Status reads do not download. A new download
requires literal consent, checks the pinned archive size and SHA-256, and
validates archive paths before installation. It is stored beneath
`<STATION_HOME>/browser/chromium/`; it is not bundled with Station. Installed
browser discovery and launch compatibility still need qualification on each OS.

An open pane subscribes to the session's live surface. Hiding or closing that
viewer stops its frame request, not the browser session. An authorized Agent
may work while nobody watches. Close the server session explicitly when the
page should stop running. If its browser exits, or Station restarts, retained
sessions become `needs-reopen`; they are not silently declared live. Reopening
uses a new browser generation and invalidates the old live-surface reference.

## Profiles and network reach

The [session registry](../../src-server/services/browser/browser-session-registry.ts)
keys profiles by canonical Project ID and principal: the operator has one
profile per Project, and each Project admin has a separate profile. Directories
use digests under `<STATION_HOME>/browser/profiles/`. Cookies and site storage
belong to that profile, not to the viewer's browser. The operator can access
other profiles' sessions; this is not isolation from the host operator or
arbitrary code running as the same OS user.

The [Chromium host](../../src-server/services/browser/hosts/chromium-server-host.ts)
launches an owned process with a CDP pipe, an allowlisted environment and a
Station-owned egress proxy. No CDP network port is opened. Its launch flags
disable extensions and sync, and its page policy refuses downloads and file
choosers. These controls do not constitute a claim that every browser version
or hostile page has been qualified.

The [URL policy](../../src-server/services/browser/url-policy.ts) admits
`http:`/`https:` navigation, with `about:blank` and subframe `about:srcdoc`
exceptions. Other navigation schemes are refused. The
[egress policy](../../src-server/services/browser/egress-policy.ts) separately
checks resolved connection addresses:

- Operator profiles can reach public, loopback and private addresses, subject
  to the Station-listener denial.
- Project-admin profiles can reach public addresses and local targets the
  operator registered for the Project. Registering a target is a separate
  operator action; discovery suggestions do not grant access.
- Ordinary hostnames resolving to non-public addresses are refused even for
  the operator. Use an admitted IP literal or local spelling for those targets;
  a LAN/tailnet hostname is not automatically admitted.
- Known Station listeners, managed device helpers and the egress proxy itself
  are denied. Other-instance listener discovery is cached briefly; an
  unreadable instance registry contributes no sibling entries. This is a
  code-enforced listener inventory, not proof that every process on the host
  is known or that an already-open connection is recalled immediately.

[Local targets](../../src-server/services/browser/browser-local-targets.ts)
name an admitted host and port for a canonical Project. Public and link-local
addresses are not registrable targets; Station listener ports cannot be added.
The proxy checks current target registrations on new connection decisions.

## Agent authority and human input

The built-in [station-browser tools](../../src-server/tools/station-browser-mcp-server.ts)
provide status, open, close, navigate, resize, snapshot, click, type, press,
scroll, wait and evaluation operations through
[browser-agent routes](../../src-server/routes/browser-agent.ts). They require
a verified, bound calling Session, its recorded owner and Project, and current
operator/admin standing. Bearer-exposed or delegated-custody credentials do not
satisfy that caller contract. A tool-supplied Session or Project ID cannot
create authority.

Only engines Station runs in-process get `station-browser`: Claude Agents,
unless the Agent switched browser tools off. Codex reaches Station over a
URL-token connection (`bearer-exposed`: the token sits in the spawn argv any
same-user process can read) and agents connected over ACP with an HTTP-header token
(`delegated-custody`: the connected app holds it). Neither credential can be attributed
to one Session, so those engines are not offered the tools and a browser call
from them is refused `caller-not-bound`. This is deliberate; it is not a gap in
MCP support. Offering them would need a new bound channel, not a wiring change.

**Approval posture.** Only `browser_status`, which reads Station's own records,
may run without a prompt. Every other station-browser tool reads or drives a
logged-in page: `browser_snapshot` and `browser_wait_for` return the page's
content as much as `browser_click` and `browser_type` act on it. They are all
treated as sensitive (#90 N2), so they prompt in every approval mode. Auto mode
and an agent's `tools.autoApprove` pattern of `*` or `station-*` never cover
them. Only a pattern that names `station-browser` itself, such as
`station-browser_*`, does. Answering the first prompt of a Claude Session with
**Allow the Station browser for this session** covers every later
station-browser tool call in that one Session, so a browser check is one
approval instead of one per tool. It does not carry to another Session, does
not cover any other tool or MCP server, and ends with the Session. The
per-tool **Allow … for this session** choice remains, and covers only that
tool. The choice appears only for a call Station can show is the built-in
server's own; a look-alike server never gets it. It is offered on the approval
toast, the inline card and the inbox card, not in the CLI, which has no
interactive approval prompt.

`browser_status` lists the caller's sessions newest-created first, at most 20
per page (`limit` 1–20; a larger or fractional limit or a malformed `cursor`
is refused `invalid-request`). Each page's `nextCursor` resumes after the last
session it listed, so a session opened, closed or driven between calls does
not make an earlier one repeat or go missing; it is `null` on the last page. A
cursor is an unauthenticated position marker, not a capability: any
well-formed one is accepted and only sets where listing resumes, while what a
page may contain is still limited to the caller's own Project profile.
`browser_close` closes a session through the same registry effect as
the pane's **Close session**, recorded with the Agent as actor, and only when an
Agent opened the session, it is bound to the caller's own conversation, and no
person or other Agent Session holds control. Otherwise it is refused
`opened-by-person`, `other-thread`, `human-controlling` or `held-by-other`; a
session outside the caller's Project profile is `session-not-found`. The
opened-by-Agent check reads the session's `created` history entry, so a
session whose history no longer keeps it is refused rather than assumed.

[BrowserAutomation](../../src-server/services/browser/browser-automation.ts)
selects only the caller's authorized Project profile. Its control operations
use the shared lease and check the captured fence around asynchronous steps.
Human input with a current epoch can preempt an Agent; Agents cannot preempt
a live human holder. Watching needs no control lease. The pane's control line
says who is driving in one word (**Agent** or **You**) with the float-over-chat's
rule (the lease holder, or an Agent whose last input is under ten seconds old).
There is no Take control button: a click or key on the page takes control, and
while an Agent drives, hovering the page says so. While a person holds control,
the chip opens **Hand back to agent** (**Release control** when no Agent has
driven the session), which releases the lease explicitly and is recorded as
`control-released`; an Agent may then claim at once instead of waiting for the
person's hold to lapse. Closing the pane does not release the lease; it
can lapse. A timeout or interrupted operation does not establish that an
already-sent browser effect was undone.

**Agent access → Let agents run JavaScript in this Project's pages** is off by
default and is a separate permission from ordinary read/click/type tools. A
person with operator or Project-admin authority can change it; Agent-originated
requests cannot. Enabled scripts act with the page's privileges and may keep
running after the tool call ends. Even without evaluation, dynamic pages can
move targets between checking and input. Do not treat a tool response or a
screenshot as independent verification of the application under test.

## Page dialogs, console, screenshots and new windows

The [screencast producer](../../src-server/services/browser/chromium-screencast-producer.ts)
decides each JavaScript dialog when it opens:

- An `alert`, `confirm` or `prompt` that opens while a **person** holds the
  view's control is held for them. The pane shows it over the live view with
  the page's host and text; OK, Cancel (or Escape) and a prompt's answer go
  back through `POST /api/browser/sessions/:id/dialog`, which needs drive
  standing and refuses Agent-originated requests. The answer is recorded as
  `dialog-answered`; a prompt's typed text is not recorded. The input that
  opened the dialog settles immediately, and further clicks, keys and text are
  refused (`page-dialog-open`, said in the view) until it is answered. The
  same card appears in the float-over-chat, with **Open in pane** as an
  icon-only control that is a 44px target on a coarse pointer. A held
  dialog is dismissed automatically when the person's control ends
  (released, lapsed or passed to an Agent) and after two minutes at most.
  While the card is in view on a visible tab it sends a keep-alive: a
  separate lease request, not input, that only extends the person's own
  current hold (a stale one never takes control back from an Agent). The
  server caps it at four times the 30-second hold, measured from the
  person's last real input, so a page that keeps opening dialogs in an
  unwatched tab cannot hold control past that; a real click or key resets
  the cap. An answer the browser never acknowledges is `504 page-busy` and
  one whose channel fails is `502`; both keep the dialog answerable. Only
  Chromium's own "no dialog is showing" (the page navigated away) is
  `409 no-dialog`.
- A dialog that opens while an Agent holds control, or nobody does, is
  answered automatically as before (dismissed; `beforeunload` accepted), and
  the pane says so. `beforeunload` is never held.
- While a person's dialog is held, every Browser tool action on the page is
  refused `dialog-open` and `browser_status` reports `dialogWaitingForPerson`.
  Agents cannot answer it. `browser_close` is refused `human-controlling`
  then, because the dialog is held only while the person holds control.

Each live session captures its page's console in memory for that browser
generation ([BrowserConsoleLog](../../src-server/services/browser/browser-console-log.ts)):
console API calls, uncaught exceptions and the browser's own log entries. It
keeps the latest 500 entries, cuts each to 2,000 characters, and counts what
it evicted; the pane's **Console** drawer reads it incrementally, filters by
level and shows the dropped count; it can be resized and scrolls on its own.
Reading it needs view standing. Console text can carry what the pixels never
showed (a token a page logs), so a request that may be an Agent's (Station's
internal principal, an Agent-tool marker, a delegation device) reads it only
where the Project allows **Let agents run JavaScript in this Project's pages**;
otherwise it is refused `403`. Agents have no console tool.

**Screenshot** (in **⋯**) captures the page's viewport as PNG (JPEG over
16 MiB, refused beyond that) with view standing, one capture at a time per
session (a second request joins the one in flight), and offers **Save image**
and, where the viewer's clipboard accepts PNGs, **Copy image**.

The session has one tab. A `target=_blank` link or `window.open` loads in
the same tab and the popup target is closed by the
[Chromium host](../../src-server/services/browser/hosts/chromium-server-host.ts);
the history records the navigation as `link-followed`. In-pane tabs are not
implemented.

The pane's chrome is one row: the address field (host and path, with back,
forward and reload inside it), the driver chip, **Console** (with a count of
errors not yet seen), and **⋯**, which holds Screenshot (Mod+Shift+S),
Viewport, Sessions, Agent access, Local servers and, last, Close session. On
a coarse pointer or a window up to 768px wide every control is at least 44px
and the row does not wrap; the path gives way first, then the host. The 390px
check below found no control under 44px.

## State, evidence and remaining limits

Pane state `2.0` stores the Project ID and server browser-session reference.
The [legacy migration](../../src-ui/src/workspace-panes/BrowserPreviewWorkspacePane.tsx)
opens or restores a session for a `1.0` preview URL, then persists the new
reference after attachment. Native handles, process identity and control grants
are not durable Pane authority.

Browser action history is bounded, with summary omissions and truncation
counts. It is not an unlimited audit log. After the last live target closes,
the profile's idle process is shut down after the registry delay; zero viewers
alone only stop capture. Process ownership and shutdown use the existing
owned-child machinery. Windows browser process-tree cleanup and packaged
platform interaction require their own receipts.

The [shared live-surface module](../architecture/module-map.md#shared-live-surface)
also serves Device sessions. Frames use binary fetch streams rather than SSE
replay. The current viewer opens one stream per visible viewer; the single
multiplexed stream and saturated-pool input-latency requirement in
[ADR 0018](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md)
remain unqualified design constraints. Native transports and relays have their
own limits; no fixed frame rate or immediate input guarantee follows from the
shared canvas.

Source and fixture evidence lives in the
[BrowserSessionService module](../architecture/module-map.md#browsersessionservice).
The page-tools change (dialogs, console, screenshots, hand-back) was
checked against an installed Chrome on macOS: the real-browser producer test
answers an `alert` and a `prompt` a person's click opened and reads the
console and a PNG screenshot, and an isolated Station was driven with
Playwright at 1280px and at 390px with touch input (including typing into a
page field through the canvas keyboard target). That run used a local
fixture page, not a public site, and did not use a physical phone's
on-screen keyboard, a real Agent, a device, a saturated connection pool, or
a release package. Earlier documentation reviews used synthetic
acquisition/host/producer seams only.
