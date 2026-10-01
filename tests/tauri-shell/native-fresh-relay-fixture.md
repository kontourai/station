# Fresh native relay fixture

This opt-in fixture prepares a genuine isolated Station, a supported local
account provider, an unconsumed Project invitation, and registry-backed native
Pion enrollment. The receiver uses the public broker and broker-issued TURN.
The Station listener remains on `127.0.0.1`; its logical HTTPS application
audience does not expose an HTTP service. No viewer or Device is created by
fixture preparation.

Source and keeper tests do not establish an actual main-WebView journey,
physical iOS acceptance, or Nightly delivery. The WebView harness calls the
production default host, with no injected principal, signer, or Device bearer.
Normal Connections UI and Zach's physical iOS Nightly still require separate
interaction evidence.

## Private operator preparation

Run from a clean committed checkout on the isolated runtime host:

```sh
node --import tsx scripts/native-fresh-relay-fixture.ts prepare /absolute/new-owned-run
```

`plan.json` names the fresh Station, exact public broker scope, logical audience,
non-default listener block, source revision, and public signing descriptor.
The actual operator credential stays in private `operator.json`. Do not copy
that file or broker connector/routing credentials into a WebView or invitation.

Stage the artifacts and launch prerequisites below **before** the broker owner
provisions this exact scope. The initial lease is only 60 seconds; do not start
that clock before a Go build, certificate preparation, or dependency install.
The existing running broker checkout and its issuer secret remain untouched.

Build Pion from this exact source with pinned Go and cached modules into the
owned run directory. Retain its command receipt; write private
`pion-artifact.json` containing `{version:"station-native-pion-artifact/v1",
sourceRevision,sha256}`. A matching digest validates the staged artifact; it
does not by itself prove how it was compiled. The executable must be private
and executable. Stage its certificate and private key in that same directory.

Create private `connector.json` using the existing
`station-self-hosted-connector/v1` shape. It must match the plan's exact broker
and application origins, use `nativeClient:{kind:"station-native-registry"}`,
`turn:{source:"broker"}`, at most four peers, `maxPeerLifetimeMs:120000`, and
private owned paths for the credentials, Pion executable, certificate and key.
No static TURN password or Cloudflare issuer credential belongs here. The private
config can name the future credential path during artifact staging. Once the
build, certificate/config checks and launch command are ready, the broker owner
runs the existing private `init` for the exact new scope and supplies only the
Station-owned connector/routing bundle in `broker-credentials.json`. Complete
the final credential/scope preflight and start `serve` immediately. Confirm
actual broker `online` registration and at least one subsequent lease renewal;
loopback Station HTTP 200 and successful operator Project creation prove only
those local paths.

Start the owned runtime in a foreground or operator-owned service invocation:

```sh
node --import tsx scripts/native-fresh-relay-fixture.ts serve /absolute/new-owned-run/plan.json
```

The normal server entry point receives an isolated OS home, Station home/root,
instance, complete build identity and genuine local-account/sharing/native
enrollment opt-ins. A disposable Node socket guard permits only its listener
block and `relay-test.kontourai.com:443`; it is a diagnostic guard, not an OS
sandbox for Pion. The wrapper begins cleanup before its thirty-minute hard
lifetime. Neither user port 3141 nor 3000 is allowed.

## Executed startup failure: provisioned too early

The preserved Linux `fresh-d8dd-20261001` run demonstrates the ordering risk:

| Observation (UTC, 2026-10-01) | Result |
| --- | --- |
| Initial private broker provisioning, 11:28:15 | Exact scope and credential hashes committed |
| Broker lease expiry, 11:29:15.273 | Initial 60-second window ended |
| Pion artifact/config staging, 11:29:40.554 | Already after the lease expiry |
| Owned runtime spawn, 11:30:39.248 | About 84 seconds after expiry |
| Local Station/Project publisher | Well-known 200 and actual publisher success |
| Public connector registration/withdrawal | Actual HTTP 401; lease revision 0 and no last-seen registration |
| Explicit stop | Process group settled; broker cleanup unconfirmed (401) |

