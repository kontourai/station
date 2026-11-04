# Browser workspace

The Browser pane shows a real Chromium page that runs on your Station host.
You, an Agent and other people with access can watch and drive the same
session. The page does not use your own browser's profile, cookies or
extensions.

Limits, refusal codes, network rules and evidence live in the
[Browser reference](../reference/browser-and-devices.md#browser).

## Before you start

- Use a personal Station and a Project. Hosted Stations do not offer the
  Browser.
- You need to be the Station operator, or an admin or owner of the Project.
  Contributors and viewers cannot open Browser sessions.
- Station uses Chrome, Edge or Chromium if it finds one. Otherwise the
  operator can approve a one-time Chromium download from the pane.

## Open a page

1. Open a **Browser** pane for the Project. An empty pane says **Enter a URL
   or pick a local server**.
2. Type a URL, or plain words to search with DuckDuckGo, or pick a local
   server. The operator shares local servers with a Project in **Settings →
   Advanced → Browser & devices**.
3. Use back, forward and reload beside the address bar. **New tab** opens
   another session; closing a tab closes its session, and **Reopen tab**
   starts a new session at the last address.

Links that open a new window appear as new tabs. A phone-sized viewport
(**⋯ → View → Viewport**) only resizes the page. To test a real app on a
simulator, use the [Device pane](mobile-device-workspace.md).

## Agent authority and human input

The chip beside the address bar shows who is driving: **Agent** or **You**.

- Click or type on the page to take control. An Agent cannot take control
  away from you.
- Choose the chip, then **Hand back to agent** (or **Release control**) when
  you are done.
- Agents use the built-in `station-browser` tools. Every tool except
  `browser_status` asks for approval. In a Claude Session, answer **Allow the
  Station browser for this session** to approve the rest of that Session's
  browser calls at once.
- Agents cannot run JavaScript in your pages until someone allows it with
  **Let agents run JavaScript in this Project's pages** in **Settings →
  Advanced → Browser & devices**. Only allow it for pages you trust.

Codex Agents get the same tools when the **Codex browser and device tools**
Feature Preview is on. See
[Agent tools and approvals](../reference/browser-and-devices.md#agent-authority-and-human-input)
for the full rules.

## The ⋯ menu

Everything except tabs, navigation, the address bar and the driver chip is in
**⋯**:

| Group | Items |
| --- | --- |
| Capture | **Screenshot** (Mod+Shift+S), **Annotate**, **Record** |
| View | **Zoom**, **Appearance**, **Viewport**, **Rotate viewport** |
| Inspect | **Console**, **Network** |
| Session | **Float over chat**, **Reload without cache**, **Stop loading**, **Sessions**, **Browser settings…** |
| (last, on its own) | **Close session** |

Some items need a Feature Preview in **Settings → Advanced → Feature
previews**: **Annotate**, **Record** and **Network** need **Browser
artifacts**; **Zoom**, **Appearance** and **Float over chat** need **Browser
experience**. See [Browser shortcuts](keyboard-shortcuts.md#browser-shortcuts).

The live page also has a corner **Full screen** button, and a pinch zooms your
view without zooming the page. See
[viewing a live surface](../reference/browser-and-devices.md#viewing-a-live-surface-zoom-full-screen-and-the-chat-floater).

- **Screenshot** saves or copies a PNG of the visible page, or attaches it to
  the active chat.
- **Annotate** lets you select an element or draw boxes and marks, then
  attach an image and a JSON description to the chat. Attaching shares what
  is on the page.
- **Record** captures a silent clip of up to 30 seconds. Save it as WebM,
  attach sampled frames to the chat, or add it to a Task.
- **Console** and **Network** show what the current page logged and
  requested. Network keeps no request bodies or headers.

## Capture a Screen for Task review

With the **Task review** preview on, open **Task → Review**, choose
**Capture** beside **Screens**, and pick a Browser session. Commit your
changes first: Station only captures when the Task workspace is clean.

An Agent bound to the Task can call `browser_capture_to_task` instead.
[Capture details and refusals](../reference/browser-and-devices.md#capture-a-screen-for-task-review)
cover storage and limits.

## Record a Task walkthrough

Choose **⋯ → Record**, then **Stop recording**. If the chat is a Task's lead
Session and the Task workspace was clean when you started, **Add to Task
clips** saves the clip to the Task. An Agent can call
`browser_record_to_task`. Both need FFmpeg and the **Walkthroughs** preview.
See [Task clips](walkthroughs.md#record-a-task-clip).

## Profiles and network reach

Each Project has its own browser profile for the operator and for each
Project admin, so cookies and logins stay separate. The operator's profile
can reach local and private addresses. A Project admin's profile can reach
public sites and the local servers the operator shared with the Project.
Station's own ports are always blocked. See
[Profiles and network reach](../reference/browser-and-devices.md#profiles-and-network-reach).

## Page dialogs

When a page shows an alert, confirm or prompt while you are driving, the pane
shows it so you can answer. While an Agent drives, Station answers dialogs
automatically. Agents cannot answer a dialog that is waiting for you.

## Close or reopen a session

Hiding or closing the pane does not stop the page; an Agent may keep working.
Choose **⋯ → Close session** to stop it. If the browser or Station
restarts, the session shows **needs reopen**; reopening starts a fresh browser
for it.

## Troubleshooting

A browser that exits at launch, or starts but does not answer within 30
seconds, is reported as "The browser could not start, or stopped
unexpectedly." Station's log has the reason (`browser: Chromium could not
start`). The sandbox case below has its own message and a **How to fix** link.

### No usable sandbox on Linux

The pane says the Station's Linux host blocks the browser sandbox. Chromium
needs unprivileged user namespaces for its sandbox, and Ubuntu 23.10 and later
refuse them through AppArmor (`kernel.apparmor_restrict_unprivileged_userns =
1`). Chromium then exits at launch with `FATAL ... No usable sandbox!`, and
Station's log records it as `browser: Chromium could not start`. Station does
not run Chromium without its sandbox.

Fix it on the Station machine, not the device you view from. Allow user
namespaces for the browser Station downloads with an AppArmor profile at
`/etc/apparmor.d/station-chromium`:

```text
abi <abi/5.0>,
include <tunables/global>

profile station-chromium @{HOME}/.station/{,instances/*/}browser/chromium/*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  @{exec_path} mr,
  include if exists <local/station-chromium>
}
```

Load it with `sudo apparmor_parser -r /etc/apparmor.d/station-chromium`, then
open the page again. The path globs match every Station instance and Chromium
version, so the profile survives browser updates. `@{HOME}` is AppArmor's
home-directory variable; if your Station home is not `.station` in a home
directory, change the path to match. Prefer this over turning the restriction
off for the whole machine.
