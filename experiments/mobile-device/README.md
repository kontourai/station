# Mobile-device hosting experiment

**Status: feasibility experiment, not a shipped Station feature.**

This isolated Tauri executable tests whether a local device hub can display
and control real iOS Simulator and Android Emulator apps in the same desktop
WebView technology Station uses. It has no Station services, commands, or
capabilities and is not registered as a Workspace Pane.

The intended product integration is **web and desktop**. A shared React
Device pane would consume authenticated screen and input transports from a
device-host service. Running a simulator requires a suitable host; viewing
and controlling its stream does not require a desktop client. iOS needs a Mac
with Xcode. Android needs the SDK, an emulator image, and suitable virtualization.
An HTTPS web client must use Station's authenticated HTTPS/WSS transport to
that host, not directly fetch an HTTP loopback hub on the viewer's computer.

## Reproduce the host experiment

Use an isolated simulator/emulator, an explicitly selected device, Node 24,
Rust, and a non-default loopback port. The commands below do not build or
install Station's mobile apps. Supply a simulator `.app` or emulator-compatible
APK separately, and record its actual build identity.

Install the pinned research tools in a separate scratch directory, outside
the Station workspace:

```sh
proof_tools="$(mktemp -d /tmp/station-device-tools.XXXXXX)"
cd "$proof_tools"
printf '%s\n' '{"private":true,"packageManager":"pnpm@11.25.0"}' > package.json
pnpm add --save-exact --ignore-scripts expo-device-hub@0.9.0 agent-device@0.20.10
node node_modules/expo-device-hub/dist/server/cli.mjs \
  --host 127.0.0.1 --port 43871 --transport mjpeg --hide-boot-device
```

Keep the process in an owned terminal. The install omits lifecycle scripts;
WebRTC is not part of this experiment. The hub can still acquire runtime
helpers, including scrcpy, on first use. Do not regard this setup as a
production dependency acquisition or offline-install contract.

Confirm that the hub actually bound the requested port. If it selects another
port because that port is occupied, use its actual port in the browser and host
commands. Open `http://127.0.0.1:43871/` in a browser and select the intended device.
Check an actual app frame and an input-driven transition. A dashboard or
"Live" label alone is insufficient. For iOS, attaching capture to an already
booted simulator uses the hub's `POST /vendor/serve-sim/grid/api/start` with
`{"udid":"<explicit simulator UDID>"}`.

From the Station worktree, compile and run the separate desktop experiment:

```sh
CARGO_TARGET_DIR=/tmp/station-device-target cargo build \
  --locked --manifest-path experiments/mobile-device/tauri-host/Cargo.toml
/tmp/station-device-target/debug/station-mobile-device-host-experiment \
  http://127.0.0.1:43871/
```

The executable accepts only a numeric loopback HTTP URL with an explicit
non-default port. Navigation stays on its initial origin; popups and downloads
are denied. The window has no Tauri capabilities and uses an incognito store.
These source restrictions are not a security audit of the external hub.
The hub exposes host/device operations, including shell-oriented routes: keep
it on loopback and stop it when finished. Do not publish the dashboard or
reverse-proxy its full route surface as a Station feature.

Use `agent-device` with a separate `AGENT_DEVICE_STATE_DIR`, session name, and
explicit `--udid` or `--serial`. Verify app readiness before relying on the
initial semantic snapshot: a live WebView can initially return only its root.
Close owned agent sessions and stop their daemons, the hub, and only the
simulator/emulator this experiment started. Do not shut down another task's
device or shared ADB server.

## Observed result

Local macOS arm64 experiment, 2026-09-12:

| Property | Result | Boundary |
| --- | --- | --- |
| iOS Station screen and pointer input in Chrome | CONFIRMED | iOS 26.5 simulator, existing Station 0.1.10 app; original source SHA unavailable |
| Android Station screen and pointer input in Chrome | CONFIRMED | Android 16 emulator, existing Nightly 0.1.11-nightly.2445.3 / 244503 |
| Both streams and pointer input in Tauri | CONFIRMED | This isolated macOS executable, Tauri 2.11.5; not the Station product shell |
| Semantic automation of both apps | CONFIRMED | agent-device 0.20.10 selected Add a Station address and observed Add Station |
| First-class Device pane in Station | NOT_VERIFIED | No pane, broker, or product integration was added |
| Paired app-to-Station conversation | NOT_VERIFIED | Connection dialogs were exercised; no server pairing or agent response was tested |
| Remote HTTPS/WSS, other desktop hosts, physical devices | NOT_VERIFIED | No remote transport, Windows/Linux runtime, physical device, or distribution claim |

The hub ran with its MJPEG transport preference. Android reported
`grpc-screenshot`, `mmap`, and scrcpy input. This does not establish the H.264
decoder path or its performance. No latency, frame-rate, bandwidth, or resource
benchmark was performed.

## Product integration proposal

1. Add a device-host service with explicit host/device identities, bounded
   lifecycle operations, owned helper processes, and separate view/control
   authority. Keep the raw hub private. Reuse Station's authentication and
   origin handling; do not persist credentials in URLs or pane state.
2. Add a shared React Workspace Pane that renders the approved screen
   transport directly and sends typed input through the service. Keep it
   available in web and desktop. Do not route it through the desktop-only
   local browser-preview capability or require a child WebView.
3. Add tool entry points and artifact installation with revision receipts.
   Reserve control for one session at a time, permit multiple viewers, and
   distinguish closing a pane from shutting down a device.
4. Prove the same journey in web and desktop: open device, install an exact
   app, pair with an isolated Station, create a chat, observe a response,
   disconnect/reconnect, and release owned resources. Then test a remote
   device host, codec fallbacks, rotation, text/IME, and hidden-pane suspension.

Screen transport is distinct from ordinary event streaming: keep existing
SSE for state where appropriate and use a bounded binary/control transport
for frames and low-latency input. The pane should expose missing-host and
missing-toolchain reasons independently from its client platform.

Owning Station seams are
[`BrowserPreviewWorkspacePane`](../../src-ui/src/workspace-panes/BrowserPreviewWorkspacePane.tsx),
the [Workspace Pane registry](../../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx),
[native host policy](../../src-desktop/src/lib.rs), and
[WebSocket authentication](../../src-server/security/websocket-auth.ts).
See the [native proof guide](../../docs/guides/native-shell-verification.md)
for the distinction between an experiment and product/runtime acceptance.
