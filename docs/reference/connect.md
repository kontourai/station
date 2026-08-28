# @kontourai/station-connect

Multi-device connectivity package. Handles stable Station identity, host-
confirmed one-time device pairing, scoped credential storage, revocation, and
connection persistence. Framework-agnostic core with optional React bindings.

For how this pairing relationship differs from an SSH environment's
delegated-execution relationship — direction, trust model, and what persists
where — see
[docs/guides/machine-relationships.md](../guides/machine-relationships.md).

---

## types

### `SavedConnection`

A persisted server connection entry.

```ts
interface SavedConnection {
  profileVersion: 4;
  id: string;
  name: string;
  url: string; // compatibility alias for the selected endpoint
  endpoints: AccessEndpoint[];
  selectedEndpointId: string;
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
field (archive#1095), which is a server-advertised map of named boolean
feature flags (e.g. `sshEnvironments`, `webPushNotifications`) used for
feature detection across a rolling client/server upgrade. See
[docs/security/remote-access-threat-model.md](../security/remote-access-threat-model.md#surface-matrix)
for that field's schema and absence-means-unsupported semantics, and
`hasCapability()` from `@kontourai/station-sdk` for reading it.

Changing a verified environment's endpoint stages an untrusted candidate. On
explicit confirmation, Connect sends a fresh 256-bit nonce (never the bearer)
to `POST /.well-known/station/v1/proof` and verifies the returned,
domain-separated HMAC locally with the saved credential. The endpoint changes
only when the environment id, nonce, protocol version, and signature all match.
Remote candidates must use HTTPS; cleartext HTTP is accepted only for strict
loopback hosts.

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
outage, but it is explicitly stale and read-only. The SDK rejects mutations
before `fetch` while stale and keeps no outbox, so blocked changes are never
silently replayed after recovery.

### `ConnectionSupervisor`

A standalone, transport-agnostic connection state machine: `available ->
connecting -> connected`, with `backoff` (transient failure, retry scheduled
on a 1/2/4/8/16s ladder that resets after 30s of stable connection), `blocked`
(terminal failure — currently just an auth rejection — which never retries
automatically), and `offline` (no network). It is driven entirely by typed
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
on `ConnectionHealthSnapshot` / `ConnectionStatusResult`) instead of hot
looping against a stale credential. It resumes on the next explicit
`trigger()` — already reachable through a manual "Try now", the browser
regaining network, or (new) a saved-credential change — closing the specific
hot-loop-on-401 gap this mechanism exists to fix. A full engine swap (the
coordinator's own multi-endpoint polling loop driven end-to-end by a live
`ConnectionSupervisor` instance, including its `offline`/wake-probe
semantics) is deliberately out of scope for this first adoption to avoid
regressing the proven polling behavior; a per-environment supervisor
*registry* (one instance per environment, reusable beyond health polling) is
tracked separately (archive#1096).

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
type ConnectionStatus = 'connected' | 'connecting' | 'error';
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
persistent `HttpOnly` cookie that JavaScript cannot read. Native clients should
inject a keychain-backed `StorageAdapter`.

---

## ConnectionStore

Framework-agnostic store for managing saved connections. Compatible with React's `useSyncExternalStore` via the `subscribe` method.

```ts
import { ConnectionStore } from '@kontourai/station-connect';

