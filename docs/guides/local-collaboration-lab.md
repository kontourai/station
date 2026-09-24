# Free local collaboration lab

> Status: transport/enrollment and real local-account/member scenarios are
> implemented. The optional encrypted account diagnostic also exercises an
> explicitly account-bound Device. Shared content, UI, compute and plugin
> integration remains under
> [#1985](https://github.com/kontourai/station/issues/1985) and its feature owners.

Use this lab to test the [connection broker's confidentiality boundary](../design/connection-broker.md)
with local software. It needs the repository's pinned Node/dependency setup and
OpenSSL 1.1.1 or newer with `req -addext` support. No cloud account, Tailscale
login, paid identity service, model credential or external model request is used.

From an isolated development worktree:

```bash
npm run dependencies:ci
npm run lab:collaboration -- --check=security
```

The command starts two disposable Station **security endpoints**, exercises the
checks, and stops its listeners and owned relay processes. These endpoints reuse
the production environment-security store, device pairing routes and HTTP
authorization middleware. They are not two complete Station applications.
The lab adds a fixture-only probe under the existing read-authorized Project
route family; it does not implement Project membership or serve the normal UI.

Each endpoint gets an ephemeral key/certificate and security home. Node clients
pin their selected endpoint's certificate, verify its hostname, and require
TLS 1.3. Separate TCP relay processes forward the encrypted bytes without
receiving endpoint keys or application credentials. No OS trust store changes
or certificate-verification bypasses are used.

The security check covers:

- Two synthetic people, with two independent devices explicitly bound to one
  of them; a separate unbound pairing remains unbound.
- Real operator approval and one-time HTTP credential exchange, with replay
  refused. Synthetic verified-identity provenance enters only through a private
  fixture call to the pairing store; no production identity header is fabricated.
- Read-only grants, refusal of mutations/device administration, and refusal of
  one Station's credential at the other Station.
- Wrong endpoint certificate and tampered TLS traffic rejected before the
  application receives a request.
- Independent device revocation and persisted binding/revocation after the
  security store is reopened.
- Direct access with the relay stopped, and reconnection through a replacement
  relay while retaining the intended Station's certificate trust.
- Authenticated TLS peer checks and bounded relay captures that contain none
  of the test application's plaintext markers or credentials. A missing
  plaintext substring alone is not treated as encryption proof.

## Real local accounts and Project membership

The account scenario uses two actual Station source processes, two isolated
browser profiles, the built-in local account provider, and the published SDK
account/Project APIs. It needs the pinned Node/dependency setup and Chromium;
OpenSSL is only required by the separate security scenario.

```sh
npm run dependencies:ci
npm run install:playwright
npm run lab:collaboration -- --check=accounts
```

The fixture creates fresh Station homes, OS-home/config/cache directories and
empty dotenv files. Source execution uses the repository's schema and TypeScript
configuration. It waits for the real listener handshake and verifies the existing
Station challenge-response proof before presenting the operator credential, then
checks the boot, instance and source-checkout identity. This is source-runtime
acceptance, not proof of a packaged desktop/mobile release.

The controller creates Projects and invitations with each fixture Station's own
operator credential. Guests use the SDK in actual browser origins with native
HttpOnly cookie handling; no operator credential enters their pages and no
cookie is copied into a virtual transport. These are API journeys, not rendered
onboarding/UI acceptance. The built-in account provider runs without mail, a
hosted identity account or model credentials.

The scenario checks:

- Invitation-only registration, sign-in and two distinct issuer-qualified people.
- Explicit viewer/contributor membership. A consumed invitation is refused for
  the other authenticated person before that person accepts their own invitation.
- A cancelled invitation is refused for a revoked member who could otherwise
  accept it. Caller-supplied contact claims and unverified local usernames cannot
  satisfy a contact-restricted invitation.
- A fresh invitation from Station A is refused at Station B and remains usable
  at A. Current member revisions work; stale revisions cannot overwrite them.
- Membership acceptance reports `grantsDeviceAccess: false`; the actual paired
  device list stays empty. Account-authenticated guests still receive 401 on
  private Project and operator routes without an approved Device grant.
- Restarting the real Station preserves account identity, cookies, membership and
  revocation. Account session revocation and disable/enable invalidate old cookies
  while preserving membership and another person's session. The final sign-in
  waits across the provider's normal ten-second rate-limit window; the limiter
  is not disabled or replaced with a test clock.

The two Station origins use `127.0.0.1` and `localhost` as distinct hostnames:
[cookies are not isolated by port](https://www.rfc-editor.org/rfc/rfc6265#section-8.5).
The same username registered independently at the other Station has a different
issuer-qualified identity. That login does not inherit the first Station's
Project membership.

Account lab runs hold a cooperating fixture lease through startup, stop and
restart. Each process has an isolated four-port listener block and a bounded
lifetime. A fixture-only Node TCP guard permits its own listeners and an owned
positive-control probe; a second owned probe must be refused with the specific
guard error and receive no request. This prevents the scenario from contacting
model services or background registry endpoints through Node TCP. It is a
portable diagnostic restriction, not an OS sandbox or hostile-plugin boundary.
Expected blocked background metadata refreshes may appear in private process
logs. Teardown uses the existing owned-process implementation and preserves an
unrelated listener in the CLI acceptance test.

Run `--check=all` to execute both available stages. They currently use separate
pairs of disposable homes; the report names each stage under `scenarios` and
marks unselected stages `not-run`. The full command still exits 3 because approved
Device/content access, compute/plugin integration, the production relay adapter
and real-human/native/network acceptance are not complete. The account stage
uses direct loopback HTTP. The separate `--application-accounts` browser
transport profile below exercises the landed continuation contract through an
encrypted application channel.

## Output and retained evidence

Success prints a `STATION_LOCAL_LAB_REPORT` JSON line with
`status: "passed"` and the selected scope: `transport-and-enrollment-fixture`,
`account-and-membership-runtime`, or `local-collaboration-stages`.
`fullScenario.status` remains `incomplete`. A security-fixture pass is not a
shared-Project acceptance receipt.

```bash
npm run lab:collaboration -- --check=security --keep
npm run lab:collaboration -- --check=all
```

`--keep` retains the disposable home and prints its path. `--check=all` runs the
available security checks, records missing capabilities and exits **3** until
the full scenario exists. Failures exit **1**, retain private `failure.txt`
diagnostics, and never print assertion payloads that could contain fixture
credentials. Successful security-only runs without `--keep` remove their own
temporary state. Retained homes contain disposable private keys and credentials;
share the report instead of the whole home.

Ports are allocated on loopback and exclude the user's 3000/3141 services.
Ctrl-C requests cleanup of lab-owned resources. Relay processes also have a
two-minute maximum lifetime if their coordinator disappears. The command does
not adopt, stop or delete existing Stations. It requires no permanent service
or global network configuration.

## Remaining acceptance

### Browser transport evaluation

An optional profile exercises a real Chromium browser against a Node WebRTC
peer through local coturn allocations. It evaluates the encrypted transport;
the Node peer echoes fixture content and does not expose a Station application
or Project API.

Prerequisites are the repository's dependencies, OpenSSL, a local Docker engine
at its default local socket/pipe, and Playwright's Chromium installation:

```bash
npm exec -- playwright install chromium
npm run lab:browser-transport
npm run lab:browser-transport -- --keep
```

The profile uses the pinned official coturn image by digest, with an isolated
Docker configuration and loopback-only published control ports. No hosted
account or model is involved. Its relay allocations stay inside the container;
both WebRTC peers are required to select relay candidates. The container runs
as the image's non-root user, with a read-only root, bounded temporary storage,
process/memory/CPU limits, and only `NET_BIND_SERVICE` retained because the
official binary carries that file capability. It receives no application keys.
The container and capture process have a two-minute lifetime ceiling. Ordinary
completion stops/removes the exact owned container and stops the capture child.
An operation-specific owner label is recorded before container allocation, and
cleanup verifies the owner, exact container name and pinned image before acting.
`--fail-after-create` is a negative lifecycle diagnostic: it injects a failure
after allocation and loses the returned ID so cleanup must resolve the original
operation safely. It must exit 1, remove its own container and preserve any
unrelated container; a nonzero exit alone does not prove successful cleanup.

Each run generates two distinct endpoint certificates. Approved fingerprint
trust is supplied independently by the fixture controller.

The controller initializes an isolated Station security home, creates a separate
signing identity, then reopens its private key store before issuing proofs. It
supplies only the public descriptor to the browser's fixture trust owner. This
checks persistence and reuse of the existing Station identity; it does not
implement a production key-approval UI. Before
accepting SDP, the browser verifies a 30-second ES256 connection proof against
its own nonce/connection ID, the admitted Station generation, both fingerprints
and the exact offer/answer bytes. Altered proofs and successful-proof replay
are refused. This uses maintained JOSE and browser WebCrypto. It models the
[connection-proof contract](../design/connection-broker.md#connection-proof-contract);
the private fixture callback is not a production account or key-enrollment API.
The full gathered SDP is signed; extra unsigned candidate callbacks are not
forwarded as an implicit trust extension.

### Local operator signing-key commands

From a Station checkout, the operator can inspect an existing home's public
connection signing key or deliberately create it. Use an absolute home path;
the command never selects the default home or starts Station:

```sh
npm run connection:key -- inspect --home=/absolute/path/to/station-home
npm run connection:key -- initialize --home=/absolute/path/to/station-home
```

The home must already have its Station security identity. `inspect` is read-only
and exits 2 when that home's connection key has not been initialized. Initialization
preserves an existing valid key. Missing homes, corrupt keys and identity mismatches
are refused; initialization is not a recovery/reset command. Successful commands
emit one JSON report containing public `trust` metadata and its `keyId` (the
SHA-256 JWK thumbprint). Use `npm run --silent connection:key -- ...` when capturing
stdout as JSON. Exit 1 reports a closed refusal reason on stderr without private
key material, credentials, raw parser errors or home paths.

To rotate, supply the generation and key ID from the inspected report and
acknowledge that Devices will need independent approval of the new key:

```sh
npm run connection:key -- rotate --home=/absolute/path/to/station-home \
  --expected-generation=1 --expected-key-id='<keyId-from-inspect>' \
  --acknowledge-device-reapproval
```

Rotation compares the exact observed Station, enrollment, generation and public
key under the store's mutation lock. Concurrent or stale requests cannot rotate a
replacement key. It retains the Station/enrollment IDs, increments the generation
and replaces only the connection signing key. Ordinary direct credentials remain
independent. If output is lost after publication, inspect again; retrying the old
rotation inputs fails instead of rotating twice.

This is the **operator side** of key admission. A public report obtained solely
from an untrusted broker is not authenticated. Devices still need an independently
authenticated approval ceremony; printing a descriptor does not install Device
trust, link an account, enable a broker, or grant Project access. Rotation stops
new issuance with the retired key. An unreachable Device retaining the old public
key cannot learn revocation immediately: a previously minted proof may remain
verifiable for its remaining 30-second lifetime, and a compromised old private
key remains dangerous until that Device independently updates or revokes trust.
Automatic recovery, remote approval, Device trust persistence and established
channel termination are separate implementation work.

The command requires the existing private-home filesystem authority. It is not
a tenant sandbox, an OS keychain, or protection from another process running as
the same OS user. No network listener or telemetry is needed for this local
operation; the bounded public result is its receipt.

### Device-side signing trust

The browser client consumes `@kontourai/station-connect/connection-trust`.
Its `openDeviceConnectionTrustStore()` stores only public signing trust in the
current browser origin/storage partition. In **Manage Stations → Broker
routes**, a user can paste the public report from the Station operator's
`connection:key inspect` command into the separate Station signing key step.
The browser recomputes the JWK thumbprint, shows the complete key ID, and
requires the user to confirm that it was compared through a separate trusted
channel. This is an explicit user-attested ceremony; Station cannot establish
which human or channel supplied pasted text. Broker invitation data is never
used to create trust. The UI handles higher-generation rotation and revocation
through the existing revision-checked store. This does not implement account or
session transport.

The store exposes `read`, `approve`, `revoke`, `isCurrent`, and `close`.
`approve(descriptor, expectedRevision, approvedKeyId)` requires `null` for first
approval or the exact current revision for a change. The key ID is a SHA-256
JWK thumbprint, matching the local operator command above. A rotation within the
same enrollment must advance the generation and replace the key; stale revisions,
lower generations and changed enrollments are refused. Repeating the current
approved descriptor at its current revision is a no-op. A changed enrollment
requires a separate authenticated recovery design; there is no automatic reset.

`revoke(stationId, expectedRevision)` retains the last generation as a revoked
record. It cannot be overwritten as a new first approval or reactivated with the
same key. A later independently approved higher-generation key can restore trust.
The store contains at most 256 Station records, including revoked ones; reaching
the limit refuses additions while retaining the ability to revoke existing trust.
It stores no private keys, provider cookies, application continuations or Device
credentials and does not change direct connection profiles or Project membership.

Changes use a single IndexedDB transaction to compare and publish the revision
across tabs. Writes request `strict` durability, refuse a downgraded durability
mode, and resolve only after transaction completion. This follows the
[IndexedDB transaction contract](https://www.w3.org/TR/IndexedDB/#transaction-durability-hint);
it is not a verified power-loss or storage-backup guarantee. Missing/denied storage,
corrupt records, unsupported database versions and failed writes are explicit
failures, with no memory-only approval fallback. Call `close()` when the Device
connection owner is disposed.
An existing row containing `null` or `undefined` is corrupt, not a missing
approval; only a genuinely absent row can use the first-approval path.

The fixture verifies the signed proof, then awaits `isCurrent(snapshot)` before
accepting the peer description. An independent tab that revokes trust before
that check causes refusal before SDP acceptance or application content. This
check is not a synchronous replacement for the cryptographic verifier's
`isCurrent` predicate: both checks retain their respective owners. After the
storage await, `verifier.assertStillCurrent()` rechecks the consumed proof's
expiry and in-memory handshake authority before SDP acceptance; the storage
read cannot extend the signed proof's lifetime. It does not
promise continuous revocation of an already established channel; application
requests still require the account lane's current session/Device authorization.

Run the actual Chromium persistence and concurrency tests locally without TURN,
accounts or model calls:

```sh
npm run test:focused -- scripts/__tests__/device-connection-trust.test.ts
npm run test:mutation:smoke -- --case=device-trust-before-peer-acceptance
```

Those tests reopen a real persistent browser profile, race two tabs, check
rotation/revocation, and exercise denied storage, corruption and capacity. The
mutation command requires a clean linked worktree; it removes the caller's
post-crypto trust check, requires the named browser refusal test to catch that
defect, and restores the exact source before checking again. The
full browser transport command additionally proves cross-tab revocation against
an otherwise valid signed answer. Clearing browser data, restoring old browser
backups, same-origin malicious code and untrusted client-code distribution remain
outside this store's protection. Losing the store requires fresh independent
approval; discovery must not reconstruct trust automatically. Native shells and
other browser implementations require their own qualification.

### Browser security checks

The checks require:

- A browser DTLS connection to the approved certificate, with both sides using
  TURN and a fixture message delivered and echoed through the DataChannel.
- Refusal of a signaling description that advertises an unapproved fingerprint.
- An actual browser DTLS failure when a substitute endpoint advertises the
  approved fingerprint but presents its different certificate. A timeout does
  not satisfy this check.
- A nonempty, bounded capture on the Node peer's UDP relay path containing none
  of the fixture application marker. DTLS verification and the negative control
  are required in addition to the capture assertion.

The default profile uses **UDP TURN control on both peers**, verified locally
with Chromium 151.0.7922.34, `node-datachannel` 0.33.3, native `libdatachannel`
0.24.3, and coturn 4.18.0. These are observed test versions, not a cross-platform
support promise or a selected production adapter. The library is a development
dependency for this evaluation; no application transport is enabled by installing it.

The optional diagnostic `--browser-turn=tcp` retains a distinct failure path.
In the inspected setup, Chromium allocated through TURN/TCP but ICE failed
before DTLS with the Node peer using TURN/UDP. Configuring the packaged Node
peer itself for TURN/TCP produced no relay candidates. Do not infer TCP support
from the native API's option names, or silently fall back to UDP and report the
TCP scenario passed. The newer 0.33.4 release notes a separate handshake
reliability fix; the repository's dependency-age policy refused it at the time
of evaluation. The older eligible release is not production approval.

An independent **Pion peer profile** is available under `--peer=pion`. Build the
[pinned Go fixture](../../experiments/browser-transport-peer/README.md) first,
then run `npm run lab:browser-transport -- --peer=pion --browser-turn=tcp`.
Pion uses TURN/TCP; both TCP and UDP browser control paths must qualify
individually. The report includes the actual linked Pion/Go versions and binary
hash. This profile preserves the same approved-certificate, advertised-key and
actual DTLS-substitution checks. It uses an owned child process and the same
coturn/capture lifecycle rather than replacing Station's application server.

The native Node failure is tracked separately in
[#1995](https://github.com/kontourai/station/issues/1995). Captured Chromium
TURN/TCP Binding requests carried a present, zero-valued ICE-CONTROLLING
attribute. The packaged libjuice backend treats zero as absence and refuses the
request. A separate Chromium-to-Chromium TURN/TCP control passed; the Pion
profile permits qualification against another maintained ICE implementation.
The Node package's TURN/TCP option also requires a different native backend;
an exposed option is not evidence the installed binary implements it.

Success prints `STATION_BROWSER_TRANSPORT_REPORT` with the tested transport,
versions, capture size and completed checks. The report is published after
cleanup. Failure exits 1 and retains private protocol diagnostics; `--keep`
also retains successful evidence. Fixture ICE credentials and keys stay in the
private temporary home, not in the public report. Production key enrollment,
signaling authentication, renewal/recovery and native app delivery remain
separate delivery requirements. The fixture's out-of-band trust setup does not
implement those contracts. The optional application profiles below exercise
SDK framing and protected Station requests.

### SDK application framing over the encrypted channel

After the browser transport prerequisites above, run:

```sh
npm run lab:browser-transport -- --peer=node --browser-turn=udp --application-protocol
```

This optional profile runs the published SDK `authenticatedFetch` through
`@kontourai/station-connect/application-channel` over the already admitted
Chromium/Node DTLS connection. It sends a synthetic request to a protocol-only
fixture handler and verifies a streamed response larger than one wire chunk.
The relay capture must omit its request/response marker as well as the original
echo marker. The report labels `applicationProtocol` separately; ordinary
transport runs report it as `not-run`.

This is a Fetch/framing qualification, **not an account or full Station API
journey**. It does not grant a person, Device or Project authority. The Pion
profile supports the same option after building the pinned peer; its application
frames travel through private inherited pipes. Browser TURN/TCP and TURN/UDP
have separate local qualification receipts. Native/remote delivery must qualify
separately, and the full account/Device/Project profile follows below.

The initial wire profile has one request per reliable ordered DataChannel,
48 KiB JSON frames, at most 64 headers/16 KiB header text, and a **16 KiB request
body limit**. Larger uploads are unsupported in this pilot. Response chunks are
at most 16 KiB; consumer reads grant the next chunk. A producer chunk larger
than 1 MiB is refused. Browser and Node fixture send queues are bounded at
96 KiB. Opening a channel is bounded to 15 seconds and cancellation closes a
late opener before dispatch. The connection owner still bounds channel counts
and lifetime, admits endpoint trust and owns teardown.

The adapter checks endpoint trust before and after opening, preserves opaque
account/Device headers, rejects foreign targets and cookie-setting responses,
and never follows redirects or retries an operation. `ApplicationChannelError`
records whether dispatch may have occurred; disconnection is not proof that a
mutation did not execute. Account-session signing and authorization remain with
the SDK/provider and protected Station application. The opt-in
[virtual application ingress](../design/connection-broker.md#protected-application-dispatch)
is the server integration seam. The full-runtime diagnostic below composes
these owners; product onboarding, approved endpoint trust and broker lifecycle
remain necessary before enabling managed application access.

### Full runtime account relay diagnostic

```sh
npm run lab:browser-transport -- --peer=node --browser-turn=udp --application-accounts --keep
```

This diagnostic composes the actual source `StationRuntime` in a separate owned
process with the encrypted Node/Chromium channel. Its private process IPC carries
application frames directly into the protected Hono app; it does not re-dial
HTTP and invent a loopback caller. The signing-key trust, environment identity
and account Station identity must match. A fresh schema marker is installed
before security state is created in the disposable home.

Setup uses real local account registration, Project invitations and explicit
operator-approved read-only Device pairing. The browser receives its Device
grant and synthetic account credentials, never the operator credential or an
account cookie. Its SDK account calls use the configured transport resolver;
direct browser HTTP requests to the Station are blocked and counted. The
continuation key is non-extractable. The scenario checks account identity,
proof replay, invitation acceptance, renewal, continuation/provider-session/
Device revocation, and an unshared Project refusal. It retains
`account-boundary.json` and `account-scenario.json` separately from transport
receipts so positive account checks cannot hide a failed privacy boundary.

The scoped [#2030](https://github.com/kontourai/station/issues/2030) acceptance
now uses an explicit operator-approved account-bound replacement Device. A
matching current account reads its shared Project and receives a causeless 404
for the unshared Project. The same Device without account proof is refused with
401 over direct and virtual application paths; a different account is also
refused. Continuation, provider-session, membership and Device revocation each
independently stop a later permitted-Project read. Earlier retained runs that
returned the private marker remain failure evidence rather than being rewritten.

This remains a free synthetic source-runtime diagnostic. The full account path
has run through the Node UDP peer and the Pion adapter with browser TURN over
UDP and TCP. It does not prove the rendered guest UI, native or remote delivery,
legacy unbound personal-Device collaboration, Tailscale-bound account identity,
offered compute/plugins, public broker deployment, or hostile-process isolation.
The production connector remains disabled until those separately owned
boundaries qualify.

### Full collaboration

Future integration uses actual membership, account, compute and plugin owners;
missing behavior must not become a successful skipped test. Station-local
accounts under [#1981](https://github.com/kontourai/station/issues/1981)
provide the real account adapter without requiring hosted identity.

This fixture does not verify live Tailscale identity, production key admission,
browser/native trust distribution, internet/NAT reachability, invitation email
delivery or the [real two-human journey](https://github.com/kontourai/station/issues/497).
Two security homes in one process and relays running as the same OS user do not
prove tenant or hostile-code isolation. Those remain separate acceptance under
[#487](https://github.com/kontourai/station/issues/487).

### Separate self-hosted broker and production browser consumer

Run the integrated signaling path with the full account diagnostic:

```sh
npm run lab:browser-transport -- --peer=pion --browser-turn=tcp --application-accounts --self-hosted-broker --keep
npm run lab:browser-transport -- --peer=pion --browser-turn=udp --application-accounts --self-hosted-broker --keep
```

The additional `--station-ui` mode drives the actual Station SPA through
operator key-report approval, invitation acceptance, TURN setup, Connect,
fresh account login, operator Device approval, invitation redemption, and
in-app Project navigation. It serves the UI on the lab-owned HTTPS client
Origin and blocks/counts direct Station `/api` requests after route acceptance.
It reuses the free local broker, Pion, and TURN fixtures above; no hosted
identity or paid TURN service is needed. Run one transport at a time:

This is a separate UI-only acceptance mode. It stops after the visible Project
and shared-work checks; it does not run the account continuation, cookie
adoption, or revocation matrix from the commands above. Use those commands
without `--station-ui` for the full account/protocol receipt.

```sh
npm run lab:browser-transport -- --peer=pion --browser-turn=tcp --application-accounts --self-hosted-broker --station-ui --keep
```

The UI-mode receipt requires the selected browser ICE pair and Station answer
to contain TURN relay candidates, and the protected Project to open through
the live UI. This is a browser acceptance check only; it does not establish a
second physical machine, two-person access, internet reachability, or native
client behavior. Until the command completes successfully against the current
source, retain the not-verified status in [Connections](connections.md).

Build the pinned Pion executable as described above first. This mode starts the
actual broker CLI in a separate owned process with private SQLite state and
separate routing/connector credentials. Its controller issues two one-use
invitations, each with a distinct broker routing grant; the operator routing
credential never enters either browser profile. The browser profiles run on
two different test-owned HTTPS Origins, both explicitly listed in the Station
authentication-Origin allowlist. The Station-side factory uses the real Pion
adapter; the browser uses the production self-hosted transport entry point.
The full protected Station remains behind private process IPC, with direct browser
HTTP application requests blocked and counted. No account or Device authority is
injected into production authentication.

The checks cover account login and continuation, explicit account-bound Device
approval, permitted/private Project reads, independent Device and broker-grant
revocations, lease renewal, fresh-peer reconnect, wrong routing credentials,
actual browser CORS, proof tamper refusal before remote-description acceptance,
and trust retirement. A separate
HTTP preflight control checks the broker's exact response. Withdrawal can hide its
401 behind browser CORS; an independent HTTP control must still observe that exact
refusal, so an unrelated network failure cannot pass the test.

The source operator command in `scripts/self-hosted-broker.ts` also accepts
`invite`, `grants` and `revoke`. `invite` takes its existing private broker
configuration (with one exact Station scope), a private JSON request, and a new
private output path. The request is:

```json
{
  "version": "station-broker-invitation-request/v1",
  "brokerOrigin": "https://broker.example",
  "clientOrigin": "https://client.example",
  "stationSigningKeyId": "43-character approved Station key thumbprint",
  "stationSigningGeneration": 1
}
```

The CLI writes a mode-0600 typed invitation file under a private directory;
the one-use secret never enters a query string or CLI output. The browser
contract can encode it into a `/connections/computers#relay-invite=...`
fragment. The browser's Broker routes form accepts that link or the CLI's
private JSON invitation after that browser already has independently approved
Station-key trust; it does not
auto-consume an incoming fragment or establish that trust. Keep the CLI's JSON
file private and deliver it through an operator-approved channel. Invitations
expire within five minutes. A redeemed grant lasts at most 30 days and permits
broker signaling only; expiry, a lost successful redemption response, or lost
local custody requires a newly issued invitation. `grants` lists secret-free
grant IDs and state; `revoke` retires one grant and its pending signaling while
leaving the Station connector and other grants live. Existing encrypted peers
are not forcibly closed by broker revocation.

The Station operator must separately list each recipient Origin in
`ALLOWED_ORIGINS` and `STATION_AUTHENTICATION_BROWSER_ORIGINS` (the latter has a
bounded maximum of 16). Broker issuance cannot expand Station application
authority. The current desktop saved-route UI remains a metadata/trust readout;
native grant custody does not by itself make a route selectable or prove a real
Tauri connection. The browser route picker currently uses local ICE host
candidates and has no remote TURN setup. Its source-level fresh-account Device
ceremony requires provider support and explicit operator approval, but the
positive joined ordinary-UI browser journey has not yet passed this lab.
Browser and native onboarding UI/runtime evidence are tracked
separately under [#2388](https://github.com/kontourai/station/issues/2388).

The broker receives signaling only. The separate TURN recording relay observes
nonempty encrypted traffic, checked alongside actual DTLS and application delivery;
absence of a plaintext marker alone is not encryption evidence. Cleanup joins the
broker process, Pion peers, full Station, browser, recording relay and owned Coturn
container, and reports failures instead of claiming unconfirmed cleanup.

`selfHostedBroker.status: "passed"` means this local composition passed. It is not
fresh guest onboarding: the account fixture begins with an approved test Device,
then exercises the account-bound grant. It does not prove installed native clients,
real humans, remote-host deployment, compute/plugin isolation, or a production
rollout. Those remain separate acceptance requirements. The original direct
transport profiles retain their certificate-substitution controls; this broker
mode reports only the controls it actually executes.

### Cross-machine encrypted relay qualification

`npm run lab:remote-relay -- --ssh-host <known-host> --remote-checkout
/absolute/isolated-checkout --remote-node /absolute/node --pion-executable
/absolute/local/linux-pion-peer --keep` uses a local Chromium controller and a
separate POSIX Station/Pion process on the selected SSH host. Prepare the remote
checkout with the same committed source and managed dependencies first; supply a
Pion executable built for that host. Existing SSH host trust is required.

The controller owns loopback broker and TURN fixtures. Explicit SSH reverse TCP
forwarding makes those fixtures reachable from the remote Station without a
firewall or service change. Browser application requests still use the verified
encrypted DataChannel. A separate SSH forward is restricted to fixture operator
setup; the browser is blocked from using it. This qualifies cross-machine
TCP-over-SSH transport, not native remote UDP, a production deployment or a
managed service.

The account scenario also creates inert Tasks through the real API, publishes
selected messages and a document, and proves that unpublished work in the same
Project stays hidden. Unsharing, republication and membership/Device revocation
are checked independently. No Task is dispatched to an agent or billable model.

The run creates a private home beneath the isolated remote checkout and leaves
that named fixture root and local evidence available for inspection. It does not
restart an existing Station. Successful completion requires clean remote
supervisor exit, broker withdrawal, owned-process cleanup, the real account and
Project authorization journey, reconnect and renewal, zero direct browser
application requests, and a nonempty relay capture without application secret
markers. Source revisions, dirty state, fixture and binary hashes are recorded;
an uncommitted-source diagnostic is not an exact-release receipt. A synthetic
pre-approved Device remains a fixture prerequisite and does not qualify fresh
collaborator enrollment, native clients or real humans.
