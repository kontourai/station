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
3. Install Node.js 24 or later with npm, on the PATH Station starts with.
4. Open **Device** and follow setup to turn on Station's device helper.
   Restart Station if you change its PATH.

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

## Capture a device Screen to a Task

With the **Task review** preview on, open **Task → Review**, choose
**Capture**, and pick the Device session. Commit your workspace changes first.
An Agent bound to the Task can call `device_capture_to_task`.

A captured Screen records the Task workspace commit. It does not show which
build is installed or which app is in front; record that separately. See
[Task capture details](../reference/browser-and-devices.md#capture-a-device-screen-to-a-task).
