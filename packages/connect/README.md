# Station connections

Station clients connect to a selected Station. Device grants and account sessions
identify the caller; Project membership controls shared work. A network path does
not grant any of those permissions.

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
the application's existing SDK credential resolver. The package does not install
a second resolver, persist routing secrets, approve keys, mint Device grants, or
create account sessions. Retire the transport and connection when the selected
profile or its authority changes. A reconnect creates a fresh peer and proof.

Broker discovery must never supply trusted signing keys, application origins,
account authority or TURN configuration. Keep routing credentials in their
credential owner, outside saved public profile JSON and ordinary localStorage.
HTTPS is required except for the explicit loopback HTTP development profile.
Requests retain the application channel's 16 KiB pilot body limit; responses use
its bounded, backpressured streaming protocol. This interface is Fetch, not an
arbitrary WebSocket or terminal proxy.

The [self-hosted broker guide](../../docs/guides/self-hosted-broker.md) documents
operator setup. The [free collaboration lab](../../docs/guides/local-collaboration-lab.md)
exercises real browser, broker, Pion and Station application behavior. Fresh
relay-only guest enrollment and native credential transport require their own
supported account/Device flows; a fixture credential is not proof of that journey.
