# Station connections

Station clients connect to a selected Station. Device grants and account sessions
identify the caller; Project membership controls shared work. A network path does
not grant any of those permissions.

## Package and entry points

`@kontourai/station-connect` is currently a **private workspace package** in
[package.json](./package.json), not an advertised standalone npm installation.
Its root and `/health-probe` entries select compiled `dist/` output; other named
entries, including `/connection-trust`, `/device-pairing`,
`/application-channel`, `/application-channel-frames`, `/self-hosted-browser`, `/native-diagnostic-echo` and
`/native-application`,
select TypeScript source. The former `/node-storage` entry is no longer exported.

From a managed Station checkout, `npm run build --prefix packages/connect`
runs TypeScript, copies React CSS and writes the distribution freshness stamp.
The root combines core owners and React components; it is not a React-free
server entry. Consumers still need a toolchain appropriate to the selected
entry and its browser/Node dependencies. Watch output alone does not run the
asset-copy and freshness-stamp steps of the build command.

## Connection and credential ownership

The [root barrel](./src/index.ts) exports `ConnectionStore`,
`ConnectionSupervisor`, `ConnectionHealthCoordinator`, pairing helpers,
`ConnectionsProvider`, connection hooks and UI components. The Station host
composes these with its profile, credential and native transport owners; this
package does not make a reachable server trusted or authorize a Project.

`ConnectionStore` defaults public saved-connection data to localStorage and
browser credentials to sessionStorage. An explicit `storage` adapter is also
the credential fallback unless `credentialStorage` is supplied, so custom
hosts must choose both deliberately. Native Station uses its host-owned
credential broker and secret-free profile projection. The former
`HydratedCredentialStorage` compatibility adapter has been removed; use the
host's current credential/transport integration. See
[storage](./src/core/storage.ts), [ConnectionStore](./src/core/ConnectionStore.ts)
and the [host profile adapter](../../src-ui/src/platform/native/stationProfileStorage.ts).

## Optional native application transport

`@kontourai/station-connect/native-application` exports
`createNativeApplicationTransport`. Its caller supplies host-owned v2 signaling,
approved Station trust with an authoritative recheck, a Station origin and a
lifetime signal. The client verifies the Station proof before applying the
answer and exposes `fetch` and `openChannel` over the reliable ordered
`station-application-v1` DataChannel. It has no direct HTTP fallback and does
not read the routing grant bearer. Device and account credentials remain with
their existing owners. This opt-in library does not activate a saved Desktop
route or establish a packaged native journey.

## Optional self-hosted browser transport

The dedicated `@kontourai/station-connect/self-hosted-browser` entry point provides:

- `SelfHostedBrokerBrowserClient`: bounded signaling with a fixed broker and routing scope.
- `createBrowserPionConnection`: a WebRTC connection admitted against independently approved Station signing trust.
- `createSelfHostedApplicationTransport`: the encrypted Fetch transport for the existing SDK credential owner.

The broker introduces the peers. A TURN relay forwards encrypted traffic. The
selected Station decrypts application requests and applies its normal authorization.
The broker receives neither application frames nor Station/account credentials.

```ts
import {
  SelfHostedBrokerBrowserClient,
  createBrowserPionConnection,
  createSelfHostedApplicationTransport,
} from '@kontourai/station-connect/self-hosted-browser';

// These inputs come from the application's existing enrollment and custody owners.
const broker = new SelfHostedBrokerBrowserClient({
  brokerOrigin,
  browserOrigin: location.origin,
  scope,
  credentials: routingCredentialProvider,
});
const owner = createBrowserPionConnection({
  broker,
  applicationOrigin,
  trustRecord: approvedStationTrust,
  trustStore,
  ice: iceConfigurationProvider,
});
const snapshot = await owner.connect(lifetime.signal);
const transport = createSelfHostedApplicationTransport({
  owner,
  snapshot,
  applicationOrigin,
  signal: lifetime.signal,
});
```

The optional `createConnectionIdentity(signal)` input to
`createBrowserPionConnection` is for a host-owned native signaling adapter. It
returns one closed `{ clientId, nonce }` pair before peer or SDP creation; the
client ID must be the native installation's pinned `clientInstanceId`, and the
nonce must be a fresh canonical 32-byte base64url value. Connect copies and
validates both values once, then uses that exact pair for broker open/read and
Station-proof verification. An invalid, late, or failed provider refuses the
attempt without falling back to browser-generated identity. The callback must
not allocate a broker session or another resource: the connection owner cannot
promise to cancel such an allocation through this public-identity seam. When
the option is omitted, the browser continues to generate its own per-attempt
ID and nonce. Supplying identity does not grant Station, Device, account, or
Project authority.

This is a composition example, not enrollment. Supply the returned transport to
the application's existing SDK credential resolver. Constructing these objects
does not install a resolver, approve keys, mint Device grants or create account
sessions. Retire the transport and connection when the selected profile or its
authority changes. A reconnect creates a fresh peer and proof.

The same subpath separately exports invitation redemption and
`BrowserRoutingGrantCustody`, including an IndexedDB storage implementation.
Those owners can persist routing grants; do not generalize this example into a
claim that the package never stores secrets. Their
[scope and custody checks](./src/core/brokerRouteEnrollment.ts) remain separate
from saved public profiles, Station signing trust and application credentials.

Broker discovery must never supply trusted signing keys, application origins,
account authority or TURN configuration. Keep routing credentials in their
credential owner, outside saved public profile JSON and ordinary localStorage.
HTTPS is required except for the explicit loopback HTTP development profile.
Requests retain the application channel's 16 KiB pilot body limit; responses use
its bounded, backpressured streaming protocol. This interface is Fetch, not an
arbitrary WebSocket or terminal proxy.

An admitted channel owner may supply optional `prepareRequest` to add headers
for that peer's exact request. The adapter keeps the original target/body,
refuses header replacement and closes on cancellation or failed preparation.
See the [Connect reference](../../docs/reference/connect.md#application-channel-request-preparation)
for the copied inputs, bounds and lifetime rules. This does not install a
native signer or enable ordinary UI transport selection.

The [self-hosted broker guide](../../docs/guides/self-hosted-broker.md) documents
operator setup. The [free collaboration lab](../../docs/guides/local-collaboration-lab.md)
exercises real browser, broker, Pion and Station application behavior. Fresh
relay-only guest enrollment and native credential transport require their own
supported account/Device flows; a fixture credential is not proof of that journey.
