# Self-hosted routing broker

Status: bounded source implementation for local qualification. This is not a public listener or a production hosting recommendation.

The current private-file custody implementation is POSIX-only. Windows startup refuses with `self_hosted_broker_private_custody_unavailable_on_windows` until the broker adopts an audited DACL owner; it never falls back to unchecked Windows paths.

The self-hosted broker carries versioned connection metadata only. It never receives Station operator credentials, account credentials, Project data, plugin data, application frames, or execution authority. Station still signs the opaque connection proof and enforces Device, account, and Project policy at the endpoint.

Run `npm run broker:self-hosted -- init /absolute/private-init-config.json` once for a routing generation, then run `npm run broker:self-hosted -- serve /absolute/private-serve-config.json`. The configuration and credential output must be owner-only files in owner-only directories. The database path, credential path, loopback port, and every provisioned Station/enrollment/routing-generation/browser-Origin scope are explicit. A routing generation is independent of Station's connection-signing key generation and cannot rotate or approve endpoint trust. Port `0` requests an owned ephemeral listener; ports 3000 and 3141 are refused.

Initialization and serving use separate private configuration files. Initialization contains exactly one provision record:

```json
{"version":"station-self-hosted-broker/v1","databasePath":"/srv/station-broker/state.sqlite","credentialsPath":"/srv/station-broker/station-a.credentials.json","port":0,"provision":[{"stationId":"station-example","enrollmentId":"enrollment-example","routingGeneration":1,"browserOrigin":"https://station-client.example"}]}
```

Serving points at the same database and provisions nothing:

```json
{"version":"station-self-hosted-broker/v1","databasePath":"/srv/station-broker/state.sqlite","credentialsPath":"/srv/station-broker/unused.json","port":0,"provision":[]}
```

`init` publishes the private credential bundle before committing its hashes to SQLite. A retry reuses only an exact existing bundle for the same scope and routing generation. A conflicting or older routing generation refuses. `serve` never provisions or rotates credentials.

Connector and routing credentials are separate 256-bit secrets. Every request must match the credential direction, Station, enrollment, routing generation, and configured Origin. Browser preflight admits only an active configured Origin and the three required headers. Provisioning leaves a Station `offline`; an authenticated connector registration makes the current routing generation `online` for 30 seconds. `online` describes recent connector registration, not application readiness or permission. Registration is the presence heartbeat; lease renewal is separate. A composed supervisor must refresh both.

This tranche provisions one operator-owned routing credential for one Station and browser Origin. It is not per-Device enrollment or revocation, does not bootstrap an account, and does not complete routine fresh-client onboarding. The connector and optional Pion runtime below consume this routing scope. The broker cannot mint or replace independently approved connection-signing trust.

## Native routing grant foundation (v2)

The broker database upgrades additively from schema v2 to v3. Native invitation
and grant metadata lives in separate tables; existing browser v1 wire records,
Origin checks, and signaling behavior are unchanged. A native surface is
discriminated as `station-native` and binds the app identifier, one of the
actual `dev`, `stable`, `beta`, or `nightly` channels, a client instance UUID,
and a P-256 proof-key thumbprint. The operator must choose that thumbprint from
an independently approved native install key. The descriptive app/channel
fields are bound as metadata; this exchange does not provide OS app attestation.

`POST /broker/v1/native/grants/redeem` accepts only a v2 invitation and an
ES256 compact JWS proof from its bound key. The signed payload uses UTF-8 JSON
with exact property order and binds audience `station-self-hosted-broker`,
purpose `redeem-native-route-invitation`, v2 version, broker origin, Station,
enrollment, routing generation, Station signing-key ID and generation, every
native surface field, invitation ID, the domain-separated SHA-256 digest of the
invitation secret, expiry, and a 32-byte client nonce. The protected header is
exactly `{ "alg": "ES256", "typ": "station-broker-native-redemption+jws" }`.
The secret itself is never copied into the JWS. The server checks the public
key's JWK thumbprint and verifies the signature before consuming the invitation
and publishing a grant in one SQLite transaction. The endpoint refuses
`Origin`, cookies, and browser credentials; those checks do not replace the
signature. The one-use invite secret and key proof authorize only routing.