Read-only comparison established that both connector/routing IDs and credential
hashes, Station/enrollment/generation/Origin scope, and private config matched.
The lease was not withdrawn; it had simply expired before first registration.
An isolated diagnostic using the exact Node socket guard and a credential-free
GET of the public broker returned 404, so the separate startup socket refusal
was not evidence that the guard blocked the broker. No native client, application
Pion, or public Project transfer was established by this failed run.

The existing `provision` transaction returns an exact same-generation bundle
idempotently without changing expiry. `register` and `renew` require a live lease.
Therefore repeating private `init` cannot revive this expired generation. Keep
its run directory and scope unchanged. The justified next attempt uses a new
owned scope, completes artifact staging first, provisions last, and observes
real online registration plus renewal. No lease TTL or authority rule is changed.
The [operator guide](../../docs/guides/self-hosted-broker.md) records the explicit
recovery proposal separately; it is not an implemented bypass.

## Fresh person and Device journey

1. `project plan.json /absolute/new-owned-run/person-invitation.json` creates an
   owned Project, one published Task with fixed human message/document text, an
   unshared private Project control, and a pending viewer invitation through
   actual operator APIs. Publication is checked by a real shared-document
   snapshot read before the person invitation is written.
   The person remains unregistered and has no membership or Device grant.
2. The receiver creates a relay profile and copies its real public install
   proof from native key approval. Place it in a private operator input file.
   `invite-native plan.json install-proof.json native-invitation.json` verifies
   it through the normal connector invitation owner, explicitly approves the
   exact surface via the operator registry API, and writes a targeted routing
   invitation privately. Routing authority is independent of person/Device
   authority. Compare the actual Station signing-key code independently.
3. Through the ordinary native enrollment client or UI, begin and register
   with the unconsumed person invitation and new username/password. The
   maintained provider creates the real issuer-qualified person. `pending
   plan.json` displays actual pending enrollment candidates.
4. Brian verifies Zach's exact candidate and actual account identity.
   `approve plan.json approval.json` sends the exact `{enrollmentId,candidate}`
   through the operator endpoint. Synthetic automation may perform this same
   genuine operator action only for its explicitly owned synthetic person.
5. Finalize sealed delivery, activate with the host ACK, and verify the owned
   transition before publishing the configured profile. The native host keeps
   recipient/Device keys and the decrypted Device credential in OS custody.
6. Establish the separate native account session, accept the Project invitation
   through the fixed native HTTP operation, and read the actual member Project.
   Invitation acceptance is not inferred from an arbitrary HTTP 200.

The full user-action driver and physical receiver remain follow-up evidence.
An empty shared-work response is not evidence of reading the published artifact.
The operator publisher uses actual human TaskRoom message/edit-plan/batch
operations; it dispatches no Agent or model. Only fixed small text
traffic is authorized: no Agents, billable models, audio, or file traffic.

Keep negative controls for unapproved/foreign surfaces, wrong Station key code,
direct HTTP proof-header fabrication, Project access before account/membership,
foreign private Projects, account revocation/reauthentication, and Device-binding
revocation. Keep caller cancellation and lost activation outcomes observable.
Do not extend protocol, invitation, enrollment, or peer TTLs for fixture ease.

## Cleanup and evidence limits

SIGINT/SIGTERM or the owned deadline revokes current native routing grants in
this exact broker scope, then settles the owned Station/Pion process group.
Cleanup failures are errors, not success receipts. `cleanup.json` records both
broker and process settlement. After owned termination/EOF drain,
`runtime-output.json` privately retains the bounded stdout/stderr capture, exit
outcome, primary failure and truncation/invalid-UTF8 classifications. It is never
printed. Capture or cleanup failures remain errors and preserve the primary
runtime failure rather than replacing it with a success receipt. Already-issued end-user TURN credentials are
bounded to at most 600 seconds after the last possible issuance; this service
does not expose their instantaneous revocation. The broker owner may separately
revoke known test usernames through an approved provider operation. Never delete
the shared issuer key. An issuance budget is not a financial spend cap; retain
actual before/after usage observations.

Preserve the private owned run directory for receipts until its owner removes
it. Never clean another Station home, an installed user's Keychain, a default
service, or the running broker worktree.
