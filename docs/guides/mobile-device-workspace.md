# Mobile device workspace

The Device pane shows an iOS simulator or Android emulator running on one of
your Station's device hosts. You and authorized Agents can watch and use the
same screen. This guide covers simulators and emulators, not physical
phones.

Limits, refusal codes, the single-frame API and evidence live in the
[Device reference](../reference/browser-and-devices.md#devices).

## Configure a device host

1. Use a personal Station. Hosted Stations do not offer devices.
2. On the device host, install Xcode with a simulator runtime (iOS) or the
   Android SDK with an emulator image (Android).
3. Open **Device** and follow setup to turn on Station's device helper.
   Station installs it with its own bundled Node.js and npm, so a current
   Station needs no separate Node.js installation.

To use another machine as a device host, add it under **Settings →
Advanced → Device hosts**. See
[host setup details](../reference/browser-and-devices.md#configure-a-device-host).

## View, control and end a session

1. Open **Device** from a region's pane chooser. With devices but none
   running it says **Start a simulator**; with no devices the heading reads
   **Devices**.
2. Choose the host and device, then start it or open its live session.
3. Tap or type on the screen. While you hold control, Agents cannot send
   input. Use **Home**, and **Back** on Android or **Rotate** on iOS.

Everything else is in **⋯**: **Save screenshot**, **Record to Task**, **Logs**,
**Apps**, **Device settings**, **Recents** (Android), **Float over chat** and
**Close**; managers also see **Power off** and **End for everyone**, last.

- **Close** only closes your view. An unwatched session ends after ten
  minutes; the device keeps running.
- **End for everyone** ends the session for every viewer. **Power off** stops
  the device. Only the operator can do either.

## Share a device and give Agents access

Devices belong to the operator. In **Settings → Advanced → Browser & devices**,
**Open device setup** lets the operator:

- share a device with a Project, so that Project's admins and owners can view
  and drive it;
- turn on agent device access, so bound Agents can use the `device_*` tools.

Turning agent access off also revokes Agents' current access. See
[Agent tools](../reference/browser-and-devices.md#view-control-and-end-a-session)
for the full rules.

## Install and run an app

Turn on the **Device developer loop** preview, then open **⋯ → Apps**:

1. Pick an iOS `.app` from the Project workspace, upload a ZIP containing one
   `.app`, or give an Android APK path or upload.
2. Install it. Station checks it on the host and reports the installed app ID,
   version and build.
3. Launch, terminate, or open a URL in the app.

Agents use `device_install_app`, `device_launch_app`, `device_terminate_app`
and `device_open_url`. If a connection drops during an install, check the
device before retrying. See
[Install and inspect an app](../reference/browser-and-devices.md#install-and-inspect-an-app).

## Screenshots, recordings and logs

- **⋯ → Save screenshot** downloads a PNG.
- **⋯ → Record to Task** saves a clip of up to 30 seconds to a Task. It needs the
  **Device developer loop** and **Walkthroughs** previews.
- **⋯ → Logs** samples recent logs for one running app.

## Install and inspect an app

With **Device developer loop** enabled, the Tools drawer accepts an iOS
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

## Capture a device Screen to a Task

With the **Task review** preview on, open **Task → Review**, choose
**Capture**, and pick the Device session. Commit your workspace changes first.
An Agent bound to the Task can call `device_capture_to_task`.

A captured Screen records the Task workspace commit. It does not show which
build is installed or which app is in front; record that separately. See
[Task capture details](../reference/browser-and-devices.md#capture-a-device-screen-to-a-task).
