# Free local collaboration lab

> Status: transport/enrollment and real local-account/member scenarios are
> implemented. Shared content, approved Device access, UI, compute and plugin
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
uses direct loopback HTTP; it does not claim to carry account sessions through
the encrypted broker before the owning continuation contract lands.

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

The controller also supplies a separate approved Station signing key. Before
accepting SDP, the browser verifies a 30-second ES256 connection proof against
its own nonce/connection ID, the admitted Station generation, both fingerprints
and the exact offer/answer bytes. Altered proofs and successful-proof replay
are refused. This uses maintained JOSE and browser WebCrypto. It models the
[connection-proof contract](../design/connection-broker.md#connection-proof-contract);
the private fixture callback is not a production account or key-enrollment API.
The full gathered SDP is signed; extra unsigned candidate callbacks are not
forwarded as an implicit trust extension.

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
signaling authentication, renewal/recovery, native app delivery and Station
request/stream integration remain unimplemented. The fixture's out-of-band
trust setup does not implement those contracts.

### Full collaboration

Future integration uses actual membership, account, compute and plugin owners;
missing behavior must not become a successful skipped test. Station-local
accounts under [#1981](https://github.com/kontourai/station/issues/1981) will
provide a real account adapter without requiring hosted identity.

This fixture does not verify live Tailscale identity, production key admission,
browser/native trust distribution, internet/NAT reachability, invitation email
delivery or the [real two-human journey](https://github.com/kontourai/station/issues/497).
Two security homes in one process and relays running as the same OS user do not
prove tenant or hostile-code isolation. Those remain separate acceptance under
[#487](https://github.com/kontourai/station/issues/487).