const store = new ConnectionStore({
  storage?: StorageAdapter,   // default: defaultStorage
  credentialStorage?: StorageAdapter, // default: session storage
  storageKey?: string,        // default: 'station-connect-connections'
});
```

Profile and credential adapters must remain separate in production. A device
credential is never serialized in a `SavedConnection`, endpoint URL, QR value,
query string, or ordinary connection-profile localStorage record.

### methods

#### `getAll(): SavedConnection[]`

Returns all saved connections. Result is referentially stable between writes (cached).

#### `getActive(): SavedConnection | null`

Returns the currently active connection, or the first connection if no active ID is set.

#### `add(name: string, url: string): SavedConnection`

Adds a new connection and activates it. If a connection with the same URL already exists, activates it instead and returns the existing entry.

#### `remove(id: string): void`

Removes a connection by ID. If it was active, the first remaining connection becomes active.

#### `update(id: string, changes: Partial<Pick<SavedConnection, 'name' | 'url'>>): void`

Updates the name or URL of an existing connection.

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
the public environment identity and verifies a fresh nonce/HMAC proof. A wrong
port, wrong home, redirect, or copied environment ID fails without sending the
credential.

The command loads the operator credential inside the host process, sends it
only to the loopback Station API, asks for interactive confirmation, and prints
only request metadata. It refuses a non-loopback `--api-base`. For scripted SSH,
`--latest --force` is available as an explicit noninteractive choice; it should
be used only after reviewing `access list`. `access deny` uses the same local,
non-secret boundary.

QR and manual pairing remain under **Advanced connection options** for devices
that cannot open the Station URL first. Use **Approve another device** on the
host. Station creates a five-minute, single-use offer containing an environment
ID, intended HTTPS endpoint,
one-time challenge, conservative `station:interactive` scope, and expiry. The
QR contains that offer only—never a bearer credential. A 10-character manual
code plus the Station address is available when camera access is unavailable.

On the other device, choose **Pair with code**, scan or enter the offer, and
name the device. The host must confirm the displayed name and scope. Only then
can the browser atomically exchange the offer once for a random device
credential. When
the Station endpoint is the browser's own origin, the server returns only safe
device/environment metadata and stores that credential in a host-only,
persistent `HttpOnly` `SameSite=Strict` cookie. Closing and reopening the phone
browser therefore keeps the device paired without exposing a token to
JavaScript. Cross-origin and native clients retain explicit bearer delivery.
Expired, denied, cancelled, altered, replayed, and unconfirmed offers are
rejected.

Use the paired-device inventory in the same host panel to revoke one device.
Revocation is checked by the shared HTTP/SSE/WebSocket credential verifier and
takes effect immediately without rotating the operator credential or revoking
other devices. Paired credentials cannot administer pairing offers or revoke
other devices. `station environment credential rotate` rotates operator
bootstrap authority without silently exporting it; `station environment reset`
changes the environment ID and clears all paired-device authority. If a web
session is revoked or its site data is cleared, pair again.

#### `markDeviceSession(id: string): void`

Records that a same-origin profile is authorized by its server-owned browser
session without serializing credential material into the connection store.

#### `removeCredential(id: string): void`

Removes the saved credential and returns a remote Station to the
credential-required state.

#### `setActive(id: string): void`

Sets the active connection and stamps `lastConnected` with the current timestamp.

#### `subscribe(fn: () => void): () => void`

Registers a change listener. Returns an unsubscribe function. Used internally by `ConnectionsProvider`.

```ts
const unsub = store.subscribe(() => console.log('changed'));
unsub(); // cleanup
```

#### `migrate(legacyKey: string): void`

One-time migration helper. Reads a URL stored under a legacy single-URL key, imports it as a connection, and removes the old key.

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
credential recovery is tracked in archive#303.

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
  setActiveConnection,// (id) => void
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
  checkHealth: (url: string) => Promise<boolean>;
  pollInterval?: number; // ms, default: 10_000
}

interface ConnectionStatusResult {
  status: ConnectionStatus;   // 'connected' | 'connecting' | 'error'
  checking: boolean;          // true while a check is in flight
  reason: ConnectionFailureReason | null;
  blocked: boolean;           // true on a terminal failure (e.g. authentication-failed);
                               // the automatic retry ladder is paused until recheck(),
                               // a credential change, or the browser regaining network
  recheck: () => void;        // manually trigger a check
}
```

**example**

```tsx
const { status, recheck } = useConnectionStatus({
  checkHealth: async (url) => {
    const res = await fetch(`${url}/api/health`).catch(() => null);
    return res?.ok ?? false;
  },
  pollInterval: 15_000,
});
```

Resets to `'connecting'` whenever the active URL changes.

---

### `useHostUrl(options)`

Detects the device's LAN IP via `RTCPeerConnection` ICE candidates and returns a host URL suitable for QR display. Falls back to `localhost` if detection fails or times out (3 s).

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
  : <QRDisplay url={hostUrl} />;
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
invalid names, and malformed results are discarded. HTTPS tailnet candidates
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
deprecated source-compatibility adapters in `0.4.x`. The hook now reads the
same registered providers and never performs its former browser subnet scan;
move callers to `useConnectionCandidates` before the next major release.

---

## components

### `ConnectionManagerModal`

Full-featured modal for managing connections. Includes one-time host/device
pairing, manual endpoint add, and provider-backed connection suggestions.

**props**

```ts
interface ConnectionManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  checkHealth: (url: string) => Promise<boolean>;
  initialPanel?: 'list' | 'add' | 'pair-device' | 'pair-host' | 'discover';
}
```

Must be rendered inside `ConnectionsProvider`.

**example**

```tsx
<ConnectionManagerModal
  isOpen={showModal}
  onClose={() => setShowModal(false)}
  checkHealth={async (url) => {
    const res = await fetch(`${url}/api/health`).catch(() => null);
    return res?.ok ?? false;
  }}
/>
```

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
<QRDisplay url="http://192.168.1.42:3141" size={200} label="Scan to connect" />
```

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

A small colored circle indicating connection status.

**props**

```ts
interface ConnectionStatusDotProps {
  status: ConnectionStatus; // 'connected' | 'connecting' | 'error'
  size?: number;            // px, default: 8
}
```

Colors: `connected` → green (`#22c55e`), `connecting` → yellow (`#eab308`), `error` → red (`#ef4444`).

**example**

```tsx
<ConnectionStatusDot status="connected" size={10} />
```
