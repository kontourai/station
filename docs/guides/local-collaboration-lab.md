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
