# Self-hosted routing broker

The broker matches clients with a Station connector. It carries signaling;
the verified peer connection carries encrypted application traffic. The broker
CLI binds only to loopback. Running it is not a public deployment or a complete
collaboration setup.

Keep these three approvals separate:

1. A broker invitation grants signaling access for an exact Station and client.
2. Independently approved Station signing trust authenticates the endpoint.
3. Device and account/Project grants authorize application requests there.

The [local lab](local-collaboration-lab.md) composes these owners for bounded
acceptance. [Connections](connections.md) explains the current browser and
native user journeys.

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

One broker database can hold multiple independently scoped Stations. Run `init`
once for each Station, using a separate owner-only init file and a separate
owner-only credentials file for each one; keep the `databasePath` identical
and give each provision record its own Station ID, enrollment ID, routing
generation, and approved browser Origin. Each init file still contains exactly
one provision record. For example, make private `station-a/init.json` and
`station-b/init.json` files with the same database path and different
`credentialsPath` and `provision` values, then run:

```sh
npm run broker:self-hosted -- init /srv/station-broker/station-a/init.json
npm run broker:self-hosted -- init /srv/station-broker/station-b/init.json
npm run broker:self-hosted -- serve /srv/station-broker/serve.json
```

The two credential bundles remain separate and each operator command is bound
to the exact scope named in its own config. A credential for Station A cannot
read or mutate Station B's lease. `serve` uses the shared database and does
not need either Station's credentials. Keep all config and credential
directories owner-only; do not put both Stations' secrets in a shared bundle.
This local CLI flow proves database and credential scoping, not public
deployment, multi-operator administration, remote reachability, or backup and
restore.

Connector and operator routing credentials are separate 256-bit secrets. Their
requests must match the credential direction, Station, enrollment, routing
generation, and configured Origin. Browser preflight admits an active configured
Origin and the exact declared headers: authorization, content type and credential
ID for credentialed requests; content type alone for invitation redemption.
Provisioning leaves a Station `offline`; an authenticated connector registration
makes the current routing generation `online` for 30 seconds. `online` describes
recent connector registration, not application readiness or permission.
Registration is the presence heartbeat; lease renewal is separate. A composed
supervisor must refresh both.

Each `init` invocation provisions one operator-owned routing credential for one Station and browser Origin. Multiple invocations may use the same broker database as described above. This is not per-Device enrollment or revocation, does not bootstrap an account, and does not complete routine fresh-client onboarding. The connector and optional Pion runtime below consume each routing scope. The broker cannot mint or replace independently approved connection-signing trust.

## Operator-owned community deployment

[The community deployment bundle](../../deployment/self-hosted-broker/compose.yaml)
is a small source-built broker setup for an operator who wants to run a shared
front door. It pins Caddy and coturn by multi-architecture image digest and
builds the broker from the checked-out Station source using the repository's
pinned Node base image. It does not create a domain, issue a public certificate,
open a cloud firewall, or qualify a remote deployment.

The broker keeps its loopback-only listener. Caddy and the broker share one
container network namespace, so Caddy can reach that loopback listener while
the host publishes only the configured HTTPS ingress port. coturn is a
separate service with an explicit UDP/TCP listener, TLS listener, bounded relay
port range, quotas, and resource limits. The sample uses non-default host ports
8443, 13478, and 15349; change them deliberately if they are already in use.
The relay UDP range 49160-49200 must also be forwarded through the host and
firewall.

Use a Linux host with Docker Compose v2 and a Station source checkout. Choose a
DNS name for the broker, point it at the host, and obtain a certificate whose
SAN contains that name. The same certificate is used by HTTPS and TURN/TLS.
Put the certificate and private key in a root-owned directory outside the
checkout. The pinned coturn image runs as `nobody:nogroup`; make the directory
traversable by its group and the key readable only by root and that group
(directory mode 0750, key mode 0640, group 65534). The bundle expects
`fullchain.pem` and `privkey.pem` there. Copy the example environment file,
then edit it with the DNS name, absolute certificate directory, and TURN
credentials. Keep `.env` owner-only and out of source control:

