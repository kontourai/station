# Browser, device and Walkthrough reference

This page holds the detailed behavior behind three task guides:
[Browser workspace](../guides/browser-workspace.md),
[Mobile device workspace](../guides/mobile-device-workspace.md) and
[Walkthroughs](../guides/walkthroughs.md). Start with the guide for the task;
come here for authority rules, limits, timeouts, refusal codes, storage and
evidence. Source links name the code that owns each claim.

- [Browser](#browser)
- [Devices](#devices)
- [Walkthroughs](#walkthroughs)

## Browser

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

### Open and use a session

Use a personal Station deployment and a Project. Hosted tenant runtimes do not
mount the browser or live-surface routes. The Station operator may view and
control browser sessions across profiles; an active Project admin or owner may
use sessions in their own profile for that Project. Project contributors and
viewers do not receive browser access. Pairing or knowing a session ID does not
replace those checks.

Open a Browser pane for the Project and choose a session or open a URL. The
[pane](../../src-ui/src/workspace-panes/browser-pane/BrowserPane.tsx) provides
tabs, back/forward/reload, the address bar and the driver chip; viewport
presets, the session list and Browser settings are in **⋯**. Shared local
servers and the Agent JavaScript permission are in **Settings → Advanced →
Browser & devices**. A phone viewport preset
emulates a browser viewport; it is not an iOS/Android device or app test.
The viewport, page zoom and appearance belong to the session, so a change
reaches every viewer and agent; each pane only scales the shared frame to fit
itself ([decision](../decisions/browser-viewport-is-shared-fit-is-per-viewer.md)). Use
the [Device pane](../guides/mobile-device-workspace.md) for simulators and emulators.

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

### Viewing a live surface: zoom, full screen and the chat floater

Every live surface (a Browser session or a device) uses one viewer,
[`LiveSurfaceCanvas`](../../src-ui/src/live-surface/LiveSurfaceCanvas.tsx),
in the Browser pane, the Device pane and the chat floater.

- **Zoom** changes this view only; the page or device never receives it.
  (The Browser pane's **⋯ › Zoom** is different: it zooms the page itself.)
  Pinch with two fingers, or pinch a trackpad (Ctrl+wheel, or Safari's gesture
  events). Move two fingers to pan. A double tap while zoomed returns to fit.
  While you only watch, a double tap zooms in 2× at the tap and a mouse drag
  pans. The percentage badge resets to fit. Taps map to the page pixel shown
  under the finger at any zoom.
- **Presses on touch** go out when the finger lifts, moves 8 px, or stays down
  for 150 ms. A second finger before then cancels the press, so a pinch never
  clicks the page.
- **Full screen** (the pane's corner button, or the floater's controls) lays
  the same viewer over the whole screen, inside the safe area. It uses the
  Fullscreen API where the platform grants it and a full-viewport layer where
  it does not. The stream is not restarted. Touch input drives the surface
  directly. The controls show on entry, hide after 4 s, and come back from the
  ⋯ handle, a tap while you only watch, or mouse movement. They offer Exit,
  Take or Release control, the keyboard while you drive, and the surface's own
  actions: Back, Forward and Reload for a browser, and Home, Back and Recents
  (Android) or Rotate (iOS) for a device. Below 480 pixels wide they are one
  row (who is in control, Take or Release, the address or stand picker, More
  controls and Exit), and the rest are behind More controls. Going full
  screen or back renews a hold you have; it never takes control. Escape, Exit or the platform
  leaving full screen returns to where you were; while full screen is on,
  Escape only leaves it (it does not also go up a level in the app). Zoomed in
  full screen, the zoom level sits in the bottom corner, clear of the controls.
- **The chat floater** moves when you drag the picture with one finger or the
  mouse. While you drive, the picture takes the press and the Move handle
  moves the floater. A tap, the corner dot, or a mouse hover shows the
  controls; they hide after 4 s. **Minimize**, or dragging the floater's
  centre past a side, tucks it into a tab on that side and closes its live
  view. The tab brings it back. Position, width and the tuck are kept for this
  device. On a touch screen, Full screen replaces **Open in right panel**. A
  narrow chat's notice and a page dialog's **Open in pane** still open the
  panel.

### Profiles and network reach

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

### Agent authority and human input

The built-in [station-browser tools](../../src-server/tools/station-browser-mcp-server.ts)
provide status, open, close, navigate, resize, snapshot, Task Screen capture and
Task clip recording, click, hover, drag,
select, type, press, scroll, color-scheme emulation, wait and evaluation operations through
[browser-agent routes](../../src-server/routes/browser-agent.ts). They require
a verified, bound calling Session, its recorded owner and Project, and current
operator/admin standing. Bearer-exposed or delegated-custody credentials do not
satisfy that caller contract. A tool-supplied Session or Project ID cannot
create authority.

Claude Agents receive `station-browser` in-process unless the Agent switches it
off. With the **Codex browser and device tools** Feature Preview enabled, a
Codex Agent can receive the same registrations through its Session's dynamic
tool stream. On resume, Station accepts persisted tool names only when they are
also in the current authorized catalog; tools added since the thread started
need a new thread. ACP header-token calls remain `caller-not-bound`. See the
[bound-channel decision](../decisions/browser-agent-actions-and-bound-channel.md)
for the protocol and evidence limits.

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
tool. It covers subagents inside the same Session, as the per-tool choice does.
The server-wide choice creates neither an independent per-tool grant nor an
SDK permission rule. If a later engine `init` report revokes the server's
authenticity, even the same browser tool prompts again.
The choice appears only for a call Station can show is the built-in
server's own; a look-alike server never gets it. Besides the name checks, the
engine's own `init` report must list exactly one server called
`station-browser`, with source `sdk` (an in-process server only Station can
register). Agents that author no tool servers keep Claude's MCP discovery
(`.mcp.json`, user config), and which server wins a shared name is decided in
the compiled Claude CLI, which could not be read here, so a missing source, a
second server of that name or a non-`sdk` source means no choice is offered
or honoured. The check is repeated at each `init` the engine sends (how often that is has not been confirmed), and Station does not
turn on strict MCP config to get it. It is offered on the approval
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
The [Browser Agent decision](../decisions/browser-agent-actions-and-bound-channel.md)
describes the proposed cross-engine binding and remaining action slices. Existing
passthrough tokens have not been promoted to bound credentials.

`browser_hover` accepts the same ref, locator or viewport CSS-pixel point as
click. `browser_drag` takes `source` and `target` objects in that shape and sends
a left-button pointer drag with twelve intermediate moves. Both ends must be
visible together; it does not synthesize HTML drag data or transfer files.
`browser_select` takes a ref or locator for a native `<select>` and exactly one
`value` or `label`. It selects one enabled, exact matching option, clears the
other selections and emits `input` and `change`; duplicate matches, disabled
options/optgroups, selects disabled directly or by an ancestor fieldset, and
non-select targets are refused `not-selectable`. The select is hit-tested; a
covering element is refused `obscured` before selection. This Station-owned isolated-world operation does not require
page evaluation permission. Its history records the selection method and text
length, not the chosen value or label.

`browser_color_scheme` accepts `scheme: "light"`, `"dark"` or `"system"`.
It emulates the page's `prefers-color-scheme` media feature; system clears that
override and follows the server browser's preference, not the viewer's Device.
The override survives navigation on that target until changed or the browser
session is reopened. Each human control claim sends a target-local reset to
system through the live-surface binder; reset failures are logged. It is not a
saved profile preference. These four actions are sensitive tools and claim the
same control lease as click. Media history records each request once sent to
CDP, including interrupted or failed requests; the entry does not prove the
requested theme took effect. Other successful actions record their outcome. A
human holder refuses the operation before page-changing steps.

Human input with a current epoch can preempt an Agent; Agents cannot preempt
a live human holder. A human takeover invalidates existing snapshot refs,
including after hand-back. A snapshot taken while a human holds control, or
whose read overlaps any human hold, returns no usable refs, even when the same
human reclaims control without advancing the epoch. A read without a bound
lease also returns no usable refs. These snapshots omit actionable ref labels
from their text. Take a fresh snapshot after hand-back to act
by ref again. Watching needs no control lease. The pane's control line
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

Human live-view input uses a registered source for the lifetime of that viewer's
target and transport. `POST /api/live-surfaces/:surfaceId/lease` accepts
`{action: 'open-input-source'}` and returns `{success: true, data: {sourceId}}`.
Opening requires the authenticated person's current input and control access;
it does not claim the control lease. Input batches may carry that `sourceId`
alongside `epoch` and `events`. The host checks the source's person and device
before claiming control and again at queued dispatch. Legacy batches without a
source remain accepted; current viewers fail closed if registration is
unavailable rather than sending input without teardown protection.

On target/transport change or unmount, the viewer sends
`{action: 'close-input-source', sourceId}` to the same lease route. The host seals
the source before waiting for prior input to settle, then cancels only its held
keys and buttons. Late input from the sealed source is refused; a newer viewer's
press on the same key is preserved. A button changing pointer type first cancels
the displaced gesture, so a mouse press cannot hide a still-held touch. Closing
is not a control-lease release.
The response waits at most ten seconds for cancellation; a failure or timeout
does not establish physical release. Failed cleanup retains the held state and
blocks further input as `surface-wedged` until an authorized whole-surface
neutral cleanup succeeds. An unrelated empty source close does not clear that
fence. Registration is bounded to 128 sources per live-surface entry; opening
also retires idle sources older than five minutes only when they hold no input.
If input is refused because its source is no longer valid, the viewer discards
that input and its queued follow-ups. A new person-initiated action registers a
fresh source; the refused action is never replayed automatically. Replacing the
viewer's transport also reconnects its frame stream under the new transport.
Failed registration is discarded too: another user action may register again
after a refusal or transport failure, without replaying the earlier input.
The existing producer, authority and control contracts still apply.

**Let agents run JavaScript in this Project's pages** (**Settings → Advanced →
Browser & devices**) is off by
default and is a separate permission from ordinary read/click/type tools. A
person with operator or Project-admin authority can change it; Agent-originated
requests cannot. Enabled scripts act with the page's privileges and may keep
running after the tool call ends. Even without evaluation, dynamic pages can
move targets between checking and input. Do not treat a tool response or a
screenshot as independent verification of the application under test.

### Capture a Screen for Task review

`browser_capture_to_task {browserSessionId?, label?}` saves the viewport in the
calling Session's bound Task. It is a sensitive `station-browser` tool, with
the same approval prompt and bound-caller requirements as `browser_snapshot`.
The Task comes from the execution binding; arguments cannot select a Task.
Omit the browser selector only when exactly one live session is available in
the caller's Project profile. The reply includes `{captureId, commit, digest}`
and an image content block so the Agent sees the captured pixels.

The [capture service](../../src-server/services/projects/task-browser-capture.ts)
checks the Task workspace before and after the screenshot. Commit changes
first: dirty or untracked files cause `workspace-changed`. Gitlinks cause
`workspace-unobservable` because the hardened pin does not inspect submodule
contents. An unavailable workspace is also unobservable. A changed commit,
workspace or browser generation during capture is refused. This observation
does not lock workspace writers or prove the page was built from that commit.

The person API requires Browser **view** standing for the session and paired
`orchestration:operate` scope to persist the Screen:
`POST /api/tasks/:taskId/review/captures` takes
`{sourceKind:'browser', sourceSessionId, label?, operationId?}`.
`GET /api/tasks/:taskId/review/capture-sessions` lists live sessions the person
may view in that Task's Project. Choose **Capture** beside **Screens** in
**Task → Review** to open the picker. Entries show the URL host and a short
page path; local files show their filename. A malformed URL is shown as an
unavailable page. Enable the **Task review** feature preview in
[Settings](../user/settings.md#feature-previews) first. Supply a stable operation ID for retries; when
omitted, each request creates a new capture.

The picker, capture eligibility and bound Agent Task check resolve the Task's
stored Project slug or ID through the current Project registry with
`localProjectIdFor`. Browser standing and sessions use the resulting opaque
Project ID; the persisted Task review scope keeps the Task's stored identity.

Captures appear as Screen items in `GET /review` and on the Task Overview
Timeline while the Task review preview is enabled. The latest 12 appear first;
choose **Show more** for older Screens. Select a Timeline thumbnail to open its
Screen in Review. Region anchors use normalized
rectangles validated by the review contract. Image bytes live outside Project
roots in `<STATION_HOME>/task-captures/sha256/`; migration 023 stores append-only
metadata scoped to the Task's creation time. Task count and home capacity are
checked before requesting a screenshot; publication rechecks the limits under
their owning locks. A refused metadata write removes only a newly written blob
while holding the home lock, preserving shared digests. Non-HTTP page URLs are
omitted from capture metadata; HTTP URLs omit queries and fragments. The content route
`GET /api/tasks/:taskId/review/captures/:captureId/content` reauthorizes the Task,
verifies the SHA-256 digest, and serves an explicit image Content-Type with
`X-Content-Type-Options: nosniff`. Another Task's capture returns 404.

Refusals include `caller-not-bound`, `no_task_binding`, `workspace-changed`,
`workspace-unobservable`, `screenshot-too-large`, `capture-limit`,
`capture-home-limit`, `capture-unavailable` and `capture-corrupt`. Screenshots
use the registry's 16 MiB limit and PNG/JPEG fallback. Capture records are kept
for this increment; there is no reclaim/delete API.

### Record a Task walkthrough

`browser_record_to_task {durationMs, browserSessionId?, label?, maxBytes?}`
is a sensitive `station-browser` tool for the bound lead Session. It records
the selected Browser viewport into that Session's Task, with a clean workspace
commit. The duration is 1–30,000 ms and the encoded-video limit is at most
16 MiB. FFmpeg and the **Walkthroughs** preview are required. The caller,
Browser, Task and workspace are rechecked before publication. The returned
Walkthrough ID and commit identify the retained clip, not proof that the page
was built from the commit. If no fresh image arrives, the clip uses the last
image cached when recording began; that image may predate the clip.

Cancelling the tool call, closing its Browser or stopping Station cancels an
in-progress recording and removes its staged files. No clip is published.

With **Task review** and **Walkthroughs** enabled, a person can open the clip
from **Review → Screens**. Video bytes are requested only when the player opens;
Task-scoped reads repeat authorization. See [Task clips](../guides/walkthroughs.md#record-a-task-clip)
for storage, bounds and verification limits.

### Page dialogs, console, screenshots and new windows

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

With the **Browser artifacts** Feature Preview enabled, the **Network**
drawer shows requests for the current browser generation, starting when the
drawer or agent tool first reads it. Filter it to failed requests or XHR and
Fetch requests. Station keeps at most 500 entries
in memory and discards them when capture stops. It records request method,
redacted URL, resource type, status, transfer size and duration; it does not
retain request or response bodies or headers. URL credentials, query values
and fragments are removed. The read-only `browser_network` agent tool uses
Browser authority and **Let agents run JavaScript in this Project's pages**
(`browserEvaluate`), and returns
bounded pages of the same metadata.

With the same preview enabled, **Annotate** in **⋯** opens Select, Box, Draw
and Erase tools over the streamed page. S, B, D and E select them; Escape
cancels and Enter attaches. Select inspects an element on the server. Selecting
elements inside iframes, including same-origin iframes, is not supported. Box and
Draw marks use target viewport coordinates at the current zoom; Erase removes a mark under the
pointer. Changing zoom during capture refuses the annotation. Opening annotation captures a target viewport screenshot before marks
can be made. Select is refused if the page scrolls away from the captured viewport. Attach sends an image and a JSON description to the active chat's
composer. A selected element supplies its target PNG crop; marks also include
the viewport screenshot captured on opening. Marks are described in JSON, not
burned into the image. The files must be supported by the conversation's engine. The
description and image can expose page content; attaching is an explicit share.
The picker redacts URL credentials, queries and fragments in URL-bearing attributes and known secret patterns in `data-*` values. This is a
bounded heuristic, not a guarantee that an image or excerpt contains no secrets.

**Screenshot** (in **⋯**) captures the page's viewport as PNG (JPEG over
16 MiB, refused beyond that) with view standing, one capture at a time per
session (a second request joins the one in flight), and offers **Save image**
and, where the viewer's clipboard accepts PNGs, **Copy image**. With Browser
artifacts enabled, **Attach to chat** adds it to the active composer.

With **Browser artifacts** enabled, **⋯ → Capture → Record** starts a
silent Browser clip. The indicator stays visible while capturing; **Stop
recording** finishes it, and **Save clip** downloads a WebM. Capture also stops
at 30 seconds, 300 frames or 64 MiB of raw JPEGs and encodes the frames captured so far. A first frame over the byte limit is refused. The encoded
clip is limited to 16 MiB. Human and Task Browser recording share a limit of four active recordings, with at most two for one owner; completed clips do not occupy those slots. FFmpeg must already be available through Station's
media-tools resolver. A missing tool refuses the recording; downloading one
requires the operator's separate consent. The clip may contain sensitive page
content. **Attach frames to chat** stages four time-sampled JPEGs and a provenance JSON file in the active conversation. The files are bounded to 5 MiB combined; if sampled frames cannot be prepared, save the full clip instead. If the active conversation is the lead Session of a Task, the Task is accessible and its workspace is clean at recording start, **Add to Task clips** publishes the clip after rechecking the Task, Browser and workspace. A dirty or inaccessible Task shows a reason instead.

The server rechecks Browser view authority, preview state and session generation
periodically while capturing, on stop and before returning a clip. Navigation can continue while the Browser generation remains the same. Closing the Browser surface or
stopping Station cancels in-progress work. The server retains up to four completed results for at most one minute; an
older result may be discarded sooner. The open viewer owns the downloaded Blob until
it is dismissed. Generated temporary frame files are removed after encoding or
cancellation. A process crash can leave its private temporary staging directory;
automatic crash cleanup is not currently provided.

A workspace Browser pane keeps an ordered set of up to twelve session tabs.
Select a tab to watch its exact server session; arrow keys select adjacent tabs
and Alt+Left/Right reorders them. **New tab** opens a blank session. Closing a
tab closes that server session; **Reopen tab** creates a new session from its
last recorded, redacted URL. It does not restore POST data, secrets removed from
the recorded URL, page history or the closed session's authority. The last tab
can be ended through **Close session**.

A `target=_blank` link or `window.open` is admitted as its actual Chromium
target, with a separate session in the opener's Project/profile and an opener
reference. Its original request continues without replaying a GET in the
opener. The pane discovers admitted popups and selects their tabs. Selecting a
tab does not change an Agent tool's explicit session target. Empty popups that
never provide a URL, disallowed URLs and popups beyond the profile's twelve
live/opening-session bound are closed. Browser policy still denies unsupported
navigation and Station's own listeners; popup adoption does not grant network
or Agent authority.

The human address field accepts search text using DuckDuckGo. URL-shaped input
continues through the strict server URL policy; Agent URLs retain that policy
without search inference. Back/forward availability comes from the live browser's
navigation history, with its generation. **Stop loading**, **Reload without
cache** (both under **⋯ → Session**), and **Rotate** (under **⋯ → View**) are
available in the actions menu. Tab titles
are bounded observations from Chromium, rather than app or security identity.

The next two paragraphs record the toolbar layout and the 390px check made
before the chrome moved into the grouped **⋯** menu; the
[guide](../guides/browser-workspace.md) describes the current layout. The pane's chrome was one row: the address field (host and path, with back,
forward and reload inside it), the driver chip, **Console** (with a count of
errors not yet seen), and **⋯**, which holds Screenshot (Mod+Shift+S),
Viewport, Sessions, Agent access, Local servers and, last, Close session. On
a coarse pointer or a window up to 768px wide every control is at least 44px
and the row does not wrap; the path gives way first, then the host. The 390px
check below found no control under 44px.

On narrow screens, editing the address hides its navigation buttons until
editing ends, leaving room for the URL. Back and forward occupy space on a fine
pointer only while the toolbar is hovered or focused. Touch takeover hints say
**Tap**. Why input did not take effect is a slim banner over the top of the page
(one line, or two on a narrow phone; never cut off).
**Retry** is offered only for input the host refused before dispatching any of
it (`surface-busy`). It is sent once, at the control epoch it was meant for,
and only while this viewer may still send input. A change of control drops it,
and so does new input after the kept gesture ends. A kept tap's release joins
it instead of going out alone. Any other failure (a dispatch error or timeout,
or a lost response) may already have applied, so the line says the input "may
not have reached the page" and nothing is sent again. A second finger's lift,
or a lift after control changed hands, is not a failure. The console scrolls within its share of the pane; it does not force the
live page beneath the dock. On the standalone Browser route, the page frame
passes its available height through to both views. The actions menu fits between
the current toolbar/banner stack and the dock, with its own scroll when needed.
Very short panes scroll internally so the console retains readable rows and the
page remains reachable. Escape cancels an unsubmitted address and restores the
committed URL; leaving the field restores navigation while retaining its draft.

### State, evidence and remaining limits

Pane state `2.0` stores the Project ID, selected server session and optional
ordered session IDs. Existing single-session `2.0` records remain valid.
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
replay. Each visible viewer opens its own stream, and the tabs of one browser
hold at most two per origin (shared through Web Locks) so input always has a
connection. A third visible pane waits,
saying so, until one is hidden or closed. Over HTTP/1.1 in a real browser that
kept taps and lease claims arriving within milliseconds while the streams
stayed open (the measurement and its limits are in
[ADR 0018](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md)'s
2026-11-02 amendment). The single multiplexed stream is not built. Native
transports and relays have their own limits and were not qualified; no fixed
frame rate follows from the shared canvas.

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

The tab/navigation and popup-admission changes have service/route and mounted
UI fixture coverage. This Linux host had no installed Chromium, so its real-host
suite skipped; these changes have no new real-browser, mobile or native-shell
receipt. Named/incognito profile management, file transfer, native authentication
handoff, annotations/recordings, document preview and connection admission remain
separate acceptance work under #90. The epic must remain open until its remaining
behavior and platform receipts exist.

### Browser experience preview

Enable **Browser experience** in Feature Previews to try per-tab zoom, page appearance, the Float over chat button, Browser shortcuts, and the agent action overlay. Appearance uses the same browser emulation operation as the agent color-scheme tool. The driver chip opens recent session actions. Screenshot to chat is a separate action that attaches to the active chat for the same Project. Mod+Shift+S opens the screenshot view, including with the preview off or focus in the live page. See [keyboard shortcuts](../guides/keyboard-shortcuts.md#browser-shortcuts). Find in page is not currently supported on the streamed host.

A current device paired by the operator can view Browser sessions and agent reveals within its granted scope. With Browser artifacts enabled, viewing includes element picking, which reads attributes and selected computed styles; Station redacts the attribute excerpt. It also includes bounded, redacted network metadata without request or response headers or bodies. The Browser access response identifies this standing as `operator-device`, separately from `operator` and `project-admin`. Viewing does not grant drive authority; an operator or Project administrator must have the separate authority and scope needed to control a session. A stale credential or missing Project standing is reported in the pane.

## Devices

The Device pane lists simulators/emulators on the selected Station's device
hosts and can open a shared live view with human input. It uses the same
[live-surface contract](../architecture/module-map.md#shared-live-surface) as the
[Browser pane](../guides/browser-workspace.md), with a device-specific producer and access
policy. A separate single-frame capture API remains available; its result is
a timestamped screenshot, not a claim that a live session exists.

This guide describes current code, replacing the earlier capture-only slice of
[#1967](https://github.com/kontourai/station/issues/1967). Physical device/app,
remote-host and release qualification require their own receipts. A visible
screen alone does not identify the foreground application or its build.

### Configure a device host

Use a personal Station instance. Hosted tenant runtimes do not mount the device
routes. Install the platform prerequisites on the device host: Xcode and the
chosen simulator runtime for iOS, or Android SDK/emulator tooling and an image
for Android. This inventory is for simulators/emulators; do not infer physical
phone support from it.

Device tools need Node.js 24 or later with npm on the device host. Station
first tries the first executable `node` on Station's PATH, following
version-manager shims to that installation, and uses only the npm inside that
installation; a later PATH entry cannot supply it. When that Node is missing,
too old or has no npm, Station uses the Node.js it is running on. A prebuilt
archive's `runtime/` carries the pinned distribution's own npm
([archive staging](../../scripts/lib/portable-server-archive.mjs)), so an
archive install needs no other Node.js or npm, as a service or a foreground
`station start`. npm and the device hub run with the same absolute Node path.
The user's PATH is preserved exactly. The desktop's private Node still runs
Station's bundled services and is never used for device tools.

If neither offers a usable Node with npm (an archive built before its runtime
carried npm, or the desktop app without a Node on PATH), setup asks to update
Station first, then to install Node.js with npm.
An installed helper stays blocked until **Check again** succeeds; it does not
enter a crash/restart loop. Restart Station after changing its inherited PATH.
An independently configured helper keeps its own prerequisites and lifecycle.

The operator can enable Station's managed device helper through the Device
setup UI. The [toolchain service](../../src-server/services/devices/toolchain/device-toolchain-service.ts)
records consent, installs its pinned helper and starts a supervised process.
Later use can start an already-enabled helper on demand. The current pins and
integrity records live in the toolchain source; a setup response is not proof
that every platform prerequisite is ready. Disabling the managed helper stops
it and withdraws that choice while retaining its installed files.

An explicitly configured **Device helper URL** overrides the managed helper.
The setting resolves stored Station configuration before the
`STATION_MOBILE_DEVICE_HUB_URL` environment fallback. For an independently
managed helper, use an admitted numeric-loopback origin, for example:

```sh
export STATION_MOBILE_DEVICE_HUB_URL=http://127.0.0.1:43871
```

The configured endpoint admits only an exact `http://127.0.0.1:<port>` origin;
hostnames, paths, credentials, queries, fragments and reserved ports are refused.
Configuration is captured when these runtime services are composed; changing a
setting does not prove the running service has adopted it. Restart the same
owned instance to apply a different helper endpoint. Keep an external helper's
private dashboard and shell routes off the network; Station does not own that
external process's lifecycle.

Operator-managed SSH device hosts also have current implementations:
[host routes](../../src-server/routes/device-hosts.ts) register a host, check its
connection, and separately enable/start its helper. They are not Station Device
pairing. A registered address alone is not installation consent or proof that a
remote simulator works. The
[host registry](../../src-server/services/devices/hosts/device-host-registry.ts)
and resolver carry the host identity into inventory, sessions, tools and shares.
The viewer talks to its selected Station, never directly to the helper's loopback
URL. Remote platform receipts remain separate from these source/fixture claims.

### View, control and end a session

Open **Device** from a region's pane chooser, select a host and exact device,
then start a stopped device or open its live session. Startup can return a
`starting` state while inventory polling waits for the booted target; acceptance
is not completed boot. The current
[pane](../../src-ui/src/workspace-panes/DeviceWorkspacePane.tsx) renders a
`LiveSurfaceCanvas`, controller and input status, and device tools. Its bounded
selection state does not persist captured image bytes or control authority.
The canvas asks for frames no larger than the pane's size in device pixels,
rounded up in 320-pixel steps so resizing within a step keeps the stream. On a
metered or data-saving connection it asks for at most 5 frames per second at
quality 50 and 960 pixels on each side. See the
[stream budget](../../src-ui/src/live-surface/liveSurfaceStreamBudget.ts).

Zoom, full screen and the floater work for a device as they do for a browser;
see [viewing a live surface](#viewing-a-live-surface-zoom-full-screen-and-the-chat-floater).
In full screen a device screen is fitted at its own aspect and orientation,
or, for a foldable with **Rotate picture to fit** on, turned a quarter to fill
a portrait screen. A browser fitted to its pane fits again on entering and
leaving full screen.

Devices belong to the operator. An active admin/owner of a Project may view or
drive only devices shared with that Project, on the named host. Android shares
resolve to AVD identity rather than treating a reusable emulator serial as a
permanent grant. Starting a shared device uses drive authorization; powering it
off and ending a session for everyone are operator operations. Membership,
shares, current request credentials and the route's pairing scope all matter.
[Device access](../../src-server/services/devices/device-access.ts) and
[session routes](../../src-server/routes/mobile-device.ts) own those checks.

The [producer](../../src-server/services/devices/device-live-surface-producer.ts)
separates video and input liveness. iOS video uses MJPEG. Android video goes
to a browser that can decode it (a Station on loopback, a secure context with
WebCodecs, and the stream's profile) as H.264, decoded on the viewer's
machine; a viewer that cannot keep up is switched to images. The viewer does
not show the codec; its root element carries it as `data-codec` for
diagnostics. Other viewers get server-side H.264
decoding when a decoder is available; otherwise a PNG screenshot-poll
fallback, reported as such. The server decoder runs only while such a viewer
is open. The decoder uses host ffmpeg even without ffprobe,
or the pinned ffmpeg already acquired through `station media-tools download --yes`.
Existing decoding stays available with both Feature Previews off. Downloading
missing tools requires enabling Walkthroughs or Local speech in Settings →
Advanced → Feature previews and explicit consent. Resolution never downloads;
see [local speech and media tools](../guides/local-speech.md). Controls reflect input-channel status independently
of the most recent frame. A successful input write proves only that the hub
socket accepted bytes, not that the device applied the gesture.

Human input follows the shared control lease and stale-epoch/fence checks.
The station-control `device_*` tools admit a bound, verified agent Session with
its recorded owner and Project, except a Session whose network Station
restricts ([`confinedNetwork`](config.md#optional-fields)): it is not given
the tools, and the device-agent route refuses it (`device-network-restricted`,
#4769). The operator may use local devices; active
Project admins/owners remain limited to devices shared with that Project. Every
call rechecks this authority and requires the operator to enable agent device
access in **Settings → Advanced → Browser & devices**. Disabling that opt-in also revokes existing surface grants. The in-process device grant targets one host/device
and cannot be supplied in tool arguments. See the
[device Agent control decision](../decisions/device-agent-control.md).

`device_list` lists accessible local and configured SSH-host devices and sessions opened by this
conversation. `device_open` starts a stopped device asynchronously (a `starting`
answer is not completed boot) or opens/joins its live session. Android boots can
change the device ID from AVD name to emulator serial: list again and select
the running row. `device_open` accepts an optional `hostId` (default `local`)
and never falls back to a different host. Open joins a running session without
claiming input, including while a person holds control.

By default a successful live open publishes a bounded, ten-minute reveal intent
for the calling principal, Project and conversation. `reveal: false` opens in
the background. Repeated opens reuse that intent. The active matching chat polls
for new intents and opens/reuses the canonical Device pane, subject to current
Station authority and device view access. The operator’s own current paired Device may receive reveal intents within its granted scope, without gaining Device drive or administration authority. Explicit intents survive an initial
poll failure; opening an existing session by itself creates no historical reveal.
A bounded, authority/Project/conversation-scoped in-memory history remembers
handled intents across chat remounts in the same tab, preserving dismissals.
Reloading the app clears this presentation history; an unexpired explicit intent
can then be shown again.
Navigation away, ended sessions, revoked Agent access or credentials, removed
hosts and revoked device shares prevent delivery. Starting a device alone does
not enqueue a live reveal: list and open its running target after boot.

The tool returns `revealRequested` separately from `paneRevealed: false`:
queuing a request cannot prove that a viewer displayed it. A refusal or absent
viewer leaves the existing session available through Device. Reveal acquires no
input lease.

`device_input` sends bounded typed pointer, text and key events through the
existing allowlisted producer, never a shell command. It claims only an
unclaimed lease or renews its own; a human or another agent holding control
refuses the action. Human takeover interrupts queued input and the producer
checks the fence before each send. The grant is rechecked before each event
in a batch. Concurrent calls from the same agent retain their shared control
until the last call finishes; it releases in `finally`. Opening or observing a
device does not leave an idle agent blocking the human Tools drawer. Input
responses carry the lease after completion/release; it may still name the agent
if another concurrent call remains active.

Complete pointer/key gestures within one batch: send down/move/up or key down/up
together. Unmatched presses/releases return `incomplete-gesture` before any event
is sent. Cross-call holds, drags and held keys are unsupported, and this API has
no wait/duration event for a timed long press. Unsupported input kinds are also
refused for the whole batch before delivery. Concurrent input batches run in
sequence so their pointer/key events cannot interleave; observations can overlap.
A dispatch failure releases control immediately to cancel uncertain held input
and can interrupt other operations sharing that fence. `device_snapshot` reads the bounded
accessibility tree; `device_screenshot` returns PNG through the existing capture
service (maximum 8 MiB, validated dimensions). Both require the agent lease and
recheck authority and the fence before publishing. An accepted socket write is
not proof the device applied it.

`device_close` requires current operator standing and ends only a session this
conversation created. It ends that shared session for everyone, leaves the device
running, and refuses while another controller holds it. Project admins cannot
end a shared session. Operator standing is checked before a close can claim
control or renew idle grace. Joining a human-opened session does not transfer
ownership. Successful agent operations renew an
unwatched session's idle grace. Remote operations use the selected host's
session, capture and accessibility services with the same ownership ledger and
lease; host removal or replacement invalidates existing grants. Agent shutdown
is not included.

Claude's in-process tools and the preview Codex dynamic-tool channel can carry
bound assurance. Codex requires the **Codex browser and device tools** Feature
Preview and an Agent with the built-in Station Control source. ACP
`http-header-token` calls remain `caller-not-bound`; a stdio connection with no
verified caller is refused as `caller-required`. Tool visibility grants no authority. The separate toolchain
**Agent access** setting is the explicit operator opt-in for both managed
agent-device tooling and these live tools. It does not put external CLI commands
under the shared lease.

Closing or hiding a pane detaches that viewer. The
[session service](../../src-server/services/devices/device-session-service.ts)
ends an unwatched device session after a ten-minute grace by default; the device
continues running. **End for everyone** unregisters the session for every viewer;
powering off is a separate action. An observed stopped device or supervised
helper exit also ends its sessions. An external helper does not emit the same
exit signal, and an unavailable inventory is not proof that a device stopped.
Browser sessions have different lifetime rules, so do not apply this
device idle timeout to a Browser pane.

### Install and inspect an app

With **Device developer loop** enabled, **⋯ → Apps** accepts an iOS
simulator `.app` under the Project workspace, a ZIP containing one `.app`, or
an Android APK upload or Project-relative path. The workspace root and each
path component must be free of symlinks; use the canonical Project path (on
macOS, `/private/tmp` rather than the `/tmp` symlink). Windows workspace
snapshots currently refuse; an upload is the available intake path there.
Archive traversal, symlinks, collisions, excess size and incompatible platform,
ABI or minimum OS are refused. Staging is bounded and its Project-scoped handle
expires; staging alone does not establish compatibility or installation. Each Project has its own staging quota, with a 512 MiB host-wide stored-byte ceiling and at most four concurrent install copies; uploads must finish within ten minutes.

Station checks the artifact on the selected host, rechecks Project and device
authority immediately before installation, and verifies the installed app ID,
version and build afterward. The receipt includes the SHA-256 digest, platform,
ABI and source; revision remains `null` when it cannot be established. A lost
connection or takeover after installation starts reports an unknown effect:
check the device before retrying. Local and enabled SSH hosts use fixed
`simctl` or `adb` vectors on that host, never a generic shell or local fallback.

The App section can launch, terminate, or open a URL. Launch and URL actions
report only that the requested app was observed in the foreground; they do not
prove URL delivery. Android permits HTTP and HTTPS, plus schemes found in the installed app's intent filters. iOS permits schemes declared by the target app in its installation receipt; an unobserved scheme is refused. Telephone, SMS, mail, preferences and web-search schemes are refused. iOS can show a first-use confirmation, in which case Station
reports the unconfirmed postcondition until the person acts. Termination checks
that the app process is absent. The agent equivalents are `device_install_app`
(with exactly one of `workspacePath` or a staged `artifactHandle`),
`device_launch_app`, `device_terminate_app`, and `device_open_url`. Each claims
the input lease for its operation and refuses while a person controls it.

**Action history** shows at most 100 entries for the open session. It records
agent operations and person-initiated Tools actions as action names and outcomes,
without input text, URLs or notification payloads. It is in memory and ends with
the session; it is not a complete device audit or a record of every human touch.
**Save reproduction to Task** stores a JSON attachment in the Task room with the
selected app's bounded log sample, screenshot, device identity, available install
receipt and session history. If the app has stopped, the bundle records that state instead of refusing the capture. Log samples pass through secret redaction, but the screenshot and logs may still contain private data.
If publication cannot be confirmed, check the Task before retrying.

With the preview on and a chat floater available, closing the Device stage,
closing its tab, or hiding its visible region requests a host-qualified float.
The floater still checks current access and session availability.

### Capture a device Screen to a Task

In Task Review, **Capture** lists accessible Device sessions alongside Browser
sessions. Select the named host and device to save a Screen to that Task.
Station checks the Task's Project and the device's current access before
publishing; a removed host or ended session cannot provide a capture.

A bound agent can call station-control `device_capture_to_task` with the
`deviceSessionId` returned by `device_open` and an optional `label` (120
characters maximum). The route derives the Task from that Session's current
lead binding; the tool accepts no Task id. It uses the existing `DEVICE_AGENT`
policy, Agent access opt-in, Project standing and shared-device authorization.
It is a mutating tool and is not on the auto-approved bounded-write list.

Commit workspace changes first. Station pins the clean Task workspace before
capturing and re-pins it afterwards. Dirty workspaces or a commit made during
capture return `workspace-changed`; unavailable workspaces or unobserved
submodules return `workspace-unobservable`. Per-Task, home-storage and image
limits use the same capture store as `browser_capture_to_task`, including
`capture-limit`, `capture-home-limit` and `screenshot-too-large` refusals.
For the agent tool, human takeover, source loss or authority changes refuse
publication. Its control lease remains held through publication and is then
released. Person capture rechecks device access and session identity before
publication.

Success returns `captureId`, `commit`, `digest` and the image. The immutable
Screen is available in Review and in the Overview **Timeline** while the
existing **Task review** feature preview (`task-review`) is enabled. A thumbnail
opens that Screen in Review. The Timeline shows its label, commit and gate
standing from a referencing review reply: verified evidence uses the existing
gate-evaluation verifier; missing or unverifiable evidence says **claimed**.
The gate reference must name the same capture and commit. Thumbnail bytes come
through the Task-authorized capture-content route.

With **Device developer loop** and **Walkthroughs** enabled, use **Record to
Task** (**⋯ → Record**) in the Device pane to select a Task and start a clip.
Stop it with the recording control; Station also stops at 30 seconds. The clip is saved in Task
Review with the host and device and the app observed at the start. A rotated
frame currently refuses the recording. If no fresh image arrives, the clip uses
the last image cached when recording began; that image may predate the clip.
An agent with a Task-bound Session can
use `device_record_to_task` with a duration of up to 30 seconds.

With **Device developer loop** enabled, **⋯ → Logs** can sample logs for
one running app ID. Start or pause the sample and filter the displayed output
by text or level. iOS reads the last five seconds; Android reads up to the last
1,000 logcat lines for the app PID. Station retains at most 1,000 lines and
256 KiB and reports truncation, then checks the PID again before publishing.
Samples can have gaps. `device_logs` provides the same bounded read to an
authorized agent. Agent logs and recording claim the input lease, are refused
while a person controls the device, and hold the lease while running. Both
tools use the selected device host, including an enabled SSH host.

The commit records the observed Task workspace. It does not establish which
build is installed on the device or which app is in the foreground; attach
those receipts separately. Real-device capture and installed-build provenance
require separate verification.

### Single-frame API and SDK

**⋯ → Screenshot** in the live Device pane downloads a PNG of the
selected host and device. A failed capture is shown as an error; a screenshot
does not identify the installed build or foreground app.

- `GET /api/mobile-devices/hosts/local/devices` returns host state,
  `observedAt`, and device ID/platform/name/runtime/booted metadata.
- `POST /api/mobile-devices/hosts/local/devices/{platform}/{deviceId}/capture`
  accepts exactly `{}` and returns a capture ID, target tuple, capture timestamp,
  PNG dimensions, and `pngBase64`. The service re-discovers that exact target
  before capturing. A disappeared or stopped device is a conflict, not a frame.

Alongside the per-device authorization above, inventory uses
`orchestration:read`. Screen capture requires the stronger
existing `terminal:operate` scope because a device screen can expose arbitrary
applications and terminal content. A read-only credential can discover devices
but cannot obtain their screens. The normal runtime authentication and origin
checks apply, and current authorization is checked again before publishing a
capture. All responses use `Cache-Control: no-store`.

```ts
import {
  fetchMobileDeviceInventory,
  captureMobileDevice,
} from '@kontourai/station-sdk/mobile-device';

const projectSlug = 'my-project'; // The active Project for a shared device.
const inventory = await fetchMobileDeviceInventory(apiBase, requestOptions, projectSlug);
// Display the returned device list and let the user select an exact target.
const capture = await captureMobileDevice(apiBase, selectedTarget, requestOptions, projectSlug);
// Render only after decoding the PNG; this is a timestamped snapshot.
const imageUrl = `data:${capture.mimeType};base64,${capture.pngBase64}`;
```

`requestOptions` uses the SDK's existing credential/origin and request-authority
binding. Do not place credentials in URLs or persisted pane state. The SDK
validates returned target identity and capture shape; HTTP refusal status stays
observable through `MobileDeviceRequestError.status` without forwarding helper
error messages. Clear private images when the selected Station/authority changes.

### Failure and lifecycle behavior

The single-frame adapter limits its inventory and screenshot exchanges.
The separate live session and tools paths have their own allowlists and bounds.
It does not forward the viewer's credentials; the managed connection adds its
own private helper secret. It refuses redirects, limits inventory to 256 KiB
and 256 devices, limits PNGs to 8 MiB and 8192 pixels per dimension, and caps
each adapter's concurrent inventory and screenshot lanes at two requests each.
Each request and its streamed body share a 12-second
deadline. A capture includes a fresh inventory exchange followed by capture.

Incomplete platform discovery is `partial`; malformed or unreachable replies
are `unavailable`. Raw helper diagnostics and local host paths are not returned.
Neither an old inventory nor a successfully loaded wrapper establishes a live
screen. The frame identifies the selected device, not the build or foreground
application: record app/build provenance separately from the frame, even when
the Tools drawer can inspect application state.

Use the owning lifecycle action for the resource you intend to stop: viewer,
shared session, device and managed helper are distinct. No physical simulator,
remote host, input effect, relay frame rate or native-client journey was verified
by this documentation audit.

Fixture owners include the [single-frame adapter tests](../../src-server/services/mobile-device/__tests__/mobile-device-host.test.ts),
[session-route tests](../../src-server/routes/__tests__/mobile-device-sessions.routes.test.ts),
and [producer tests](../../src-server/services/devices/__tests__/device-live-surface-producer.test.ts).
They do not replace an application/build-specific device receipt.

The Agent route fixtures cover colliding local/SSH device IDs, host removal,
lease-neutral open and reveal admission. The mounted reveal fixture reaches the
canonical region and Device live surface, checks repeat/dismissal behavior and
stale authority, and sends no control request. These are synthetic receipts.
Artifact installation/lifecycle with build provenance, reproduction bundles,
physical-device and authenticated remote-platform
qualification remain outstanding under #1967/#1970/#1971/#1973; cloud/EAS providers
remain #2373. These epics are not complete on fixture evidence alone.

## Walkthroughs

An imported Walkthrough combines a recording's transcript and selected JPEG frames in
one [manifest](../reference/contracts.md#walkthrough). An agent reads that
manifest and the images; it does not need the recorder's API. Visible pointer
dots or ink stay in the images. The importer does not detect marks or identify
application elements.

Walkthroughs is a **Feature Preview, off by default**. The Station operator
enables **Walkthroughs** in **Settings → Advanced → Feature previews**
(`/settings?view=feature-previews&highlight=feature-previews`). The choice applies
to everyone on this Station and takes effect without a restart. The runtime
owns the preview and binds it beside its shared media acquisition and recognizer
in [local-media-runtime.ts](../../src-server/runtime/bootstrap/local-media-runtime.ts).
Personal-host routes consume these instances through `walkthroughImportDependencies`.
Hosted mounting and published-package behavior remain unverified.

All import, status, list, manifest and image routes refuse while off: HTTP 404,
`success:false`, `code:'feature_preview_disabled'`, `previewId:'walkthroughs'`,
and `settingsPath` as above. The CLI exits nonzero and preserves that explanation.
MCP `list_walkthroughs` and `get_walkthrough` stay advertised: their handlers call
the live gated routes on every call and return `isError:true` with the same
refusal details. A cached tool list grants no permission. The Activity label
only renders existing operations and performs no preview work.

Disabling blocks new requests, processing admission after upload, and publication.
It does not kill an already running child process; a running import finishes its
current processing but fails its publication recheck, removes staging, and records
a failed outcome. Re-enable to inspect that receipt. Completed artifacts remain
stored and become readable again when enabled. There is no persisted work queue:
restart recovery reconciles an interrupted import on its next enabled status read.
Preview state that cannot be read fails closed. Normal Project permissions still
apply while enabled. Promotion needs human narration, platform, resource,
authorization/recovery and usability evidence beyond fixture and synthesized-speech runs.

### Record a Task clip

With Device developer loop and Walkthroughs enabled, a person can record a
Device clip from the Device pane, and a Task-bound agent can use
`device_record_to_task`. The clip records its host, device and app observed at
the start. The agent holds the input lease through recording and publication;
human control prevents its claim. See [Device recording](../guides/mobile-device-workspace.md#capture-a-device-screen-to-a-task).

The Browser pane also offers person-initiated silent WebM recording and chat
frames, described in [Browser workspace](../guides/browser-workspace.md). With an active
Task lead Session, Task access and a clean workspace pinned at recording start,
**Add to Task clips** publishes through the same Task clip store after rechecks.
Human and bound Agent recordings share active admission slots.

With Walkthroughs enabled, a bound lead Session can call the sensitive
`station-browser` tool `browser_record_to_task` with `durationMs` (1–30,000),
and optional `browserSessionId`, `label`, and `maxBytes` (at most 16 MiB). The
Task comes from the verified Session binding, not the arguments. Omitting the
Browser selector requires exactly one eligible live session in the caller's
Project profile. FFmpeg must be available through the media-tools resolver.

The recorder pins a clean Task workspace and its commit, consumes Browser
screencast frames, and encodes a silent WebM. It checks the workspace, Browser
generation, caller, Task and preview again before publication. Dirty workspaces,
unobservable submodules, changed authority, unavailable media tools, excess
bytes or exhausted recording capacity refuse the operation. The shared recorder
admits at most four active Browser and Device recordings per Station, with at
most two per person (an Agent's recordings count against the person it acts
for); finished clips do not count. A commit pin does not prove the displayed
page was built from that commit. The manifest retains the commit, recording
digest and byte length, and up to ten selected frames; audio and transcript
coverage are absent.

Cancelling the recording request, closing its Browser surface, or stopping
Station cancels an in-progress capture or encoding. The recorder releases its
viewer, stops and waits for FFmpeg, and removes staging before cancellation
finishes. A cancelled recording is not published. Station bounds its cleanup
waits and reports a shutdown failure if cleanup cannot finish.

Task clips live under the Project's private `walkthroughs/.task-clips/` tree,
scoped to Project, Task and Task creation time. They do not appear in the
Project import list. Task Review authorization and the live Walkthroughs preview
are checked on list, manifest, frame and video reads; another Task's clip is not
found. There is no Task clip deletion route in this increment.

Enable **Task review** as well to open **Task → Review → Screens**. Each clip
shows its label, commit and duration. **Show more clips** loads another page;
opening a clip reads its video, and closing it releases the video and object URL.
The Review tab does not add comments to clips. The
[Task Review API](../reference/api.md#task-review-threads) describes the read
routes; [Browser workspace](../guides/browser-workspace.md#record-a-task-walkthrough)
describes the Agent tool's authority.

### Import and read

Enable the preview, then use a running Station target and its normal CLI authentication.
Download missing tools once, with explicit consent:

```bash
station media-tools status
station media-tools download --yes
station walkthrough import review.mp4 --project my-project
station walkthrough list --project my-project
station walkthrough show <id> --project my-project
```

Import prints a request UUID on stderr, follows the operation, and prints the
Walkthrough id on stdout after success. The CLI waits up to 45 minutes; a
client disconnect does not cancel an admitted import. List prints one bounded
page as JSON; pass `--cursor=<nextCursor>` for more. Show prints the manifest.

Missing tools or models refuse the import with their reason and download list.
For a consent-required result, the remedy is `station media-tools download
--yes`, then a new import. Unsupported platforms
report their platform. A transcription failure is a failed import. A video
without an audio stream imports with transcript coverage `absent`; an engine
that ran and heard no speech reports `present` with no transcript events.

Project `drive` admits imports, and `view` admits reads. These currently mean
the operator or an active Project admin/owner, using the same authorizer as
Browser sessions. Every image read repeats authorization. Station-control
`list_walkthroughs` and `get_walkthrough` also enforce the caller's recorded
Project unless the caller is a bound operator. A bearer-exposed connection
(such as Codex's wire MCP transport) does not inherit the operator's standing:
its recorded owner needs active Project admin/owner membership. On a personal
Station this requires Project sharing enabled by deployment configuration or
the [Settings control](../guides/deployment-authentication.md#turn-it-on-from-settings),
and an explicit Project owner grant; see
[Project membership](../design/project-membership.md#current-seams-and-limits).
An agentless raw tool invocation has no verified calling session and is refused.
Their inputs are closed; frame pages contain at most four images, with
`nextCursor` for subsequent pages.
Recording content is untrusted context, including any instructions visible in
speech or screenshots.

### Limits and storage

[WALKTHROUGH_LIMITS](../../packages/contracts/src/walkthrough.ts) owns the
bounds. Imports refuse files above 512 MiB, videos above 30 minutes, and source
dimensions above 16,384 pixels. Each JPEG has at most a 1,280-pixel longest
edge and 512 KiB. Selection keeps at most 120 frames and records both the raw
candidate and kept counts. [Selection decisions](../design/walkthroughs.md#lane-b-decisions)
describe the four signals and ranking. Half the budget reserves even coverage
across the video stream: selection gaps are at most 31 seconds at the 30-minute
limit. Missing decoder output is skipped, so published gaps can be larger.
A recording with no decoded frames fails without publishing a manifest. Video
stream duration bounds frame candidates even when audio outlasts it; container
duration still bounds the transcript. Matroska's video `DURATION` tag supplies
stream duration when its numeric field is absent. Missing video duration triggers
a bounded video-only packet-copy scan even when container duration is known.
If that scan yields no timestamps, selection uses the validated container
duration; missing JPEG output still skips candidates past the video's end.

Uploads require new bytes within 60 seconds and have a two-hour total receive
cap. Client abort removes staging and releases admission. The [composed runtime
body budget](../../src-server/runtime/bootstrap/runtime-http.ts) checks
authentication, principal rate admission and declared size, then passes a lazy
byte-counting stream. Only the two exact media upload POST paths use this stream;
ordinary mutations keep their existing buffered body limits. Walkthrough preview,
Project authority and the importer's two-slot admission run before reading the body.
Refusals send `Connection: close`, half-close the response side, then discard
input for at most one second or 1 MiB plus one socket chunk. At the byte bound,
reads pause until the close deadline. This bounded drain lets a device still
writing receive the refusal body without retaining the upload.
The route still owns streaming to disk, its byte bound and receive deadlines.

The [shared receive owner](../../packages/shared/src/http-upload.ts) configures
both the API and serialized built-UI listeners. Node exposes a server-wide
receive-total cap, configured to two hours (512 MiB requires about
73 KiB/s sustained throughput). Node may stop tracking a request after an early
response, so the per-request deadlines also protect unfinished bodies after a
response finishes. Ordinary requests retain a 300-second total
including header receipt and acquire no new body-idle limit. The receive timer
ends when the parser completes the request or the request transport closes;
an unread completed body does not put a total deadline on a streaming response. The default header
limit stays in place. The replacement total timer fires at its deadline rather
than Node's periodic parser sweep; exact timeout scheduling can therefore differ.
Socket timeout values are left alone, preserving Node's keep-alive timer even
when a refusal races the body's end; separately, `configureHttpKeepAlive` sets
that idle time to 65 seconds on both listeners. The proxy's 60-second idle window covers
receiving the upload; afterward it allows the Walkthrough processing response
up to two hours. The SDK import default is two hours; callers may supply `timeoutMs`.
Processing after upload has a 30-minute budget, with scaled scene/frame deadlines.
A bounded packet-flag probe measures keyframe gaps relative to the video stream's
start time without decoding frames, including the gaps from stream start to the
first keyframe and from the last keyframe to stream end. Every recording first
runs keyframe-only scene decoding with 100 ms per probed keyframe, clamped
between 15 seconds and the total scene budget. Measurements on 30-minute
2880×1800 HEVC recordings took 13.5 seconds for 225 keyframes (8-second GOPs)
and 105 seconds for 1,800 keyframes (1-second GOPs): about 60 ms per keyframe,
with 100 ms allowing contention headroom. Gaps above two seconds then permit
reference-frame decoding using only the remaining scene budget. A deadline
reserves up to one second within its budget for ffmpeg to flush; both passes
retain scene metadata emitted before cutoff. Precise cuts supersede delayed
keyframe-only estimates in the same preceding GOP; uncovered baseline cuts
remain. Other tool callers still fail on timeout without returning partial output.
Reference-frame decoding can still decode every frame for VP8 and
H.264/HEVC without B-frames. Both passes apply a 5 fps/640-pixel filter, so
transitions between sampled frames can still be missed. A failed probe selects
only the cheap pass. If both passes fail, transcript and interval coverage still
select frames. Scene enrichment cannot by itself fail an otherwise valid import.
Both passes share one scaled scene deadline capped at five minutes inside the
processing budget.
Individual JPEG extraction decodes normally.

The [service](../../src-server/services/walkthroughs/walkthrough-service.ts)
stages privately under the Project's `walkthroughs/` directory. Completed
artifacts live at `<STATION_HOME>/projects/<slug>/walkthroughs/<id>/`, with
`manifest.json` and JPEGs. Only a directory rename makes a complete artifact
visible. The service validates the written manifest before publishing it and
removes the temporary original on success or failure. The receipt in
`walkthroughs/.imports/<request-id>.json` persists operation outcome separately
from the prunable Activity ledger. Failure to save the initial receipt marks
the created Activity operation failed and cleans staging.

Two imports may be admitted per service instance, but all narrated imports and
`/api/transcription` share one recognizer. Up to four requests wait FIFO behind
the active recognition; the 15-minute deadline includes queue time. Overflow
returns `busy` to direct dictation. An admitted import waits with exponential
backoff (250 ms to 5 seconds) within its 15-minute transcription budget,
rechecking preview and Project authority before each attempt. Matching in-process request
ids join; a completed id returns its stored receipt. The request id names one
upload, not a content hash: use a fresh UUID for a different file or retry after
failure. Other terminal failures are not retried. Upload cancellation is
honored; cancellation after admission is unsupported. If Station stops,
reading import status reconciles the receipt against the completed manifest;
without one, the operation fails as interrupted. A status read removes that request's hidden staging directory. A crash during
upload, before operation admission, can leave `.pending-<request-id>` with the
source recording; retrying that same id cleans it. Unknown staging directories
are not swept. Check that no import is active before removing one.
Cross-process import deduplication is not claimed.

Processing stays on the host. This module has no network, capture-cloud, or
hosted transcription integration. Agents receive images only through an
explicit read tool call; sharing them onwards is the caller's decision.
Screenshots and transcripts can expose credentials, code or session contents.

### REST and SDK

The routes mount at `/api/projects/:projectSlug/walkthroughs`:

| Method and suffix | Contract |
| --- | --- |
| `POST /import?filename=review.mp4` | Raw video bytes; UUID `x-walkthrough-request-id`; 202 with `{operation, outcome?}` |
| `GET /imports/:requestId` | Account/machine-scoped operation and typed outcome |
| `GET /` | `{items, nextCursor?}`; `limit` 1–50 (default 25), `cursor` from preceding page |
| `GET /:id` | Validated manifest |
| `GET /:id/frames/:frameId` | Bounded `image/jpeg`; file paths are never accepted |

JSON responses use `{success, data}` or `{success:false, error}`. The terminal
outcome is `imported`, `unavailable` (reason plus downloads/platform), or
`failed`. Unavailability marks the operation failed and publishes no artifact.
Phases are `probe`, `transcribe`, `frames`, `write`. View/drive authorization is
rechecked before returning reads and before publication. Missing Projects or
artifacts return 404; denied access 403; invalid metadata 400; oversized uploads
413; capacity/storage failures 503.

The [SDK fetchers](../../packages/sdk/src/client/walkthroughs.ts) own HTTP calls
for CLI and MCP. See the [SDK reference](../reference/sdk.md#walkthroughs).

### Verification limits

[Contract tests](../../packages/contracts/src/__tests__/walkthrough.test.ts)
cover refusal semantics; [selection tests](../../src-server/services/walkthroughs/__tests__/frame-selection.test.ts)
cover word reconstruction and ranking. [Route tests](../../src-server/routes/__tests__/walkthroughs.test.ts)
exercise real storage with fake tools/transcription, including failed and
partial imports. [MCP tests](../../src-server/tools/__tests__/station-control-walkthrough-tools.test.ts)
use real in-process registration, policy, authorization and read storage.
The [video integration test](../../src-server/services/walkthroughs/__tests__/walkthrough-video.integration.test.ts)
skips loudly without host tools; set `STATION_WALKTHROUGH_TEST_FFMPEG_DIR` to
explicit test binaries to run the real FFmpeg pipeline with a timestamped fake
transcriber. Its fake transcript does not qualify recognition quality. A real narrated
Station recording and the shared recognizer are exercised separately during integration;
unsynthesized human accuracy and released-package behavior remain unverified.

The [Task capture route tests](../../src-server/routes/__tests__/browser-agent-capture.test.ts)
exercise real Git, SQLite and FFmpeg with a controlled screencast producer,
including Task isolation and encoded-byte refusal. The Review render journey
uses a seeded clip and real local read routes. Neither proves a live Browser
recording, a provider session, a real device or a released package.
