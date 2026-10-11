# @kontourai/station-connect

Multi-device connectivity package. Handles stable Station identity, host-
confirmed one-time device pairing, scoped credential storage, revocation, and
connection persistence. The source contains a framework-agnostic core and React
bindings; the package root exports both. This is a private workspace package,
not a separately published installation contract. The root and `/health-probe`
exports require the package build; other declared subpaths point to TypeScript
source. See the [package README](../../packages/connect/README.md) and
[export map](../../packages/connect/package.json).

For how this pairing relationship differs from an SSH environment's
delegated-execution relationship — direction, trust model, and what persists
where — see
[docs/guides/machine-relationships.md](../guides/machine-relationships.md).

---

## Native relay link publication

The `/native-relay-link` source entry re-exports `nativeRelayLinkScheme`,
`encodeNativeRelayLink` and `parseNativeRelayLink` from the published
[`@kontourai/station-shared/native-relay-link`](shared.md#native-relay-link-codec)
leaf. Connect retains this entry for compatibility; Shared owns the single
canonical codec used by SDK and server consumers. It publishes or inspects the
closed `station-native-relay-link/v1` envelope: public first-contact route
intent, or an untrusted application-origin hint wrapping an unchanged native
v2 installation-bound invitation. The distinct URI association carries the
complete bounded envelope in its fragment, with no query payload. Production
origins require canonical HTTPS; explicit development links permit only exact
numeric loopback HTTP.

The codec grants no authority and is not the receiving native secret boundary.
iOS receives the invitation in [host custody](../../src-desktop/src/native_relay_link_intake.rs)
and emits only `NativeRelayLinkDelivery` metadata and a pending handle. The
renderer does not parse or retain a received link's secret. Saved-route review,
public-proof/operator approval, independent Station-key comparison, person
authentication, Device approval and Project membership remain separate.
Android does not register the relay-secret association. Source composition
does not qualify an installed native or collaborator journey.

## Native Device setup failure diagnostics

The `/native-enrollment` exchange retains the primary operation failure while
attempting both channel and host-peer cleanup. Cleanup failures remain separate
and a cleanup-only failure rejects the operation. Existing `Error` objects retain
their identity; primitive native rejections normalize to an `Error` containing
an allowlisted code or `unknown`. The native Device setup UI
can show an optional troubleshooting disclosure containing a fixed operation
stage, an allowlisted code (or `unknown`), an integer HTTP status when a response
was received, and at most two cleanup stage/code entries. It displays no raw
error text, response body, URL, proof, credential or owner identifier.
Non-success HTTP responses are refused before native host acceptance. Only a
closed error envelope with an allowlisted server code contributes its code;
other bodies become `native_enrollment_application_refused`. The diagnostic
retains the `application-response` stage and HTTP status.

After an uncertain activation, **Check Device status** remains available through
pending or refused status checks. Expired saved deliveries also reconcile status
before terminal cleanup. The UI reports configured only after active status
passes the host's transition currentness check; it does not retry activation.

The automatic saved-setup recovery check uses the same disclosure, including
failures before client construction: route status, saved-route currentness and
Station trust have distinct fixed stages. Host resume refusals retain their
existing fixed code at the `recovery` boundary; no protocol call is repeated to
obtain diagnostics.
Multiple saved routing grants report the fixed
`native_enrollment_saved_connections_ambiguous` code at `route-status`. The UI
directs the user to a fresh owner-issued invitation for explicit connection
review and cleanup; it does not select or remove a grant automatically.

These fields identify the local failing boundary, not a verified server cause.
`peer-open` includes binding, ICE and peer admission; a missing HTTP status does
not establish whether the server received an earlier request. This diagnostic
adds no retries, admission authority or native command inputs. Caller tests
exercise rejection and cleanup through application channels and the mounted
setup UI; they do not diagnose an earlier installed attempt or prove a successful
Device enrollment.

Fixed `browser_transport_timeout` and `browser_transport_failed` codes identify
local transport timing or failure without exposing the browser's raw error.

## Application channel request preparation

The `/application-channel` entry exports `ApplicationChannel`,
`ApplicationChannelRequestPreparation` and `ApplicationChannelPreparedHeaders`.
A channel owner can implement optional `prepareRequest(request)` to add headers
after its peer opens and before the request is sent. This permits per-peer
preparation without changing the broker or application-frame protocol.

`createApplicationChannelFetch` first reads and validates the bounded request
body. The callback receives immutable method and path fields (including the
query), independent body bytes of at most 16 KiB, copied original headers and
the owned request signal. Mutating these copies cannot change the transmitted
target, body or original headers. The callback returns additional header pairs;
case-insensitive collisions with original headers or previous additions are
refused, including attempts to replace caller-supplied proof or credential
headers. Existing header-count, byte and frame limits still apply.

The adapter checks endpoint trust, cancellation and caller authority before
preparation and after its asynchronous result. Cancellation settles a hanging
callback and closes the channel; a late result cannot dispatch. Preparation or
framing failure after opening also closes without sending a request. Channels
without the method keep their existing request behavior. No operation retries
automatically.

This is an opt-in transport contract. It exposes no native peer handles,
signing keys or proof claims, and installs no signer. The native host signer
and ordinary UI composition require separate integration and verification.
The [application-channel tests](../../packages/connect/src/__tests__/applicationChannel.test.ts)
exercise the Fetch adapter through frames and the server request boundary;
they do not establish physical native-client or relay-only acceptance.

## Optional native application transport

The `/native-application` source entry exports
`createNativeApplicationTransport({ signaling, origin, signal, trust, ... })`
with an independent `NativeApplicationSignaling` contract. The host prepares an
opaque peer handle, nonce and connection ID before SDP creation; the client
opens and reads that same handle, verifies the signed Station answer before
setting the remote description, and uses only the reliable, ordered
`station-application-v1` DataChannel. After opening, the channel's
`prepareRequest` calls the host signer with the exact bounded method, path and
body and returns only the native Device-proof header. Caller-supplied
Authorization, Cookie and Device-proof headers are refused. Abort, failed
preparation or retired trust closes owned work. There is no direct HTTP
fallback, grant-bearer exposure or signing-key exposure.

ICE gathering has a 10-second bound. If gathering stalls on a relay-only peer,
the client can submit its current local offer only when its active application
media contains a valid UDP relay candidate. Missing, malformed, non-relay or
unusable candidates do not enable this fallback; every candidate in the snapshot
must be a valid UDP relay candidate, even under relay-only policy. Cancellation, failed or closed
transport, and retired Station trust still prevent submission. The one captured
SDP string is used for signaling, its digest and Station proof verification;
later candidates never cause a second offer. These source-level conditions do
not establish connectivity or installed iOS enrollment success.

Host transcripts and browser RTC connectivity are separate observations. The
host permits one Device proof per handle; account proofs come from the separate
structured provider and their complete exchange body is prepared before this
transport freezes it. Host read expiry may shorten a prior deadline, while an
extension or expired read is refused. The adapter retains bounded peer leases
and retires cancellation, failed/late preparation and expired handles.

The library does not enroll or activate a Device, authenticate an account or
grant Project access. Station's native saved-route owner now composes this
transport for a configured host-owned Device binding, obtaining fresh ICE for
each peer. Its separate account bridge supplies continuation proof for bounded
Project and authority reads, plus a dedicated fixed native account operation
for the closed relay-management and Project access administration leaves.
Unsupported resources and writes fail before peer creation; this is not a
general operator Workspace transport. Management does not replace Project IAM
or grant terminal, Agent or Task publication authority. Account-bound relay
management requires current native Device/account proof and explicit
`relay:manage`; a credential-only account-bound Device remains gated. The CLI
continues to exclude these routes from default selection. Focused source tests do not establish executed
Tauri IPC, packaged-client, physical-device or complete authenticated
Project-journey evidence.
See the [package README](../../packages/connect/README.md#optional-native-application-transport)
and [native account continuation](sdk.md#native-station-account-continuation-opt-in)
for the separate caller responsibilities. No physical native-client result is
implied by these source contracts.

## types

### `SavedConnection`

A persisted server connection entry. This excerpt shows the main fields; import
the canonical type for host-injected, broker-route and recovery metadata.

```ts
interface SavedConnection {
  profileVersion: 4;
  id: string;
  name: string;
  url: string; // compatibility alias for the selected endpoint
  endpoints: AccessEndpoint[];
  selectedEndpointId: string;
  accessMethods: EnvironmentAccessMethod[];
  selectedAccessMethodId: string;
  environmentId: string | null;
  authProtocolVersion: number | null;
  credentialRef: CredentialRef; // lookup reference, never bearer material
  capabilities: EnvironmentCapabilities | null;
  credentialState: 'not-required' | 'required' | 'saved' | 'device-session';
  lastConnected?: number; // unix ms
  lastSuccessAt?: number;
  lastBootId?: string;
  lastError?: ConnectionFailure;
}
```

The public `/.well-known/station/v1` handshake supplies the stable
`environmentId`. The endpoint URL may change without changing that identity.
Credentials are stored in a separate credential adapter and keyed by
environment identity after a validated handshake.

`SavedConnection.capabilities` (`EnvironmentCapabilities` above) is a
client-local summary derived from the handshake's `transports` block — not
the same thing as the raw handshake document's own optional `capabilities`
field (station#1095), which is a server-advertised map of named boolean
feature flags (e.g. `sshEnvironments`, `webPushNotifications`) used for
feature detection across a rolling client/server upgrade. Station-to-Station
senders read it too: `delegatedInputAnswers` gates sending a bound answer
(`expectedInputRequest`) to another Station's delegated task, as described in
the [session API](session-api.md#bound-answers-to-a-paired-stations-question). See
[docs/security/remote-access-threat-model.md](../security/remote-access-threat-model.md#surface-matrix)
for that field's schema and absence-means-unsupported semantics, and
`hasCapability()` from `@kontourai/station-sdk` for reading it.

Changing a verified environment's endpoint stages a candidate for explicit
confirmation. The current confirmation path requires a saved credential, sends
a fresh 256-bit nonce to `POST /.well-known/station/v1/proof`, and checks the
returned environment ID, nonce, protocol version and HMAC before committing the
candidate. The request does not include the bearer credential. Use an endpoint
whose ownership you have independently established; the public handshake and
this response check are not a replacement for trusted endpoint selection.
This confirmation path accepts HTTPS, or HTTP on strict loopback hosts. See the
[confirmation caller](../../packages/connect/src/react/ConnectionManagerModalContent.tsx)
and [proof parser](../../packages/connect/src/core/environmentProof.ts).

Version 4 migrates older URL-only and endpoint records idempotently. One verified
environment can retain typed same-origin, tailnet HTTPS, LAN HTTPS/HTTP, and
manual access paths. Selection is deterministic; an HTTPS browser never
silently downgrades to HTTP. Identity, authentication, capability-version,
timeout, offline, reachability, and server-restart outcomes remain distinct and
redacted.

`ConnectionHealthCoordinator` shares one sequential probe across UI consumers,
uses bounded exponential retry with jitter, cancels when the environment or
subscriber set changes, and wakes on browser online/visibility signals. The
last verified profile/session data may remain visible during a transient
outage. Health snapshots do not themselves make all consumers read-only. The
SDK transport can reject non-safe HTTP methods before dispatch when a host's
credential resolver supplies `mutationAllowed: () => false`. Station's native
broker credential owner supplies that guard for its bounded read transport;
other resolver paths retain their existing behavior. Individual
features still own their availability checks. See the
[SDK transport](../../packages/sdk/src/client/http.ts) and
[Station resolver](../../src-ui/src/contexts/ApiBaseContext.tsx).
[#2815](https://github.com/kontourai/station/issues/2815) tracks the decision
about a shared stale-connection mutation policy. The optional guard's absence
alone does not establish that a particular stale operation can succeed.
This health coordinator does not queue mutations.
Station's separate chat outbound queue has its own admission and replay rules;
this is not a promise that the whole application has no queue.

### `ConnectionSupervisor`

A standalone, transport-agnostic connection state machine: `available ->
connecting -> connected`, with `backoff` (transient failure, retry scheduled
on a default 1/2/4/8/16s ladder with 20% jitter that resets after 30s of stable
connection), `blocked` (a caller-classified terminal failure, which never
retries automatically), and `offline` (no network). It is driven by typed
signals (`connectRequested`, `disconnectRequested`, `retryRequested`,
`networkChanged`, `wakeup`, `credentialChanged`, `attemptSucceeded`,
`attemptFailed`, `transportClosed`) rather than ad hoc booleans, and it owns
the *only* retry timer for whatever `attempt` function it is given — that
function gets exactly one try per tick and must not retry internally. While
`connected`, a `wakeup` signal (the app/tab becoming active again, e.g. after
laptop sleep) runs a lightweight `probe` to catch a half-dead socket the OS
never reported as closed; a failed probe drops back into the normal
`connecting` cycle. Data-sync health (`sync: 'idle' | 'ok' | 'error'`) is a
separate dimension from connection state, set via `reportSyncStatus()` — a
healthy transport with a failed subscription stays `connected` with
`sync: 'error'`, never regresses to `connecting`.

`classifyConnectionFailure(reason: ConnectionFailureReason):
'transient' | 'terminal'` maps this package's failure vocabulary onto the
supervisor's generic classification — today only `authentication-failed`
(401/403) is terminal. `ConnectionHealthCoordinator` is the first adopter: it
consults this classifier on each failure and, for a terminal reason, stops
scheduling its automatic retry ladder (surfaced as a new `blocked: boolean`
on `ConnectionHealthSnapshot` / `ConnectionStatusResult`). It resumes on the next explicit
`trigger()` — already reachable through a manual "Try now", the browser
regaining network, or a saved-credential change). The coordinator keeps its own
multi-endpoint polling loop; it does not instantiate `ConnectionSupervisor`.
The hook shares coordinators through a registry, which is separate from the
proposed reusable supervisor registry (#1096). See the
[supervisor](../../packages/connect/src/core/ConnectionSupervisor.ts),
[coordinator](../../packages/connect/src/core/ConnectionHealthCoordinator.ts),
and [hook registry](../../packages/connect/src/react/useConnectionStatus.ts).

### `StorageAdapter`

Interface for pluggable storage backends.

```ts
interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
```

### `ConnectionStatus`

```ts
type ConnectionStatus = 'connected' | 'connecting' | 'error' | 'idle';
```

### `ConnectionCandidate`

An unverified, secret-free reachability hint returned by a registered native or
trusted-host provider.

```ts
interface ConnectionCandidate {
  candidateVersion: 1;
  id: string;
  url: string;
  name: string;
  source: 'lan-dns-sd' | 'tailnet' | 'desktop-host';
  providerId: string;
  discoveredAt: number;
}
```

---

## storage adapters

### `LocalStorageAdapter`

Wraps `window.localStorage`. Silently swallows quota errors and SSR exceptions.
This is the default for non-secret connection profiles. It is not the default
credential store.

```ts
import { LocalStorageAdapter } from '@kontourai/station-connect';

const storage = new LocalStorageAdapter();
storage.set('key', 'value');
storage.get('key'); // 'value'
storage.remove('key');
```

### `defaultStorage`

A pre-constructed `LocalStorageAdapter` singleton. Used by `ConnectionStore` when no custom adapter is provided.

```ts
import { defaultStorage } from '@kontourai/station-connect';
```

### `SessionStorageAdapter` and `defaultCredentialStorage`

The web default keeps manually supplied bearer credentials in `sessionStorage`,
separate from profile `localStorage`. They survive reloads in the same tab but
are discarded with the tab session. This remains a conservative advanced
fallback, not an OS keychain: same-origin script can read it. Same-origin web
pairing does not use this adapter; the server places the device credential in a
persistent `HttpOnly` cookie that JavaScript cannot read. Supplying `storage`
without `credentialStorage` makes that custom adapter the credential fallback
too; pass both explicitly when they need different custody. Station's native
host owns credentials and supplies authenticated transport plus secret-free
profile state. A renderer-readable keychain adapter would not preserve that
host-only boundary.

---

## ConnectionStore

Framework-agnostic store for managing saved connections. Compatible with React's `useSyncExternalStore` via the `subscribe` method.

```ts
import {
  ConnectionStore,
  LocalStorageAdapter,
  SessionStorageAdapter,
} from '@kontourai/station-connect';

const store = new ConnectionStore({
  storage: new LocalStorageAdapter(),
  credentialStorage: new SessionStorageAdapter(),
  storageKey: 'my-host-connections',
});
```

Profile and credential adapters must remain separate in production. A device
credential is never serialized in a `SavedConnection`, endpoint URL, QR value,
query string, or ordinary connection-profile localStorage record.

### methods

#### `getAll(): SavedConnection[]`

Returns the composed connection list, including a host-injected entry when it
has not been folded into its matching saved profile. Injected entries are not
persisted. The result is cached between invalidations.

#### `getActive(): SavedConnection | null`

Returns the resolved usable active connection. Resolution considers explicit
selection, host-injected selection, matching mobile/default and managed-loopback
profiles, then a non-broker saved fallback. It can return `null`; an unprepared
broker route is not automatically activated.

#### `add(name: string, url: string): SavedConnection`

Adds a new connection, selecting it when no active ID exists. If a non-broker
connection with the same URL already exists, activates and returns that entry.
Call `setActive` explicitly when the new connection should replace a selection.

#### `remove(id: string): void`

Removes a saved connection and its saved credential. If it was active, selection
falls back to the first remaining non-broker saved profile, then the normal
host-aware active-resolution rules.

#### `update(id: string, changes: Partial<Pick<SavedConnection, 'name' | 'url' | 'sshForward'>>): void`

Updates supported profile fields. A URL change for a verified environment
stages an endpoint candidate for proof and confirmation. A broker route's URL
cannot be replaced this way; it requires a new invitation.

#### `reconcileHandshake(id, handshake): SavedConnection | null`

Validates the public bearer-auth handshake, binds the profile to its stable
environment ID, and merges a duplicate profile for the same environment. A
credential provisionally saved against a connection is moved to the stable
environment reference.

#### `setCredential(id: string, credential: string): void`

Stores a manually supplied credential separately from the renderable profile.
This is an advanced recovery adapter, not the normal browser onboarding path.
Prefer a host-approved device session so reusable operator credentials never
cross the browser boundary. The credential must never be put in the endpoint
URL.

## one-time device pairing

The Station host's **Connect a Station** journey can save Device access without
activating the destination. `completeVerifiedPairing` accepts `activate: false`
on its target; persistent approval requests carry `activateConnection: false`
through completion. Both paths preserve an existing selected Station and keep
native credential custody with the host. Hosts that omit the option retain
the existing activation behavior.

The new journey uses `bindApprovedEndpoint: true` to bind a browser grant to its
exact approved address before saving the credential. Setup keeps an existing
controller's Device access, including at the same address. Use the explicit
Stations reconnect/repair flow to replace that access. An alternate address
cannot replace the controller's route during setup. First-device identification does not require
an existing controller, while peer management still does.

Connect's root exports `savePendingExchange` alongside `loadPendingExchange`
and `clearPendingExchange`. A host can retain the verified destination, target
connection and activation policy before transferring the request into persistent
approval chrome. These are Device-flow records, not the server-held peer journal.

Pairing offers and pending requests can disclose `kind: 'device' | 'delegation'`;
absence in an older response means Device. A server's requested delegation kind
does not grant it approval authority. The public access-request route accepts
the delegation intent only with the fixed delegation preset and without account
binding or client-instance inputs. The receiving trusted approver sees **Station
peer** separately from Device access.

Ordinary Device invitations keep their existing encoded payload shape: default
Device kind is omitted so older strict invitation parsers remain usable.
Delegation invitations remain distinguishable and cannot be saved as interactive
Device access.

The server-held peer ceremony is composed by
[PeerEnrollmentService](../../src-server/services/peers/peer-enrollment-service.ts)
and the [peer routes](../../src-server/routes/environments/peer-credential-routes.ts).
The controlling operator submits a stable UUID, exact origin and expected
environment identity. Proofs and exchanged bearers stay in private server
records; only enrollment metadata crosses the API. A reported environment ID is
not signing-key verification. Redirects are refused, and public addresses require
HTTPS; private/loopback HTTP remains supported for personal setup.

Enrollment mutations use a shared durable lock and refresh their records before
reservation, exchange, cancellation and pruning. Concurrent runtimes cannot
consume the same proof or overbook the retained-record limit. Receiver fields
and serialized private records are bounded before writing.

An explicit completion checks the same receiver and exchanges once after
approval, then publishes to the existing peer store under current authority.
Duplicate starts with the same UUID and intent return the same record. A restart
or lost response during a remote effect can leave **outcome unknown**, which does
not authorize another exchange. If publication fails after the credential is
retained privately, completion can retry publication without exchanging again.
Local cancellation does not revoke a receiver grant. This enrollment neither
offers a Project resource nor implements operator elevation, reciprocal access,
provider-process migration or foreground peer execution.

After an interrupted operation, a status read can report an unknown outcome
without replaying it. Local cancellation remains available after reacquiring the
durable lock. If the peer was already installed before its journal acknowledgement
failed, status reconciles to connected and cancellation directs the operator to
remove the saved peer instead of claiming the pending request was cancelled.

For a browser already open at the Station URL, choose **Connections → Request
access to this Station**. Station creates a rate-limited, five-minute request
for that same origin without asking for a URL, camera, code, or operator
credential. An already trusted session must approve the displayed device name
and scope or explicitly deny the request; the requesting browser cannot decide
either outcome itself. The host inbox shows the remaining lifetime and removes
expired requests automatically. It distinguishes same-origin requests from
pairing-code requests. A deployment with the explicit Tailscale Serve identity
adapter also labels a request with the verified tailnet account returned by
Serve; raw client headers never create that label, and the account is not
recorded in metrics. A denial stops requester polling with a specific,
non-secret-bearing result. After approval,
the browser receives the durable HttpOnly device session described below.

When no browser is trusted yet, the waiting screen includes a local operator
command containing only the short-lived request ID. Run it in a terminal on the
Station host or over SSH:

```bash
station environment access list
station environment access approve <request-id>
```

Use `./station` instead of `station` when running from a source checkout. A
custom instance must be targeted with the same home and server port that
started it, for example:

```bash
STATION_HOME=/path/to/station-home STATION_PORT=4141 \
  ./station environment access approve <request-id>
```

The equivalent explicit form is `--api-base=http://127.0.0.1:4141` together
with the matching `STATION_HOME`. Before sending authorization, the CLI compares
the public environment identity and checks a fresh nonce/HMAC response against
that home's operator credential. These checks do not make an independently
untrusted destination safe. Select the home and listener you operate.

The command loads the operator credential inside the host process, sends it
only to the loopback Station API, asks for interactive confirmation, and prints
only request metadata. It refuses a non-loopback `--api-base`. For scripted SSH,
`--latest --force` is available as an explicit noninteractive choice; it should
be used only after reviewing `access list`. `access deny` uses the same local,
non-secret boundary.

At the end of onboarding or in the Connections modal, choose **Connect another device** to invite a phone
to the selected Station server. The existing client and the phone both connect
to that server; the existing client does not become a server. Check the visible
server address: the phone needs a reachable LAN or tailnet address, not localhost.
The panel warns when the address is a loopback one, and remembers the last
reachable address an offer was created with for that Station, offering it back
as the field's starting value the next time (#2228).
Choose **Create pairing code**, scan with the phone camera to open the selected
installed Station channel, then review and approve the request. For Station’s
in-app scanner, select **Scanner inside Station** above the QR instead.
**Paired devices → Approve another device** also opens the invitation panel.
The selected client channel controls both the app-opening QR and any published
mobile download links. Public store and beta invitation URLs are maintained in
`packages/connect/src/core/mobileAppDownloads.ts`; absent destinations have no
install link. Native clients default to their own release channel. Station
creates a five-minute, single-use offer containing an environment ID, endpoint,
one-time challenge, selected scope and expiry. The interactive UI defaults to
**Standard** (`orchestration:read orchestration:operate terminal:operate`) and
also offers **Read-only** (`orchestration:read`). `station:interactive` is a
legacy marker migrated to the historical default grant, not the new UI's
scope string. HTTPS is accepted; the offer service also accepts local/private
HTTP endpoints. The current in-app QR decoder is narrower: it accepts HTTPS or
strict-loopback HTTP, and rejects a nonloopback LAN HTTP offer even if the server
created it. Use a reachable HTTPS endpoint for that scan flow. Browser camera
and mixed-content restrictions still apply. The
QR contains that offer only—never a bearer credential. A 10-character manual
code plus the Station address is available when camera access is unavailable.

On the other device, choose **Scan a QR code** or **Enter a pairing code**, and
name the device. The host must confirm the displayed name and scope. Only then
can the browser atomically exchange the offer once for a random device
credential. When
the Station endpoint is the browser's own origin, the server returns only safe
device/environment metadata and stores that credential in a host-only,
persistent `HttpOnly` `SameSite=Strict` cookie. Closing and reopening the phone
browser can therefore retain the pairing while that cookie remains present,
valid and unrevoked. Cross-origin and native exchanges support bearer delivery;
Station's native host captures and holds it outside the WebView.
Expired, denied, cancelled, altered, replayed, and unconfirmed offers are
rejected.

Use the paired-device inventory in the same host panel to revoke one device.
Revocation makes the credential fail subsequent authenticated HTTP, SSE and
remote WebSocket admission without rotating the operator credential or revoking
other devices. Existing streams have their own revalidation boundaries; this is
not a guarantee that revocation closes every already admitted socket. It does
not recall data already delivered or guarantee cancellation of effects already
dispatched. Ordinary paired
credentials cannot create pairing offers or revoke other devices. A device
explicitly granted `access:approve` can list and decide pending requests; that
does not grant device-inventory or offer-management access. The native desktop's
local grant, minted using proof of Station-home possession, can manage pairing
within its current scope. Browser launcher grants do not inherit that authority.

The host-managed `station environment credential rotate` path replaces the
operator credential, preserves the environment ID and paired-device registry,
and prints the new secret to stdout after confirmation. Keep that output out of
logs and shared terminals. `station environment reset` replaces the environment
ID and operator credential and clears paired-device authority; its output is
metadata rather than the new credential. Both support explicit `--force` to
bypass the prompt. The separately installed CLI refuses these operations when
no host security service is supplied; use the host's repository launcher or
management UI. If a web session is revoked or its site data is cleared, pair
again. The owners are the
[CLI dispatcher](../../packages/cli/src/commands/environment.ts),
[security service](../../src-server/services/ssh/environment-security-service.ts),
[pairing service](../../src-server/services/ssh/device-pairing-service.ts), and
[scope contract](../../packages/contracts/src/environment-security.ts).

#### `markDeviceSession(id: string): void`

Records that a same-origin profile is authorized by its server-owned browser
session without serializing credential material into the connection store.

#### `removeCredential(id: string): void`

Removes the saved credential and returns a remote Station to the
credential-required state.

#### `setActive(id: string): boolean`

Selects a saved direct connection and stamps `lastConnected`; returns `false`
for an unknown ID or a broker route. Selecting the injected host entry clears
the saved active pointer and returns `true`. Broker routes use the React host's
asynchronous preparation path before the store marks them active.

#### `subscribe(fn: () => void): () => void`

Registers a change listener. Returns an unsubscribe function. Used internally by `ConnectionsProvider`.

```ts
const unsub = store.subscribe(() => console.log('changed'));
unsub(); // cleanup
```

#### `migrate(legacyKey: string): void`

Reads a URL stored under a legacy single-URL key and imports it when no saved
entry has the same URL. It retains the legacy key, so repeated calls do not
delete the old client's fallback or duplicate the same entry.

```ts
store.migrate('project-station-api-base');
```

### example

```ts
const store = new ConnectionStore();
const conn = store.add('Local Dev', 'http://192.168.1.10:3141');
store.setActive(conn.id);
console.log(store.getActive()?.url); // 'http://192.168.1.10:3141'
```

For a remote connection, Station Connect first fetches the public handshake
without authorization. It then uses the saved credential for protected HTTP
and fetch-SSE requests and the versioned first application frame for terminal
and voice WebSockets. A `401` returns the connection to its masked
credential-required recovery state. Reconnect/session continuity beyond this
credential recovery is tracked in #303.

The pairing client and UI health probe observe
`compatibility.capabilities.clientProtocolHeader` in the public handshake
before protected requests. The shared
[header policy](../../packages/shared/src/client-protocol.ts) sends
`X-Station-Client-Protocol` cross-origin in a browser only after that host
advertises a numeric capability of at least 1. An absent capability removes
the process-local observation; it is not persisted across page loads. The UI
also clears the previous observation when a handshake starts. Only the
latest-started handshake per origin may restore acceptance. Its non-OK
response, invalid JSON or transport error leaves acceptance cleared, even if
an older overlapping handshake succeeds. The next cross-origin request then
carries no protocol header.
Same-origin, Node and host-owned transport requests can carry the header
without CORS negotiation. The SDK replaces any caller-supplied copy with its
build's protocol. These declarations grant no credential or scope.

The host checks paired-scope HTTP and the public pairing request,
access-request and exchange before credentials: below `minClientProtocol` is
`426 client_protocol_unsupported`, malformed is `400 client_protocol_invalid`,
and absent means protocol 1. The handshake remains reachable. A protocol
refusal requires correcting/updating the client rather than re-pairing to gain
authority. Protocol refusals use a separate direct-socket-peer audit budget
(default: 10 per 60 seconds), reusing the existing limiter and its 1,024-peer
cap. Exhaustion suppresses only audits while every refusal receives 400/426.
Refusals neither consult nor consume the authentication budget.
The separate native Rust pairing exchange and direct fetch callers
remain undeclared; terminal/voice WebSockets are outside this HTTP check.

See the [remote access threat model](../security/remote-access-threat-model.md)
for the protocol, public/protected surface matrix, and operator recovery steps.

---

## react

### `ConnectionsProvider`

Context provider that wraps a `ConnectionStore` and exposes it to the component tree. Creates a module-level singleton store on first render if no `store` prop is passed.

```tsx
import { ConnectionsProvider } from '@kontourai/station-connect';

<ConnectionsProvider
  defaultUrl="http://localhost:3141"  // used when no persisted data exists
  store={optionalCustomStore}         // optional: bring your own store
>
  {children}
</ConnectionsProvider>
```

**props**

| prop | type | default | description |
|---|---|---|---|
| `defaultUrl` | `string` | `'http://localhost:3141'` | Fallback URL when no connections are saved |
| `store` | `ConnectionStore` | module singleton | Custom store instance |
| `children` | `ReactNode` | — | — |

---

### `useConnections()`

Returns the full connections context. Must be called inside `ConnectionsProvider`.

```ts
const {
  connections,        // SavedConnection[]
  activeConnection,   // SavedConnection | null
  apiBase,            // string — active URL (backward-compat alias)
  addConnection,      // (name, url) => SavedConnection
  removeConnection,   // (id) => void
  updateConnection,   // (id, changes) => void
  setActiveConnection,// (id) => Promise<void>; host transport preparation can reject
  setApiBase,         // (url) => void — upsert by URL and activate
  resetToDefault,     // () => void — activate or create the defaultUrl connection
  isCustom,           // boolean — true when active URL !== defaultUrl
} = useConnections();
```

**example**

```tsx
function ServerPicker() {
  const { connections, activeConnection, setActiveConnection } = useConnections();
  return (
    <select
      value={activeConnection?.id}
      onChange={(e) => setActiveConnection(e.target.value)}
    >
      {connections.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}
```

---

### `useConnectionStatus(options)`

Polls a health-check function against the active connection URL and returns the current status.

**signature**

```ts
function useConnectionStatus(options: UseConnectionStatusOptions): ConnectionStatusResult
```

**types**

```ts
interface UseConnectionStatusOptions {
  checkHealth: (url: string, credential?: string) => Promise<boolean>;
  probeEndpoint?: (
    url: string,
    credential: string | undefined,
    expectedEnvironmentId: string | null,
    signal: AbortSignal,
    brokerRoute?: NonNullable<SavedConnection['brokerRoute']>,
  ) => Promise<ConnectionHealthCheckResult>;
  pollInterval?: number; // ms, default: 10_000
}

interface ConnectionStatusResult {
  status: ConnectionStatus;
  checking: boolean;          // true while a check is in flight
  reason: ConnectionFailureReason | null;
  failureStreak: number;
  failureWindows: ReadonlyArray<{
    start: string;
    end: string;
    reason: ConnectionFailureReason;
  }>;
  blocked: boolean;           // true on a terminal failure (e.g. authentication-failed);
                               // the automatic retry ladder is paused until recheck(),
                               // a credential change, or the browser regaining network
  recheck: () => void;        // manually trigger a check
}
```

**example**

```tsx
const { status, recheck } = useConnectionStatus({
  checkHealth: hostCheckHealth,
  probeEndpoint: hostProbeEndpoint,
  pollInterval: 15_000,
});
```

The two callbacks above are supplied by the embedding host; they are not
package exports. The host must preserve selected-connection authentication,
identity checks, cancellation and failure reasons. Station's own caller uses
authenticated `/api/system/status`, not an unauthenticated `/api/health`
endpoint. See [the host health adapter](../../src-ui/src/lib/serverHealth.ts).

---

### `useHostUrl(options)`

Attempts to derive an address from `RTCPeerConnection` ICE candidates and
returns a URL hint. Falls back to `localhost` if detection fails or times out
(3 s). This does not prove that a Station server is listening or reachable,
and a URL hint is not a pairing offer accepted by `QRScanner`.

**signature**

```ts
function useHostUrl(options: UseHostUrlOptions): UseHostUrlResult
```

**types**

```ts
interface UseHostUrlOptions {
  port: number;
  fallback?: string; // default: `http://localhost:${port}`
}

interface UseHostUrlResult {
  hostUrl: string;      // e.g. 'http://192.168.1.42:3141'
  isDetecting: boolean; // true while ICE gathering is in progress
}
```

**example**

```tsx
const { hostUrl, isDetecting } = useHostUrl({ port: 3141 });

return isDetecting
  ? <span>Detecting IP…</span>
  : <span>Candidate address: {hostUrl}</span>;
```

---

### Connection candidate providers

Native shells and trusted host adapters can register LAN DNS-SD, tailnet, or
desktop-host providers. A provider returns secret-free reachability hints; it
does not grant trust. The connection manager still performs the public Station
identity handshake and pairing flow before saving or using a new environment.

**signature**

```ts
function registerConnectionCandidateProvider(
  provider: ConnectionCandidateProvider,
): () => void

function useConnectionCandidates(): UseConnectionCandidatesResult
```

**types**

```ts
interface ConnectionCandidateProvider {
  id: string;
  discover(context: { signal: AbortSignal }): Promise<Array<{
    candidateVersion: 1;
    name: string;
    url: string;
    source: 'lan-dns-sd' | 'tailnet' | 'desktop-host';
    discoveredAt: number;
  }>>;
}

interface UseConnectionCandidatesResult {
  discovering: boolean;
  candidates: ConnectionCandidate[];
  providers: ConnectionCandidateProviderResult[];
  providerCount: number;
  refresh: () => void;
}
```

Candidate URLs are reduced to HTTP/HTTPS origins. URLs containing credentials,
invalid names, and malformed results are discarded. Tailnet candidates
rank ahead of LAN and desktop-host hints, and duplicate origins collapse to one
suggestion. A failing provider is isolated from healthy providers.

**example**

```tsx
const unregister = registerConnectionCandidateProvider(nativeDnsSdProvider);
const { candidates, refresh } = useConnectionCandidates();
```

Plain browsers do not register a provider by default and never enumerate a
guessed subnet or probe a hard-coded port. Manual address and pairing-code
entry remain available under Advanced connection options.

The former `useNetworkDiscovery` and `DiscoveredServer` exports remain as
deprecated source-compatibility adapters. The hook reads the same registered
providers and does not perform its former browser subnet scan. New callers
should use `useConnectionCandidates`.

---

## components

### `ConnectionManagerModal`

Full-featured modal for managing connections. Includes one-time host/device
pairing, manual endpoint add, and provider-backed connection suggestions.

**selected props**

```ts
import type { ReactNode } from 'react';

interface ConnectionManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  checkHealth: (url: string, credential?: string) => Promise<ConnectionHealthCheckResult>;
  checkCompatibility?: (url: string, signal?: AbortSignal) => Promise<StationCompatibilityResult>;
  activeHealth?: {
    connectionId: string;
    status: 'connecting' | 'connected' | 'error' | 'idle';
    reason?: ConnectionFailureReason | null;
  };
  guardConnectionChange?: (proceed: () => void) => void;
  initialPanel?: 'list' | 'add' | 'request-access' | 'pair-device' | 'pair-code' | 'pair-host' | 'devices' | 'discover';
  initialPairingPayload?: string;
  listFooterContent?: ReactNode;
}
```

Must be rendered inside `ConnectionsProvider`.
`listFooterContent` lets a host render optional, host-owned setup content in the
Stations list footer. It appears only on the list panel; the connection manager
does not interpret the content or change pairing and address flows.

**example**

```tsx
<ConnectionManagerModal
  isOpen={showModal}
  onClose={() => setShowModal(false)}
  checkHealth={hostCheckConnectionHealth}
  checkCompatibility={hostCheckCompatibility}
  activeHealth={hostActiveConnectionHealth}
  guardConnectionChange={hostGuardUnsavedWork}
/>
```

`hostCheckConnectionHealth` is the host's authenticated adapter. Prefer a
structured failure reason to a bare `false`; credential refusal and an
unreachable server need different recovery. See the
[complete prop contract](../../packages/connect/src/react/ConnectionManagerModal.tsx)
for compatibility checks and native-host integration options.

The compatibility checker is required for adding a Station or completing
pairing: omitting it blocks those flows with an integration error. Bind
`activeHealth` to the selected connection's ID and its live health snapshot;
the manager ignores it for another connection. Without that snapshot, an
unchecked row is idle rather than claiming an in-progress connection.
Opening a row reveals details without changing the selected Station. Its
explicit **Switch to this Station** action passes through
`guardConnectionChange`; the host calls `proceed` only after its unsaved-work
decision allows the change. Hosts that omit this optional guard supply no
unsaved-work interception at this boundary. The manager offers an access
request for a missing or rejected credential, rather than for every saved
connection.

The [store](../../packages/connect/src/core/ConnectionStore.ts),
[profile normalizer](../../packages/connect/src/core/connectionProfile.ts), and
[React context](../../packages/connect/src/react/ConnectionsContext.tsx) own
selection and migration. A broker profile has no direct HTTP endpoints and
requires the host's `prepareActiveConnection` callback; failed preparation does
not select it. The native host's
[pairing transport](../../src-ui/src/platform/native/pairingTransport.ts) and
[profile storage](../../src-ui/src/platform/native/stationProfileStorage.ts)
own its credential custody. These source boundaries do not prove a completed
pairing or reconnection on a physical device.

---

### `QRDisplay`

Renders a QR code canvas for a supplied value using the `qrcode` package. The
historical `url` prop name remains for compatibility; device pairing passes an
opaque short-lived offer payload.

**props**

```ts
interface QRDisplayProps {
  url: string;
  size?: number;  // px, default: 160
  label?: string; // optional caption below the QR code
}
```

**example**

```tsx
<QRDisplay url={pairingPayload} size={200} label="Scan pairing invitation" />
```

Here `pairingPayload` is the short-lived offer returned by the host's pairing
flow. Displaying a raw address as a QR code does not create such an offer.

---

### `QRScanner`

Opens the device camera and decodes QR codes using `jsqr`. Calls `onScan` only
for a schema-valid, unexpired `station-pairing:v1` offer. Raw endpoint URLs are
not accepted. Camera access requires a secure context (HTTPS or localhost); the
connection modal always exposes the accessible manual-code fallback.

**props**

```ts
interface QRScannerProps {
  onScan: (payload: string) => void;
  onCancel: () => void;
  onManualEntry?: () => void;
}
```

**example**

```tsx
<QRScanner
  onScan={(payload) => joinPairingOffer(payload)}
  onCancel={() => setShowScanner(false)}
/>
```

---

### `ConnectionStatusDot`

A small status indicator. Pairing/repair states use a triangle; the remaining
states use a circle. Hosts should also show an accessible label and remedy.

**props**

```ts
interface ConnectionStatusDotProps {
  status: ConnectionIndicatorState;
  size?: number;            // px, default: 8
}
```

`ConnectionIndicatorState` includes `connected` (green), `connecting` and
`busy` (yellow), `error` (red), `idle` (gray), and `needs-credential`,
`awaiting-approval`, `needs-repair` (amber). The two `needs-*` states use the
triangle. This richer UI state is distinct from `ConnectionStatus`.

**example**

```tsx
<ConnectionStatusDot status="connected" size={10} />
```