```sh
cd deployment/self-hosted-broker
cp .env.example .env
chmod 600 .env
BROKER_HOST="$(sed -n 's/^BROKER_HOST=//p' .env)"
TLS_CERT_DIR="$(sed -n 's/^TLS_CERT_DIR=//p' .env)"
BROKER_HTTPS_PORT="$(sed -n 's/^BROKER_HTTPS_PORT=//p' .env)"
TURN_TLS_PORT="$(sed -n 's/^TURN_TLS_PORT=//p' .env)"
umask 077
mkdir -m 700 private state backup
mkdir -m 700 private/unused private/station-a private/station-b
sudo chown root:65534 "$TLS_CERT_DIR" "$TLS_CERT_DIR/privkey.pem"
sudo chmod 750 "$TLS_CERT_DIR"
sudo chmod 640 "$TLS_CERT_DIR/privkey.pem"
sudo chmod 644 "$TLS_CERT_DIR/fullchain.pem"
```

Keep `fullchain.pem` readable by the coturn service (mode 0644 is sufficient);
the TLS private key should not be world-readable. Caddy runs as root inside its
read-only container so it can read the same key while binding HTTPS.

Generate a static TURN username and password with an OS random source, and put
the resulting values in `.env`. Configure each Station connector with the same
TURN username/password and
`turns:<BROKER_HOST>:<TURN_TLS_PORT>?transport=tcp`. Keep those connector
credentials in each Station's private connector configuration; do not pass
them to a browser or put them in the broker database. The sample TURN service
uses long-term username/password authentication. It does not implement a
credential minting service.

Create the exact owner-only serving configuration and one initialization file
per Station. `stationId`, `enrollmentId`, routing generation, and browser Origin
must match that Station's connector and client setup. Give each Station a
different credentials path. The database path is shared:

```sh
cat > private/serve.json <<'JSON'
{"version":"station-self-hosted-broker/v1","databasePath":"/data/broker.sqlite","credentialsPath":"/run/broker/unused/credentials.json","port":18765,"provision":[]}
JSON
cat > private/station-a-init.json <<'JSON'
{"version":"station-self-hosted-broker/v1","databasePath":"/data/broker.sqlite","credentialsPath":"/run/broker/station-a/credentials.json","port":18765,"provision":[{"stationId":"station-a-example","enrollmentId":"enrollment-a-example","routingGeneration":1,"browserOrigin":"https://station-client.example"}]}
JSON
cat > private/station-b-init.json <<'JSON'
{"version":"station-self-hosted-broker/v1","databasePath":"/data/broker.sqlite","credentialsPath":"/run/broker/station-b/credentials.json","port":18765,"provision":[{"stationId":"station-b-example","enrollmentId":"enrollment-b-example","routingGeneration":1,"browserOrigin":"https://station-client.example"}]}
JSON
```

The sample values are placeholders, not credentials. Restrict ownership and
permissions to the broker's runtime UID/GID 1000, and keep the database and
configuration directories private. Set `TURN_EXTERNAL_IP` to the host's actual
public IPv4 address. The compose network maps TURN's fixed container address
172.31.250.10 to that public address; choose a different private subnet in
`compose.yaml` if it conflicts with the host's Docker networks. Before serving,
set the source build identity from the checkout and build the image:

```sh
chown -R 1000:1000 private state
chmod -R go-rwx private state
export STATION_RELEASE_SHA="$(git -C ../.. rev-parse HEAD)"
export STATION_RELEASE_REF=v0.1.11
export STATION_RELEASE_CREATED_AT="$(git -C ../.. show -s --format=%cI HEAD | xargs -I{} node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' '{}')"
docker compose -f compose.yaml build
docker compose -f compose.yaml up -d ingress
docker compose -f compose.yaml run --rm --no-deps broker init /run/broker/station-a-init.json
docker compose -f compose.yaml run --rm --no-deps broker init /run/broker/station-b-init.json
docker compose -f compose.yaml up -d broker turn
```

The image build includes Station's full source build. Keep the source SHA in
the operator's change record. Do not set the published Station web image as the
broker image: the broker service runs the source checkout's `broker:self-hosted`
CLI. The build and setup commands do not deploy or alter a remote host.

Verify the HTTPS certificate through the platform trust store and check both
services are running before sharing their addresses:

```sh
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 ingress broker turn
test "$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  "https://${BROKER_HOST}:${BROKER_HTTPS_PORT:-8443}/")" = 404
openssl s_client -connect "${BROKER_HOST}:${TURN_TLS_PORT:-15349}" \
  -servername "${BROKER_HOST}" -verify_hostname "${BROKER_HOST}" \
  -verify_return_error </dev/null
```

