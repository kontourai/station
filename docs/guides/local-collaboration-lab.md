# Free local collaboration lab

> Status: the transport and enrollment fixture is implemented. Full Station
> UI, shared-Project, compute and plugin integration remains under
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

## Output and retained evidence

Success prints a `STATION_LOCAL_LAB_REPORT` JSON line with
`scope: "transport-and-enrollment-fixture"` and `status: "passed"`.
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
trust is supplied independently by the fixture controller. The checks require:

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