Native grants can be independently inventoried and revoked by the broker
service, and their stored credential is hashed. Native invitations and grants
are retired with their Station routing generation. V1 redemption rejects v2
invitations, and native-v2 redemption rejects v1 invitations. This foundation
does not enable native signaling, encrypted application traffic, or a native
client; the existing v1 signaling handlers do not read native grant rows.

Connection offers use a caller-chosen client ID and nonce, expire after 30 seconds, and remain replay tombstones for five minutes. Each Station may hold 32 live offers and the broker 1024. Offer and answer SDP are capped at 128 KiB; the opaque Station proof uses its owning 4 KiB contract limit. A connection accepts one answer. Withdrawal and a newer routing generation invalidate pending work without changing Station signing-key trust. Lease renewal uses an explicit revision CAS.

The service binds only to loopback. TLS termination, reverse-proxy hardening, public deployment, production connector lifecycle, and application transport remain later integration work under #1963.

## Connector lifecycle library

`SelfHostedBrokerClient` fixes one configured broker origin and refuses redirects, oversized responses, and response fields outside the v1 contract. `SelfHostedBrokerConnector` serializes registration and renewal separately from one bounded offer-admission loop, so an in-flight peer handshake does not starve lease maintenance. It rechecks current Station/enrollment signing trust around asynchronous answer construction. Withdrawal retires both lanes, including compensation after an unconfirmed registration reply.

`createSelfHostedBrokerPionRuntime` composes that connector with the production Pion adapter and the protected application channel. It captures the exact trusted descriptor per peer, verifies the issued proof, bounds peer ownership, and gates application frames against current trust. Cleanup distinguishes an operational cancellation from confirmed process/file retirement. `StationRuntimeOptions.selfHostedBrokerConnector` is explicit opt-in and requires `virtualApplication`; startup waits for protected application activation, and broker cleanup participates in ordinary runtime shutdown without stranding the other services.