`curl` verifies the HTTPS certificate and expected broker 404 response;
`openssl` checks the TURN/TLS name and trust chain. A local/self-signed
certificate is suitable only when the test clients explicitly trust its test
CA. These checks establish listener and certificate behavior from the machine
where they ran; they do not prove public reachability or a client-to-Station
application session. Check container health, logs, TLS expiry, disk space, and
the operator grant list as part of routine service monitoring:

```sh
docker compose -f compose.yaml exec broker npm run broker:self-hosted -- grants /run/broker/station-a-init.json
docker compose -f compose.yaml exec broker npm run broker:self-hosted -- grants /run/broker/station-b-init.json
```

Docker rotates each service's JSON/stdout logs to three 10 MiB files. The
broker health check only proves that its loopback HTTP process answers; it
does not prove a Station is registered. A connector renews its lease during
normal operation. Check the Station-specific grant/listener behavior through
the exact configuration and connector, and keep the service logs with the
source SHA and operator change record.

### Restart, backup, restore, and rotation

The services use `unless-stopped` restart policy. A broker restart preserves
the SQLite database and private credential files; connected Stations reconnect
and renew using their existing connector credentials. Check the process and
both Station grant lists after restart:

```sh
docker compose -f compose.yaml restart broker
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --since=5m broker turn ingress
```

Take a consistent local backup by stopping the broker first, then archive the
database, exact per-Station credential/configuration files, and TURN
environment file together. Protect and encrypt the archive using the
operator's backup system; it contains live routing credentials:

```sh
docker compose -f compose.yaml stop broker
umask 077
tar -czf "backup/broker-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" state private .env
docker compose -f compose.yaml start broker
```

Restore only with the broker stopped. Extract into a private staging directory,
retain the current directories for rollback, then replace them and recreate the
broker so Docker binds the restored directory. Preserve the archive and old
state until the broker and both Station connectors have recovered:

```sh
docker compose -f compose.yaml stop broker
restore_dir="$(mktemp -d ./restore.XXXXXX)"
chmod 700 "$restore_dir"
tar -xzf /absolute/path/to/broker-backup.tar.gz -C "$restore_dir"
mv state "state.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mv private "private.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mv "$restore_dir/state" state
mv "$restore_dir/private" private
cp "$restore_dir/.env" .env
chmod 600 .env
chown -R 1000:1000 state private
chmod -R go-rwx state private
docker compose -f compose.yaml up -d --force-recreate broker
```

This is an offline local file restore recipe; it does not fence another host,
prove an off-host archive is readable, or transfer Station authority. Keep one
writer for the broker database.

Rotate one Station's routing authority independently by creating a new private
init file with that Station's exact scope and the next routing generation, but
a new credential path. Run `init`, update only that Station's connector bundle,
then restart its Station connector and verify registration before retiring the
old credential copy. A higher generation replaces that Station's old lease;
it does not rotate the Station signing key, Device, account, or Project grants.
Do not regenerate an existing generation: `init` deliberately reuses the
matching bundle. Rotate TURN credentials separately by replacing the username
and password in `.env`, updating every intended connector configuration, then
restarting coturn and those connectors. Rotate the certificate by atomically
installing a new matching chain/key pair in the configured certificate
directory and restarting `ingress` and `turn`; rerun the TLS checks above.

The bundle's host-port exposure, container quotas, logging bounds, and TURN
relay range are starting limits for a small community host. Size them against
measured load and host policy before widening them. Public DNS, firewall/NAT,
certificate issuance, sustained bandwidth, external monitoring, and a
separately recorded remote run remain operator responsibilities. The free
[local collaboration lab](local-collaboration-lab.md) is diagnostic evidence;
it does not qualify this deployment as remotely reachable.

## Native routing grant foundation (v2)

