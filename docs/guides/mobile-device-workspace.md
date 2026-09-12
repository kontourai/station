# Mobile device inspection

**Status:** initial API/SDK slice of [#1967](https://github.com/kontourai/station/issues/1967).
The shared Device pane, managed setup, application installation, input control,
logs/debugging, and paired dogfood qualification are separate tracked slices.
This interface lists simulators/emulators and captures one frame from an already
booted device. It does not claim a live stream or identify the foreground app.

## Configure a device host

Use a personal Station instance. The API is not mounted in hosted tenant
execution, where the operator's local device inventory must not be shared
across tenants. The first adapter supports one explicit local host, named
`local`; the viewer may use web or desktop. Remote-host registration is tracked
in [#1973](https://github.com/kontourai/station/issues/1973).

Install Xcode and an iOS simulator runtime on a Mac, or the Android SDK and a
compatible emulator image on a supported development host. Start the specific
device you intend to inspect and install/launch your application using its
normal development tools. Physical phones are excluded from this API.

Run a separately managed `expo-device-hub@0.9.0` on numeric loopback, using an
available non-default port. The [isolated experiment](../../experiments/mobile-device/README.md)
contains a pinned scratch-directory setup. Verify the port the hub actually
bound; keep its dashboard and shell-oriented routes private. Station does not
install, launch, restart, or stop that external helper in this slice.

Set this server-side environment variable before starting Station:

```sh
export STATION_MOBILE_DEVICE_HUB_URL=http://127.0.0.1:43871
```

Only an exact `http://127.0.0.1:<port>` origin is admitted. Hostnames, alternate
numeric IP syntax, paths, credentials, queries, fragments, default Station
ports and redirects are rejected. Configuration is read at runtime startup;
restart the same owned instance after changing it. An absent or invalid value
produces an explicit unavailable inventory rather than failing Station startup.

The browser connects to the selected Station endpoint using its existing
credentials. It never needs to contact the helper's loopback URL directly.
Consequently an HTTPS viewer can use the ordinary authenticated Station
transport without an HTTP mixed-content dependency on its own machine.

## API and SDK

- `GET /api/mobile-devices/hosts/local/devices` returns host state,
  `observedAt`, and device ID/platform/name/runtime/booted metadata.
- `POST /api/mobile-devices/hosts/local/devices/{platform}/{deviceId}/capture`
  accepts exactly `{}` and returns a capture ID, target tuple, capture timestamp,
  PNG dimensions, and `pngBase64`. The service re-discovers that exact target
  before capturing. A disappeared or stopped device is a conflict, not a frame.

Inventory uses `orchestration:read`. Screen capture requires the stronger
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

The helper exchange allows only the fixed inventory and screenshot paths.
It omits credentials, refuses redirects, limits inventory to 256 KiB and 256
devices, limits PNGs to 8 MiB and 8192 pixels per dimension, and caps concurrent
helper requests at two. Each request and its streamed body share a 12-second
deadline. A capture includes a fresh inventory exchange followed by capture.

Incomplete platform discovery is `partial`; malformed or unreachable replies
are `unavailable`. Raw helper diagnostics and local host paths are not returned.
Neither an old inventory nor a successfully loaded wrapper establishes a live
screen. The frame identifies the selected device, not the build or foreground
application: record app provenance separately until the application lifecycle
slice supplies it.

Stop only the external helper and devices you started when the inspection is
finished. Closing a viewer does not own their lifecycle in this slice.
