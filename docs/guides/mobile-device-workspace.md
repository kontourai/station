# Mobile device workspace

The Device pane lists simulators/emulators on the selected Station's device
hosts and can open a shared live view with human input. It uses the same
[live-surface contract](../architecture/module-map.md#shared-live-surface) as the
[Browser pane](browser-workspace.md), with a device-specific producer and access
policy. A separate single-frame capture API remains available; its result is
a timestamped screenshot, not a claim that a live session exists.

This guide describes current code, replacing the earlier capture-only slice of
[#1967](https://github.com/kontourai/station/issues/1967). Physical device/app,
remote-host and release qualification require their own receipts. A visible
screen alone does not identify the foreground application or its build.

## Configure a device host

Use a personal Station instance. Hosted tenant runtimes do not mount the device
routes. Install the platform prerequisites on the device host: Xcode and the
chosen simulator runtime for iOS, or Android SDK/emulator tooling and an image
for Android. This inventory is for simulators/emulators; do not infer physical
phone support from it.

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

## View, control and end a session

Open **Device** from a region's pane chooser, select a host and exact device,
then start a stopped device or open its live session. Startup can return a
`starting` state while inventory polling waits for the booted target; acceptance
is not completed boot. The current
[pane](../../src-ui/src/workspace-panes/DeviceWorkspacePane.tsx) renders a
`LiveSurfaceCanvas`, controller and input status, and device tools. Its bounded
selection state does not persist captured image bytes or control authority.

Devices belong to the operator. An active admin/owner of a Project may view or
drive only devices shared with that Project, on the named host. Android shares
resolve to AVD identity rather than treating a reusable emulator serial as a
permanent grant. Starting a shared device uses drive authorization; powering it
off and ending a session for everyone are operator operations. Membership,
shares, current request credentials and the route's pairing scope all matter.
[Device access](../../src-server/services/devices/device-access.ts) and
[session routes](../../src-server/routes/mobile-device.ts) own those checks.

The [producer](../../src-server/services/devices/device-live-surface-producer.ts)
separates video and input liveness. iOS video uses MJPEG. Android video uses
server-side H.264 decoding when a decoder is available; otherwise it reports a
PNG screenshot-poll fallback. Controls reflect input-channel status independently
of the most recent frame. A successful input write proves only that the hub
socket accepted bytes, not that the device applied the gesture.

Human input follows the shared control lease and stale-epoch/fence checks.
Device live-surface Agent control is not wired: its authorizer requires a human
request. The separate toolchain **Agent access** setting installs/enables
agent-device tooling; it does not establish an Agent grant to this shared live
surface or prove all tool use participates in the same lease.

Closing or hiding a pane detaches that viewer. The
[session service](../../src-server/services/devices/device-session-service.ts)
ends an unwatched device session after a ten-minute grace by default; the device
continues running. **End for everyone** unregisters the session for every viewer;
powering off is a separate action. An observed stopped device or supervised
helper exit also ends its sessions. An external helper does not emit the same
exit signal, and an unavailable inventory is not proof that a device stopped.
Browser sessions have different lifetime rules, so do not apply this
device idle timeout to a Browser pane.

## Single-frame API and SDK

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

const inventory = await fetchMobileDeviceInventory(apiBase, requestOptions);
// Display the returned device list and let the user select an exact target.
const capture = await captureMobileDevice(apiBase, selectedTarget, requestOptions);
// Render only after decoding the PNG; this is a timestamped snapshot.
const imageUrl = `data:${capture.mimeType};base64,${capture.pngBase64}`;
```

`requestOptions` uses the SDK's existing credential/origin and request-authority
binding. Do not place credentials in URLs or persisted pane state. The SDK
validates returned target identity and capture shape; HTTP refusal status stays
observable through `MobileDeviceRequestError.status` without forwarding helper
error messages. Clear private images when the selected Station/authority changes.

## Failure and lifecycle behavior

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