The broker database currently writes schema v6 and accepts the known v1–v5
schemas for additive migration. Native invitation and grant metadata lives in
separate v3 tables, connection offers in v4, consumed request proofs in v5,
and grant-renewal receipts in v6. Existing browser v1 wire records, Origin
checks, owner tables, and signaling behavior are unchanged. A native surface is
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
service, and their stored credential is hashed. The native grant defaults to
and is capped at 24 hours; browser v1 retains its separate 30-day cap. Each
native `open`, `read`, and `retire` request requires an ES256 proof from the
invitation-bound P-256 key. Its claims bind the canonical broker origin as the
audience, method and full path, grant, scope, native surface, Station signing
key and generation, exact transmitted UTF-8 body digest, bearer digest, a
single-use JTI, and Unix-second issue/expiry times no more than 30 seconds
apart. The proof is sent in `X-Station-Native-Proof`; no browser Origin or
cookie is accepted. The broker atomically consumes the JTI with the signaling
operation and retains replay entries for five minutes. Native grants can be
renewed with a fresh request proof when no more than 12 hours remain
and for up to seven days after expiry. The renewal body binds a closed
8-128-character URL-safe `renewalId` and the expected expiry in Unix
milliseconds. A private SQLite receipt binds that ID to the exact body digest
and the committed expiry, so retrying the same body after a lost reply returns
the same receipt. Reusing the ID for another body conflicts; a receipt
superseded by a later renewal returns a typed conflict with the current expiry. Receipt and JTI
records have bounded retention and grant-row cleanup cascades them safely.
Renewal grace is proof-only: `open` and `read` remain unavailable after grant
expiry, and revocation, withdrawal, or a replaced Station generation makes a
receipt unusable. Grants not renewed within seven days need operator
re-issuance.
Rust has private-key signing and fixed-path HTTP helpers for these request
proofs, including retained cleanup and renewal state. The desktop Tauri command
table now wires native grant redemption, status, renewal, revocation, pending-cleanup
read/retry, and both diagnostic and application-named signaling binding/open/read.
Those main-window
commands reload the saved profile and approved Station trust in the host;
the renderer does not supply trusted keyring identity. Profile removal and
startup also have pending-cleanup hooks. Ordinary UI does not select a native
application route. The separate manual
[native Project pilot](native-shell-verification.md#native-protected-project-pilot)
composes protected application traffic for bounded debug-shell verification.

The [application signaling and peer commands](../design/native-capabilities.md#desktop-application-signaling-commands)
admit an existing routing grant and return public binding metadata or bounded
SDP/proof responses. The renderer's
[application signaling adapter](../../src-ui/src/platform/native/nativeApplicationSignalingBridge.ts)
wraps the host-owned peer lifecycle for one exact saved-profile revision. The
host verifies the Station transcript and signs one bounded Device request after
peer preparation; the opt-in Connect adapter carries it over the application
DataChannel. Returning an opaque Station proof alone does not verify it or prove
DTLS connectivity. Broker signaling remains separate from Device/account
authorization and application transport; ordinary UI activation remains gated.

The separate [desktop account proof-key foundation](../design/native-capabilities.md#desktop-account-proof-key-foundation)
uses its own keyring namespace, additionally bound to a Station and approved
Device identity. Bounded host account operations now have Tauri commands and a
typed SDK proof provider used by the manual pilot. There is no ordinary
production sign-in UI caller. The broker's routing proof key and grant
maintenance do not become account proof or account authority through that
foundation. See the pilot's retained verification limits before treating a
development run as packaged or relay-only onboarding evidence.

Host renewal records its renewal ID, expected expiry and exact body in private
grant custody before sending the request. A lost reply reuses that intent with
a fresh request proof. Profile/trust/grant identity is checked again before
the host accepts a receipt, and renewal is serialized with route retirement.
A retained valid intent can recover an already-committed broker receipt after
the original local expiry/grace window; this does not authorize a new renewal
outside the broker's window or allow expired open/read operations.

The Desktop `NativeRelayGrantRenewalSupervisor` is composed by `ApiBaseProvider`.
It observes all saved routes while the renderer is visible, validates the host
DTO and saved-profile revision, and renews only an existing single grant with no
pending cleanup. Timers and wake/online refreshes recheck status before renewal;
failures receive bounded backoff. Removing or replacing a profile fences its
pending renderer result. The 64-route ceiling pauses all automatic maintenance
until the saved set is within the limit. This supervisor does not approve a key,
redeem an invitation, or make native application transport available.
Native invitations and grants are retired with their Station
routing generation. V1 redemption rejects v2
invitations, and native-v2 redemption rejects v1 invitations. This foundation
adds versioned v2 native `open`, `read`, and `retire` operations. Host requests
carry the exact Station/enrollment/routing generation and native surface with
the grant bearer; they send no browser Origin or cookies. V2 offers contain an
explicit protocol version, full surface, Station signing-key ID, and signing
generation. They are stored separately and never appear in v1 offer pages.

The Station connector exposes `pollNative()` only when a caller explicitly
supplies a native offer adapter bound to one exact surface. Before that callback
can allocate a peer, it checks the offer's Station key thumbprint and generation
against current approved Station trust. The production Pion runtime registers
the native application adapter only when `nativeClient` is configured. Its
ordinary browser `poll()` remains separate; the lifecycle additionally calls
`pollNative()` for that opt-in surface. The signing-key candidate lane still
only establishes endpoint trust.

The native application adapter marks requests from an admitted peer with
server-owned provenance before virtual ingress; omitting `Origin` on an
ordinary HTTP request supplies no such authority. Device and account admission
remain separate. Several native installations can hold separate grants, but
this connector configuration names one surface; multi-surface fan-out and
ordinary native UI onboarding remain separate work.

An explicit native-v2 `diagnosticEcho` composition is available in the
[local lab](local-collaboration-lab.md#native-v2-signaling-diagnostic).
Its caller supplies a diagnostic adapter and collects an echo before retiring
the peer. It does not register the ordinary native application adapter or turn
a saved Desktop route into a selectable application connection.

Connection offers use a caller-chosen client ID and nonce, expire after 30 seconds, and remain replay tombstones for five minutes. Each Station may hold 32 live offers and the broker 1024. Offer and answer SDP are capped at 128 KiB; the opaque Station proof uses its owning 4 KiB contract limit. A connection accepts one answer. Withdrawal and a newer routing generation invalidate pending work without changing Station signing-key trust. Lease renewal uses an explicit revision CAS.

The service binds only to loopback. Public TLS termination, reverse-proxy
hardening, and deployment qualification remain separate operator work under
#1963. The opt-in connector lifecycle and protected application transport are
implemented below; their existence does not qualify a public deployment.

## Connector lifecycle library

`SelfHostedBrokerClient` fixes one configured broker origin and refuses redirects, oversized responses, and response fields outside the v1 contract. `SelfHostedBrokerConnector` serializes registration and renewal separately from one bounded offer-admission loop, so an in-flight peer handshake does not starve lease maintenance. It rechecks current Station/enrollment signing trust around asynchronous answer construction. Withdrawal retires both lanes, including compensation after an unconfirmed registration reply.

`createSelfHostedBrokerPionRuntime` composes that connector with the production Pion adapter and the protected application channel. It captures the exact trusted descriptor per peer, verifies the issued proof, bounds peer ownership, and gates application frames against current trust. Cleanup distinguishes an operational cancellation from confirmed process/file retirement. `StationRuntimeOptions.selfHostedBrokerConnector` is explicit opt-in and requires `virtualApplication`; startup waits for protected application activation, and broker cleanup participates in ordinary runtime shutdown without stranding the other services.

The dedicated `@kontourai/station-connect/self-hosted-browser` entry point supplies the corresponding browser signaling, verified peer and encrypted Fetch transport. Its caller owns independently approved signing trust, routing-credential custody, ICE configuration, Device credentials and account continuations. It does not install a second SDK resolver or silently fall back to HTTP. See the [connection package](../../packages/connect/README.md) and the [free broker lab](local-collaboration-lab.md#separate-self-hosted-broker-and-production-browser-consumer).

This composition does not distribute routing credentials, approve a new client signing key, enroll a Device, or grant account/Project access. Normal operator configuration and user-facing connection setup must supply those owners; fresh relay-only guest enrollment is not proven by the lab's approved fixture Device.

## HTTP control contract

Credentialed browser v1 control requests are POSTs under `/broker/v1`, with JSON
`scope`, an exact configured `Origin`, `Authorization: Bearer <broker-secret>`
and `X-Broker-Credential-Id`. The credential can belong to the connector,
operator routing owner or one enrolled browser grant, according to the operation.
These are broker credentials, never Station Device or account credentials.
Browser invitation redemption instead requires its invitation and exact allowed
Origin, and refuses cookies and credential headers.

Native redemption and key-candidate request/read operations require their
invitation-bound ES256 proof and refuse Origin, cookies and credential headers.
Native connection open/read and grant renew/retire requests require the native grant credential
and a fresh request proof; they also refuse Origin and cookies. Native offer
polling and answer publication are connector operations and retain the
connector's configured Origin and credential. The request body is capped at
256 KiB. The connector client refuses redirects and bounds each response to
1 MiB and 15 seconds.

| Suffix | Credential | Additional body / result |
| --- | --- | --- |
| `/leases/register` | Connector | Returns registration time, current lease revision and expiry |
| `/leases/renew` | Connector | `expectedRevision`; returns next revision and expiry |
| `/leases/withdraw` | Connector | Retires this routing generation and pending offers |
| `/stations/status` | Routing | Returns presence, routing generation and lease expiry |
| `/grants/redeem` | Browser invitation and allowed Origin | Consumes the one-use invitation and returns its separate browser routing grant; no credential headers or cookies |
| `/grants/revoke` | Operator routing credential | Revokes one browser grant and retires its connection attempts |
| `/grants/retire` | Browser routing grant | Retires only the caller's grant |
| `/native/grants/invitations/issue` | Operator routing credential | Exact native surface and independently approved proof-key thumbprint |
| `/native/grants/list` | Operator routing credential | Native grant binding metadata and expiry/revocation state; no credentials |
| `/native/grants/revoke` | Operator routing credential | Exact native `grantId`; retires only that routing grant |
| `/native/grants/redeem` | Bound native P-256 key | V2 invitation plus exact ES256 proof; no browser Origin |
| `/native/grants/renew` | Native grant plus ES256 PoP | Exact request proof and body-bound renewal ID; returns committed expiry or a typed current-expiry conflict |
| `/native/connections/open` | Native grant plus ES256 PoP | Exact body bytes, request path, scope, surface, Station key/generation and one-use JTI |
| `/native/connections/read` | Native grant plus ES256 PoP | Own attempt by nonce; same request and surface binding |
| `/native/grants/retire` | Native grant plus ES256 PoP | Retires only the caller's native grant; idempotent after revocation |
| `/native/connections/offers` | Connector | Versioned native offers for one exact surface |
| `/native/connections/answer` | Connector | Answer SDP and Station proof for the bound native offer |
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

An operator may additionally opt in one exact native v2 client surface by adding
this field to the connector file:

```json
{
  "nativeClient": {
    "kind": "station-native",
    "appIdentifier": "io.example.station",
    "channel": "stable",
    "clientInstanceId": "8b9c86cf-e65a-4aad-983b-82bb03960ad1",
    "keyThumbprint": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "maxPeers": 4
  }
}
```

Use the actual approved client identity and proof-key thumbprint; the sample is
not a credential. The native peer limit defaults to four and is capped at 32.
Without `nativeClient`, Station does not poll or answer native application
offers. With it, the connector answers only that surface under its current
Station signing trust. This opt-in does not issue the native routing grant,
approve a Device, authenticate a person or grant Project access. A packaged
native client journey still requires the host-owned grant and account wiring
described above; this source configuration alone is not onboarding.

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

The browser has saved-route, TURN, and fresh account/Device enrollment UI;
the lab's separate `--station-ui` profile exercises that journey. This server
configuration does not itself approve a client, enroll its Device, or grant
Project access. Native route selection, packaging, and managed service
operations remain separate work. Transport-lab evidence and normal operator
entrypoint evidence must name the configuration and revision actually tested.

## Follow the implementation

- [Broker CLI](../../scripts/self-hosted-broker.ts) and
  [service](../../src-server/services/connections/self-hosted-broker-service.ts)
  own private configuration, loopback binding, persisted grants, and signaling.
- [Wire contracts](../../packages/contracts/src/self-hosted-broker.ts) define
  versioned browser/native fields and limits.
- [Connector](../../src-server/services/connections/self-hosted-broker-connector.ts),
  [Pion composition](../../src-server/runtime/bootstrap/self-hosted-broker-pion-runtime.ts),
  and [lifecycle](../../src-server/runtime/bootstrap/self-hosted-broker-runtime.ts)
  own registration, peer admission, and shutdown.
- [Normal entrypoint](../../src-server/index.ts) consumes the
  [private connector configuration](../../src-server/runtime/bootstrap/self-hosted-connector-config.ts).
  [Offline identity initialization](../../scripts/self-hosted-connector-identity.ts)
  owns its home lease, schema admission, and public descriptor output.
- [Native proof signing](../../src-desktop/src/native_relay_proof_key.rs),
  [redemption/request helpers](../../src-desktop/src/native_relay_redemption.rs),
  and the [registered native commands](../../src-desktop/src/lib.rs) distinguish
  implemented Rust foundations from the commands available to the application.
