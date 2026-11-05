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
4. Pinch to zoom the view. The corner **Full screen** button fits the device
   screen to yours; tap **⋯** there for Exit, control, the keyboard and the
   device buttons. See
   [viewing a live surface](../reference/browser-and-devices.md#viewing-a-live-surface-zoom-full-screen-and-the-chat-floater).

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

## Foldable devices

A device whose helper reports a hinge carries a `fold` state in its live
surface's stream state: the lit display (`cover` or `inner`), the hinge
angle (0 closed to 180 flat, or null when unknown), the named stand
(`closed`, `open`, `book`, `laptop`, `tent`, or null between stands), the
stands it can be put into, whether a hinge angle can be set, and table mode
when reported. A phone that does not fold has no `fold`; Station never
infers one from a frame's shape.

- **iOS dual-display simulators** (for example an iPhone Duo runtime):
  the managed helper (expo-device-hub 0.19.1) reports the hinge in its
  screen configuration. Every stand, a hinge angle and table mode can be
  set, and a simulator that supports physical orientation can be laid face
  up or down (the hub reports face down as table mode; which way the device
  faces is not otherwise reported, so these are actions, not a toggle).
  Resting on some stands (tent) can leave the cover lit at a half-open angle;
  the view draws whichever display is lit. A `fold` input is settled by the helper's correlated reply, so a
  stand the simulator refused is reported as a failed input, unlike a tap,
  whose success means only that the socket accepted it. Video streams
  the lit display's own panel and switches when the device hands off between
  displays; each frame names its `display`. A helper that refuses panel
  streams falls back to the device's main stream, whose frames carry no
  `display`.
- **Android foldable emulators**: the helper reads the emulator's hinge
  sensor and posture when the input channel connects, and can fold an
  emulator closed or unfold it flat (`closed` and `open` only). Other
  stands and hinge angles are refused before anything is sent. Folding goes
  only through this fold input, under the control lease; the device hub
  proxy refuses it. A fold made
  outside Station (the emulator's own controls) is not observed until the
  input channel reconnects.

The Device pane draws the lit inner display flat with a line at its crease,
which splits the frame's longer side. **3D view** instead bends each half
about the crease under a perspective (shrunk to stay inside its box), and
**Rotate picture to fit** turns a landscape display a quarter to fill a
portrait screen. Both are this viewer's preferences, kept on this device and
never sent to the device. A touch is mapped back through either to the flat
display point under it; touches outside the drawn display send nothing.

The fold controls (stands, a hinge slider, table mode and face up/down) send
`fold` input through the surface's control lease like any other input. The
selected stand is the one the device reports, or the shut or flat state its
hinge plainly reports. The slider moves the drawing while it is dragged,
settles on a stand's angle within six degrees, and sends one angle when
released. The pane's **Full screen** view and the float over chat draw the
same display. Below 480 pixels wide, the full-screen bar is one row (who is
in control, Take or Release, the stand picker, More controls and Exit), and
the other controls are behind More controls.

With no chat open, as on a phone where the dock shows one pane at a time,
**Float in the next chat you open** floats the device in the next chat
opened within two minutes.

`fold` input is also available to bound agents through `device_input`,
under the same lease and authority checks as other input.

The iOS behaviour was checked through Station against an iPhone Duo simulator
(iOS 27.1, hub 0.19.1): the lit display's video and its handoff, every stand,
hinge angle, table mode, face up/down, rotation of the inner display, and
taps on the cover and on both bent halves. Rotation on the cover display and
any Android foldable emulator have only fixture evidence.

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