The dedicated `@kontourai/station-connect/self-hosted-browser` entry point supplies the corresponding browser signaling, verified peer and encrypted Fetch transport. Its caller owns independently approved signing trust, routing-credential custody, ICE configuration, Device credentials and account continuations. It does not install a second SDK resolver or silently fall back to HTTP. See the [connection package](../../packages/connect/README.md) and the [free broker lab](local-collaboration-lab.md#separate-self-hosted-broker-and-production-browser-consumer).

This composition does not distribute routing credentials, approve a new client signing key, enroll a Device, or grant account/Project access. Normal operator configuration and user-facing connection setup must supply those owners; fresh relay-only guest enrollment is not proven by the lab's approved fixture Device.

## HTTP control contract

Browser v1 control requests are POSTs under `/broker/v1`, with JSON `scope`, an
exact configured `Origin`, `Authorization: Bearer <routing-or-connector-secret>`
and `X-Broker-Credential-Id`. These are broker credentials, never Station
Device or account credentials. The native v2 redemption endpoint is the sole
exception: it has no browser Origin and accepts no cookies or v1 credentials;
its authority is the invitation-bound ES256 key proof described above. The
request body is capped at 256 KiB. Clients refuse redirects and bound each
response to 1 MiB and 15 seconds.

| Suffix | Credential | Additional body / result |
| --- | --- | --- |
| `/leases/register` | Connector | Returns registration time, current lease revision and expiry |
| `/leases/renew` | Connector | `expectedRevision`; returns next revision and expiry |
| `/leases/withdraw` | Connector | Retires this routing generation and pending offers |
| `/stations/status` | Routing | Returns presence, routing generation and lease expiry |
| `/native/grants/invitations/issue` | Operator routing credential | Exact native surface and independently approved proof-key thumbprint |
| `/native/grants/list` | Operator routing credential | Native grant binding metadata and expiry/revocation state; no credentials |
| `/native/grants/revoke` | Operator routing credential | Exact native `grantId`; retires only that routing grant |
| `/native/grants/redeem` | Bound native P-256 key | V2 invitation plus exact ES256 proof; no browser Origin |
| `/connections` | Routing | `connection: {clientId, nonce, offerSdp}` opens one attempt |
| `/connections/offers` | Connector | `limit: 1`; returns at most one offer per page |
| `/connections/answer` | Connector | Exact attempt IDs, answer SDP and opaque Station proof |
| `/connections/read` | Routing | `clientId` and `nonce`; reads that attempt's answer |

The connector drains at most 32 one-offer pages per poll. Registration reads the
current revision so a restarted connector can resume the existing valid lease;
expired or withdrawn credentials require deliberate reprovisioning. Withdrawal
retires local pending work even when its reply is lost. Provisional answer
resources must provide bounded cleanup on publication failure or trust retirement.
Successful application-channel ownership belongs to the Station/Pion
composition. Broker withdrawal is not account or Device revocation.


## Configure a Station connector

From a source checkout on a POSIX server, opt in with
`STATION_BROKER_CONFIG_FILE=/absolute/private/connector.json` when starting
Station normally. With the variable unset, no broker connector is created.
Direct and local connections do not require this configuration.

Initialize the selected Station home offline first:

```sh
npm run connector:identity -- /absolute/station-home
```

This command takes the existing home maintenance lease, refuses an active
home, and initializes the Station identity and connection-signing key. Repeating
it preserves the existing identity. Its output contains only the public trust
descriptor and key thumbprint. Deliver that public trust through an independently
trusted channel; the broker cannot approve it for a client.

Use the descriptor's Station and enrollment IDs to provision the broker with
`broker:self-hosted init` as above. Routing generation and signing generation
are independent. Keep the credential bundle private; give the browser only its
routing credential, never the connector credential or Station operator key.

Build the Pion executable using the [transport lab guide](local-collaboration-lab.md).
Provide a TURN endpoint and DTLS certificate/private key. The local lab supplies
free isolated TURN infrastructure for testing; it does not install a service.
For a manually operated connector, create the certificate in a private directory:

```sh
umask 077
mkdir -p /absolute/private/connector
openssl ecparam -genkey -name prime256v1 -out /absolute/private/connector/key.pem
openssl req -new -x509 -key /absolute/private/connector/key.pem \
  -out /absolute/private/connector/cert.pem -days 90 -subj /CN=station-connector
```

Write `/absolute/private/connector.json` as a private `0600` file:

```json
{
  "version": "station-self-hosted-connector/v1",
  "brokerOrigin": "https://broker.example",
  "applicationOrigin": "https://station.example",
  "credentialsPath": "/absolute/private/broker-credentials.json",
  "pionExecutable": "/absolute/bin/station-pion-peer",
  "certificatePath": "/absolute/private/connector/cert.pem",
  "privateKeyPath": "/absolute/private/connector/key.pem",
  "turn": {
    "url": "turns:turn.example:5349?transport=tcp",
    "username": "configured-turn-user",
    "password": "replace-with-private-turn-credential"
  },
  "maxPeers": 8,
  "maxPeerLifetimeMs": 300000
}
```

`applicationOrigin` is the canonical application target used by the client and
account proofs. It is not inferred from the broker or browser Origin. Existing
origin policy, Device grants and account-provider configuration must separately
admit the browser. No CORS, membership or authentication permission is added by
the connector. `maxPeers` and `maxPeerLifetimeMs` are independently optional with
the defaults shown; heartbeat, renewal and offer polling use 5s, 10s and 1s.

The config, credential bundle and certificate/key files must be bounded regular
files in private owner-held directories, with no symlinks or hardlinks. The
executable must be owned by the current user or root, executable, and not writable
by a group or others. Windows connector custody is currently unsupported and
refused. Invalid configuration fails startup using closed error codes.

Station starts its local application service while the optional connector
registers. Transient registration failures retry with capped backoff and report
`reconnecting`; a permanent broker refusal reports `failed` without making the
local Station unavailable. Invalid private connector configuration still fails
startup before listeners open. Shutdown cancels registration, attempts
withdrawal, and joins peer cleanup before releasing the home lease. A changed
signing key retires already admitted peers; client trust approval remains an
independent operation. Withdrawn routing credentials require deliberate
reprovisioning as described above.

This source configuration does not complete browser profile UI, fresh relay-only
Device enrollment, native packaging or managed service operations. Existing
Device/account prerequisites still apply. The separate-process transport lab
qualifies the transport composition; normal operator entrypoint acceptance is
recorded separately.
