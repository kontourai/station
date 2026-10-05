# Operator device access from a paired browser (#2894)

> **Status: proposal, under design and security review (2026-10-03).** The
> owner set the direction in the #2894 issue comment of 2026-09-28 and
> decided D1, D2 and D6 on 2026-10-03 (section 9). D3–D5 and D7–D11 are open.
> S1 observes raw operator-credential use from off the host without refusing it.
> The merged runtime also implements #3257 S2b consent-origin passkey enrollment
> and host administration; see [Operator passkeys](../guides/operator-passkeys.md).
> Enrollment does not implement operator sign-in, operator sessions, or per-action
> step-up. Those remain design work. The dated body below retains the original
> design assumptions and line citations; it is not a complete current-state inventory.

The body was read at `origin/main` 1aecbf3555 (2026-10-03). The S1 sections
and every `runtime-routes.ts` line citation were re-read after merging
`origin/main` 91ec8af5d4; citations into other files are as first read. Line
numbers drift with later edits.

Citation rule: `path:line` means I read it. **REASONED** marks an inference
that I did not read in code or did not execute. **NOT VERIFIED** marks a
claim I tried to confirm from code and could not.

---

## 0. Summary

The owner already chose the direction (issue comment, 2026-09-28): the
operator is its own identity, separate from any device. The operator signs in
with a passkey, and each privileged action needs a fresh passkey assertion.
The code supports that direction. It adds three constraints that the
direction did not state, and they change the shape of the design:

1. **The passkey ceremony has to run on a different origin from the app.**
   Station already decided that same-origin plugin code can drive any page on
   the app origin. For that reason, authority-bearing approvals moved to a
   separate-origin consent listener, and the same-origin approval path was
   removed (`src-server/runtime/consent/consent-listener.ts:16-22`,
   `src-server/routes/plugins/plugin-host-approval-routes.ts:1-20`). A WebAuthn
   prompt shows only the site and the account. It does not show the action
   being approved. On the app origin, plugin code could therefore create a
   "grant full access to device X" step-up and trigger the operator's
   passkey prompt during an unrelated click. The step-up has to reuse the
   existing **ConsentTransaction + consent listener** design
   (`src-server/services/consent/consent-transactions.ts:1-35`). Its new
   decision authority is "operator passkey".
2. **"Enrolled from the Station's own host" cannot mean "the WebAuthn create
   ceremony runs on the host".** A passkey is bound to an RP ID, which is a
   DNS name. The host's own UI runs at loopback or `tauri.localhost`
   (`docs/design/identity.md`, "Where passkeys fit"). A passkey created there cannot be used
   at the tailnet HTTPS name a remote browser uses. **REASONED** from the
   WebAuthn spec: an IP literal is not a valid RP ID either. So the operator
   creates the passkey in a browser at the origin where it will be used, and
   **the host confirms it**, the same way a named pairing request is
   confirmed on the host (`docs/security/remote-access-threat-model.md:1164-1170`).
3. **"Nothing weaker" reaches the raw operator credential.** Today the scope
   and revoke routes accept the operator bootstrap credential as a bearer from
   any peer. The check is only `authority === 'operator-credential'`
   (`src-server/runtime/routes/runtime-routes.ts:8301-8326`), and that
   authority comes from the credential value alone
   (`runtime-routes.ts:1345-1352`). A remote browser that has that bearer is
   strictly weaker than passkey plus step-up. The design limits the
   raw-credential path to the host. That is owner decision D2, which S1
   starts by observing off-host uses before anything is refused.

Why the issue's symptom happens: the Paired devices panel reads the inventory
with the device's own credential (`authenticatedFetch`,
`packages/connect/src/react/connection-manager-modal/PairedDevicesPanel.tsx:60-72`
and `PairedDevicesPanel.tsx:99-110`).
It uses a pasted operator credential only for writes (`deviceAdminFetch`,
`PairedDevicesPanel.tsx:77-97`). An ordinary device credential is refused for
the whole `/api/pairing` family
(`src-server/services/ssh/environment-security-service.ts:498-532`), so the
list never loads, whatever is pasted.

---

## 1. Current state (read)

### Routes and gates

| Route | Gate today | Evidence |
|---|---|---|
| `GET /api/pairing/devices` | Middleware only: `access:manage` family scope (`src-server/security/pairing-route-scopes.ts:879-884`), plus `authorizeCredential`, which admits the operator credential and local-grant-minted credentials and refuses every other device | `runtime-routes.ts:8627-8641`; `environment-security-service.ts:488, 498-509` |
| `DELETE /api/pairing/devices/:id` | `currentOperator` (operator-credential authority + principal still current) | `runtime-routes.ts:8661-8682` |
| `POST /api/pairing/devices/:id/scope` | `currentOperator`, checked twice; `expectedScope` makes the write conditional; drops live leases; resets full access | `runtime-routes.ts:8693-8781` |
| `DELETE /api/pairing/devices/:id/record` | `currentOperator`; service also requires actor `operator-credential` | `runtime-routes.ts:8782-8804`; `src-server/services/ssh/device-pairing-service.ts:2316-2322` |

- The service-side approval vocabulary is
  `presented-credential | local-grant | ui-bootstrap | unauthenticated`
  (`device-pairing-service.ts:373-378`). The revocation actor is only
  `'operator-credential'` (`device-pairing-service.ts:380`).
- Credential selection: a strict bearer wins. Otherwise the device-session
  cookie is used (`src-server/runtime/bootstrap/runtime-http.ts:847-853`).
  Cookie names are `__Host-station-device` and `station-device`
  (`runtime-http.ts:92-93, 1298-1320`).
- A recognized credential that is refused admission gets 403, not 401
  (`runtime-http.ts:1047-1060`). The panel maps only 401 to its "needs
  review" text (`PairedDevicesPanel.tsx:104-108`). The issue reports a 401.
  S1 pins 403 for an ordinary device **bearer** on all four device-admin
  routes, through the real boundary
  (`src-server/runtime/__tests__/operator-credential-host-locality.test.ts`).
  **NOT VERIFIED:** the status a paired browser's device-session cookie
  receives.
- `RuntimeCredentialAuthority = 'operator-credential' | 'device-credential'`
  (`src-server/security/runtime-request-security.ts:21-25`).
- Host-possession predicates already exist: `localRuntimeCaller`
  (`runtime-request-security.ts:710-714`), `bindRuntimeLocalOperator` and the
  stricter local-grant-minted flag (`runtime-request-security.ts:722-741`),
  and `isBoundLocalGrantMintedOperator` (`runtime-request-security.ts:780-782`).
  Peer class comes from the attested-proxy verdict, falling back to the
  direct socket (`runtime-request-security.ts:788-798`). UI-proxied browser
  traffic is always `remote` (`docs/security/remote-access-threat-model.md:27-38`).
- Native device-proof admission is a separate middleware branch. It never
  falls through to bearer or cookie (`runtime-http.ts:766-780`). This is the
  pattern to copy for a new authority.

### CLI

- `DeviceAccessOperatorChannel` is `{ request(path, init): Promise<unknown>; target }`.
  The verbs never learn how the operator was authenticated
  (`packages/cli/src/commands/device-access.ts:10-37`).
- The only channel today is `openLocalOperatorChannel`. It refuses a
  non-loopback `--api-base`, proves the listener owns the home, and then sends
  the home's operator credential (`packages/cli/src/commands/environment.ts:1455-1490`
  and `packages/cli/src/commands/environment.ts:1640-1668`).
- `runDeviceScopeCommand` requires the POST answer to be the updated device
  (`id` and `scope` match) and reads `fullAccessRevocation` from the same body
  (`device-access.ts:297-331`).

### UI

- The panel keeps a pasted operator credential in component state for writes
  only (`PairedDevicesPanel.tsx:54, 74-97`). The field is rendered at
  `PairedDevicesPanel.tsx:271-291`.
- Mounted from `packages/connect/src/react/ConnectionManagerModalContent.tsx:1202-1217`.
  `allowManualCredentials` is false on desktop
  (`src-ui/src/components/OnboardingGate.tsx:879`, `GuidedConnect.tsx:214`).

### Existing building blocks

- **WebAuthn and passkeys: none in code.** The only hits are design prose.
  `docs/design/identity.md:67-101` rejects passkeys *for device pairing*
  because of the RP ID and origin, and recommends a device keypair for
  `provider: 'device'`. `docs/design/principals.md:256-257` lists "Passkeys
  for pairing" as a restriction. Neither rejects an operator passkey, but both
  must be amended so a reader does not take them as a veto.
- No WebAuthn library is installed. `better-auth` 1.7.5 is present
  (`package.json:370`) and uses only the `genericOAuth` and `username` plugins
  (`src-server/services/identity/local-account-provider.ts:11-19`). Its passkey
  plugin is a separate, uninstalled package (I checked `node_modules`).
- **ConsentTransaction** (`consent-transactions.ts:1-35`) provides:
  - a target snapshot with a fingerprint that is re-derived before commit;
  - canonical description text;
  - an atomic pending-to-decided transition;
  - a one-use render nonce;
  - a bounded audit trail;
  - per-tenant partitioning, with rate and capacity limits.

  Its decision authorities are `operator-credential | device-consent-scope |
  consent-session | native-host` (`consent-transactions.ts:207-222`).
- **Consent listener** (`consent-listener.ts:1-45`):
  - a separate port and origin;
  - a script-free page (CSP `default-src 'none'`, `consent-listener.ts:63-81`);
  - a decide POST that requires an exact Origin, Fetch Metadata, a session,
    and the nonce.

  Review URLs are **plain `http://<host>:<consent port>`**
  (`src-server/services/consent/consent-channel.ts:72-89`).
- **Native device-proof bindings** (#2893) give a precedent for an
  operator-approved key binding. They also include a private SQLite replay
  store (`src-server/services/identity/native-device-replay-store.ts:1-50`) and
  operator-only approval (`src-server/routes/system/native-device-proof-binding-routes.ts:140-151`).
- **Deployment accounts** (username/password, OIDC) exist. They are
  deliberately not operator authority: "A Project administrator does not
  inherit Station operator authority" (`docs/guides/deployment-authentication.md:53`).
  They are optional, so the operator path must not depend on them
  (`docs/design/identity.md:114-153`, local-first invariant).

### The host desktop app does not hold the operator credential (resolved in S1)

The issue says the UI path works in the desktop app on the host. The code
says otherwise for writes:

- The desktop app self-provisions a **local-grant-minted device credential**
  (`station_local_self_provision`, `src-desktop/src/lib.rs`, reading the
  per-boot secret at `:1821-1836` and exchanging it at
  `/.well-known/station/v1/pairing/local-grant`), and stores it in the
  keychain under a `local-grant:` reference.
- On desktop the panel adds no `Authorization` header
  (`allowManualCredentials={!profile.isDesktop}`), and the native HTTP broker
  attaches the active profile's keychain credential as the bearer
  (`station_native_http_request_to_sink_blocking`, `lib.rs`). Nothing in
  `src-desktop` reads the operator credential.
- That credential resolves to `device-credential` authority
  (`runtime-routes.ts:1345-1352`), and `currentOperator` requires
  `operator-credential`.

So the host desktop app can **list** devices (the local-grant read exception
in `authorizeCredential`) but gets `401 authentication_required` on scope
change, revoke and record removal. S1 pins this through the real boundary
with the exact local-grant exchange the desktop performs (EXECUTED, server
side). The Rust half, that the broker sends the self-provisioned credential,
is source inspection only (**REASONED**). The panel's native-host text said
the operator credential is "managed by" the host app, which describes a
credential the desktop does not hold. For a scope change it now names the
host CLI (`station environment access scope`, #3256). Revoke and record
removal still carry the old text, because the CLI has no command for them yet.

Consequence for the design: "host operator" via `isBoundLocalGrantMintedOperator`
(section 3.1, item 5) is a **new** acceptance on the write routes, not the
preservation of a working path. Whether the host desktop should be able to
administer devices directly is part of D2's follow-up, and the panel copy is a
separate fix.

---

## 2. Threat model

Assets:
- device grants (scope, including `approval:full-access`);
- the ability to revoke devices;
- operator passkeys;
- operator sessions;
- the audit trail.

Trust root: possession of the Station host (the home directory, the loopback
operator channel, the local-grant secret). It remains the root, and every
operator passkey is rooted in a host confirmation.

| # | Adversary or event | Goal | Mitigation in this design |
|---|---|---|---|
| T1 | Phishing site or look-alike origin | Get an operator assertion or code | WebAuthn binds the assertion to the RP ID, and the server checks `clientDataJSON.origin` exactly against the configured operator origin. There is no bearer secret to type. Enrollment has no typed secret either: the host confirms a request whose code it displays. |
| T2 | Replay of a captured assertion or step-up | Repeat a scope change | The challenge is single-use and server-held, bound to (transaction id, render nonce, target fingerprint). The transaction transition is atomic (`consent-transactions.ts:16-21`). The sign counter is checked when the authenticator reports one. |
| T3 | Same-origin plugin or XSS on the app origin | Induce an approval, or read admin data | Step-up and every ceremony run only on the operator (consent) origin. The server rejects assertions whose origin is the app origin. Residual: with a live operator session, app-origin script can **read** the device inventory. That is a read only, and it is disclosed. |
| T4 | Stolen, unlocked paired browser | Change scopes or revoke devices | Every privileged action needs user verification (UV) on the authenticator (biometric or PIN). The session alone authorizes only reads. Sessions are short and bound to the device, so revoking the device from the host ends them. |
| T5 | Stolen paired device with no operator session | Become an operator | A device credential never becomes an operator session. Sign-in needs a passkey assertion with UV. `access:manage` or `access:approve` on the device grants nothing new (the owner's rejected alternative). |
| T6 | Attacker on the tailnet who has a paired device | Enroll their own passkey | Enrollment requires host confirmation of a pending request. The host shows the requesting device's server-verified name, the RP ID, and a 6-digit code that the operator must match against their own browser. Residual: the operator approving the wrong request. This is the same residual pairing accepts. |
| T7 | Lost or destroyed passkey | Lockout | The host channel always works (CLI, host desktop app). The operator enrolls a replacement from the host and revokes the lost one from the host. Two passkeys are recommended at enrollment. |
| T8 | Leaked raw operator credential, used remotely | Administer devices | After D2 (S1b), the device-admin routes accept the raw credential only with proof of a host-only secret, not on network position, which a same-host proxy or tunnel can fake. Other uses of the credential are unchanged (out of scope). |
| T9 | Racing operators or stale review | Re-grant what another operator removed | Keep `expectedScope` (`runtime-routes.ts:8712-8718`). The transaction fingerprint includes `expectedScope`, and the target is revalidated immediately before commit. |
| T10 | Downgrade: no HTTPS operator origin | Fall back to something weaker | Fail closed. Without an HTTPS operator origin, remote operator sign-in is unavailable and the panel says to use the host. No password, code, or bearer fallback. |

Out of scope: a compromised host OS (it is the root), hosted multi-tenant
Stations (refused in v1, D11), and confirming pairing requests remotely (D9).

---

## 3. Chosen mechanism

### 3.1 Components

1. **Operator passkey registry.** A new operator-passkey service,
   backed by a private SQLite store under the Station home's security
   directory, opened with `openPrivateSqlite` (`src-server/utils/private-sqlite.ts`;
   the same posture as `native-device-replay-store.ts:15-50`).

   Each row holds:
   - `id`, `credentialId`, the COSE public key, `signCount`, `rpId`, `origin`;
   - `label`, `aaguid`, `createdAt`;
   - `confirmedVia` (the host channel that confirmed it), `lastUsedAt`, `revokedAt`.
2. **Operator origin.** The consent listener's origin is reused as the single
   operator ceremony origin. Remote use requires it to be HTTPS on the same
   DNS name as the app origin. Ports do not affect RP ID, so a passkey works
   at both `https://station.example.ts.net` and `https://station.example.ts.net:8443`
   (**REASONED**, from the spec). The server derives the RP ID and expected
   origin from configuration, never from the request `Host`. A new optional
   `STATION_TRUSTED_CONSENT_ORIGIN` (exact HTTPS origin) changes
   `ConsentChannelService.reviewUrlFor` (`consent-channel.ts:72-89`) to issue
   that origin instead of `http://<host>:<port>`. Loopback
   `http://localhost:<consent port>` is a secure context and stays valid for
   host and test use.
3. **Operator session.**
   - Created only by a passkey assertion with UV on the operator origin.
   - Stored server-side; the cookie holds a 256-bit random id. The cookie is
     `__Host-station-operator`: HttpOnly, Secure, SameSite=Strict, Path=/.
     It is host-scoped, so it also reaches the app origin on the same host.
   - **Bound to the paired device** whose live device cookie was presented
     during sign-in (D3).
   - Lifetime: 15 minutes idle and 60 minutes absolute (D4). No silent
     renewal past the absolute limit.
   - Grants **reads only**: the device inventory and the operator's own
     passkey and session list.
4. **Step-up = a ConsentTransaction decided by an operator passkey.**
   - New target kind: `device-access-change`.
   - Fingerprint: canonical JSON of `{op: 'scope'|'revoke'|'remove-record',
     deviceId, expectedScope, nextScope?, resetFullAccess?}`.
   - New `ConsentDecisionAuthority` value: `'operator-passkey'`.
   - `commitApproval` calls the same service methods the direct route calls.
     Its effect projection is **byte-for-byte the direct route's response
     body** (the device record plus `fullAccessRevocation` or
     `fullAccessRevocationError`), so callers cannot tell the paths apart.
   - Per-action only, with no step-up window. That is the owner's decision,
     and per-action binding is the only form that defeats T3.
5. **Host operator authority (narrower acceptance, proved by a secret).**
   - `hostOperator(request)` must rest on **proof of a host-only secret**,
     never on network position. Two forms qualify:
     - `isBoundLocalGrantMintedOperator(request)`: the credential was minted
       by presenting the per-boot local-grant secret file (new on the write
       routes; see section 1);
     - the raw operator credential **together with** a proof that only a
       process able to read this host's per-boot secret can produce (S1b
       designs the exact proof; the host CLI already reads the home it
       operates on). A remote holder of the operator credential alone fails
       it.
   - S1's position (`classifyOperatorCredentialPosition`,
     `src-server/security/host-operator-credential.ts`) is **telemetry
     only**. It is not the effective peer class, which is `remote` for every
     UI-proxied browser, including one on the host:
     - `host-direct`: a direct loopback socket, no forwarding evidence, no
       proxy attestation headers, no verified ingress identity, and a
       loopback `Host`;
     - `host-ui-proxy`: Station's attested UI proxy, whose attested client
       address and attested browser `Host` are both loopback and whose client
       sent no forwarding evidence (the same facts as
       `isSameMachineBrowserCaller` in `runtime-routes.ts`, plus that one);
     - `off-host`: everything else. Forwarding evidence is `forwarded`,
       `x-forwarded-for`, `x-forwarded-host`, `x-real-ip` or any
       `tailscale-*` header, or the UI proxy's `x-station-proxy-client-forwarded`
       marker that its own client sent one. Presence alone decides, so adding
       them cannot help a forger.
   - **Why position cannot be authority.** `Host`, and the forwarded host the
     UI proxy copies from its client, are client-controlled. Any same-host
     proxy or tunnel that re-dials loopback and strips forwarding headers (an
     SSH local forward, a reverse proxy, a tunnel client) makes a remote
     caller byte-identical to the host CLI. S1 pins that residual in a test.
     The counts S1 collects tell the owner how often off-host use is
     *visible*; they cannot prove that a `host-*` use was local.
   - Whether a host browser holding a pasted operator credential
     (`host-ui-proxy` today) can produce the S1b proof is for the owner. S1
     records the two host positions separately so the counts can inform it.

### 3.2 What each route accepts afterward ("exactly, and nothing weaker")

| Route | Host operator | Operator session (device-bound, fresh) | Operator session + passkey step-up | Anything else |
|---|---|---|---|---|
| `GET /api/pairing/devices` | allow | allow | n/a | refuse (as today for ordinary devices) |
| `POST /api/pairing/devices/:id/scope` | apply directly (as today) | **202 `step_up_required`** + transaction; no mutation | the transaction commit applies it | refuse |
| `DELETE /api/pairing/devices/:id` | apply directly | 202 + transaction | commit applies | refuse |
| `DELETE /api/pairing/devices/:id/record` | apply directly | 202 + transaction | commit applies | refuse |
| `GET /api/pairing/device-access-transactions/:id` (new) | allow | allow, own transactions only | — | refuse |

Refused in every row:
- a raw operator credential from a remote peer (after D2);
- a device with `access:manage`, `access:approve`, or `consent:decide`;
- a delegation device;
- the internal token.

The local-grant-minted read exception in `authorizeCredential` stays as it is
(`environment-security-service.ts:498-509`).

### 3.3 Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **A. Operator-credential browser session** (the issue's second candidate: paste the bootstrap credential, and the server issues an operator cookie) | The credential is a long-lived bearer, so it can be phished (pasted into a look-alike page) and replayed until rotated. Rotating it disrupts every host tool. The paste step puts it in page JS, and the threat model already calls that path a recovery fallback (`remote-access-threat-model.md:1144-1146, 1182-1184`). A stolen browser holding the session can act with no user verification. It fails "phishing-resistant" in the owner's decision. |
| **B. Paired device holding `access:manage` administers** | Rejected by the owner: a stolen device would be an administrator. The code already refuses to honour inherited `access:manage` (`environment-security-service.ts:511-518`). |
| **C. Passkey ceremony on the app origin** | Same-origin plugin code can trigger the ceremony for an action it chose (T3). archive#3677 removed the equivalent same-origin approval for exactly this reason (`plugin-host-approval-routes.ts:8-20`). |
| **D. Step-up window (for example, 5 minutes after one assertion)** | During the window, any app-origin script can mutate. A per-action binding to a fingerprint costs one extra touch and closes that gap. |
| **E. Operator as a deployment account (better-auth passkey plugin)** | Accounts are optional and are explicitly not operator authority (`deployment-authentication.md:53`). Depending on them would break the local-first invariant (`identity.md:126-153`). It would also need a second, uninstalled plugin package. |
| **F. Device keypair (native device proof, #2893) as operator** | That proves a *device*, not the person, and has no user-verification step. Making it operator authority repeats alternative B. It remains the right primitive for native device auth (`identity.md:90-94`). |
| **G. Host-minted one-time enrollment code typed into the browser** | The code is a short-lived bearer that can be phished (T1). Host confirmation of a browser-originated request with a displayed code matches pairing and carries no secret (D5). |

### 3.4 Comparison on the requested points

| Point | Passkey + per-action step-up (chosen) | Operator-credential browser session |
|---|---|---|
| Phishing | Origin-bound. Nothing typed, nothing to relay. Enrollment carries no secret. | The credential is typed or pasted, so a look-alike page captures it. |
| Replay | Single-use challenge bound to the action fingerprint. Atomic consume. | The bearer is replayable until the operator rotates it. The cookie is replayable until it expires. |
| Stolen paired browser | Reads until the session expires. Every write needs biometric or PIN on the authenticator. Revoking the device from the host kills the bound sessions. | Full admin until the cookie expires. If the credential was kept in tab or session storage, the attacker has it permanently, and recovery means rotating the credential. |
| Lost passkey | The host channel is unaffected. Enroll a new passkey from the host and revoke the old one from the host. A second passkey covers remote use meanwhile. | Not applicable (the credential is on the host). That is also its weakness: one shared secret for everything. |
| Headless/CLI parity | The host CLI is unchanged. A remote CLI gets a channel that turns 202 into "open URL, wait" (slice 5). `device-access.ts` is unchanged. | Trivial (send the bearer), which is why it is weak. |
| Builds on existing code | ConsentTransaction, the consent listener, the private SQLite store pattern, host-operator predicates, `expectedScope`, and the full-access reset. Needs a new WebAuthn library. | The bearer and cookie plumbing exists, but it adds a new bearer-to-cookie exchange. |

---

## 4. Exact route and auth changes

All new paths are proposals. Existing paths are cited.

### 4.1 Server: auth boundary

1. `src-server/security/runtime-request-security.ts`
   - Extend `RuntimeCredentialAuthority` (`:21-23`) with `'operator-session'`.
     Before merging, audit every negative comparison: any
     `authority !== 'device-credential'` or `!== undefined` style check would
     *admit* the new value. Example to check:
     `src-server/services/identity/authority-observation.ts:172`.
     **REASONED** that positive `=== 'operator-credential'` checks fail closed
     for the new value.
   - Add `RuntimeAuthenticatedRequestPrincipal.operatorSession?: { sessionId; passkeyId; boundDeviceId }`.
     The server writes it; the request never supplies it.
   - Add `isHostOperator(request)`: true for
     `isBoundLocalGrantMintedOperator`, or for the operator credential plus
     S1b's host-secret proof (section 3.1, item 5). Never for S1's network
     position, which stays telemetry. Bind it once at the boundary like
     `bindRuntimeLocalOperator` (`:722-741`).
2. `src-server/runtime/bootstrap/runtime-http.ts`
   - Add an operator-session admission branch, placed like the native-proof
     branch (`:766-780`) and before credential selection (`:847-853`). It
     triggers when the `__Host-station-operator` cookie is present **and** the
     path is an operator-session leaf. The leaf list is exact, never a prefix,
     for the same reason as `isPairingApprovalLeaf`
     (`environment-security-service.ts:511-524`).
   - The branch requires all of:
     - a live device-session cookie (identity via `recognizeCredential`, `:1047`);
     - a session bound to that device id;
     - a session that is not revoked or expired;
     - a passkey that is not revoked;
     - the device is not revoked;
     - an exact `Origin` on unsafe methods (same rule as `:889-898`).
   - On failure, it never falls through to device admission. It answers
     `401 operator_session_required`.
   - On success, it stamps a principal with `authority: 'operator-session'`
     and does **not** set `RUNTIME_CREDENTIAL_AUTHORITY_VAR` to
     `operator-credential`.
3. `src-server/security/pairing-route-scopes.ts`
   - Add explicit table rows for `/api/operator/*` and
     `/api/pairing/device-access-transactions/:id`.
   - Mark the operator-session leaves:
     - `GET /api/pairing/devices`
     - `POST /api/pairing/devices/:id/scope`
     - `DELETE /api/pairing/devices/:id`
     - `DELETE /api/pairing/devices/:id/record`
     - `GET /api/pairing/device-access-transactions/:id`
     - `GET|DELETE /api/operator/session`
     - `GET /api/operator/passkeys`
   - Keep `/api/pairing:manage` (`:879-884`) for every other caller.

### 4.2 Server: routes

4. `src-server/runtime/routes/runtime-routes.ts`
   - Replace `currentOperator` (`:8301-8326`) with two predicates:
     `hostOperator(c, request)` (`isHostOperator` plus the existing
     `isRequestPrincipalCurrent` fail-closed check) and
     `operatorSessionReader(request)`.
   - `GET /api/pairing/devices` (`:8627`) allows either.
   - `POST .../scope` (`:8693`), `DELETE .../:id` (`:8661`), and
     `DELETE .../:id/record` (`:8782`):
     - `hostOperator`: unchanged path, with approval `presented-credential`
       or `local-grant`.
     - `operatorSessionReader`: validate the body exactly as today. Then
       create a `device-access-change` transaction and answer
       `202 { status: 'step_up_required', transaction: { id, reviewUrl, expiresAt } }`
       with no mutation. Grant-ability validation (`scope_not_grantable`)
       runs **before** the transaction is created, so a refused change never
       reaches review.
     - Otherwise: 401 or 403, as today.
   - New `GET /api/pairing/device-access-transactions/:id` returns
     `{ status, effect? }`. `effect` is the direct route's body.
   - Wiring at `:2426-2459`: pass `operatorPasskeys`, `operatorSessions`,
     and `consentChannel`.
5. `src-server/services/ssh/device-pairing-service.ts`
   - Add `{ kind: 'operator-passkey'; passkeyId; sessionId }` to
     `PairingApproval` (`:373-378`).
   - Add `'operator-passkey'` to `DeviceRevocationActor` (`:380`).
   - Accept them in `setDeviceScope` (`:2382-2400`, the approval checks at
     `:2398`, `:2456`), `revokeDevice` (`:2148`), and `removeRevokedDevice`
     (`:2316-2322`).
   - Record the actor in `device.revocation`.
6. `src-server/services/consent/consent-transactions.ts`
   - Add `'operator-passkey'` to `ConsentDecisionAuthority` (`:207-222`).
   - Add an optional per-transaction `ceremony: 'webauthn'` flag. Transactions
     with that flag refuse every non-passkey authority. A device cookie, the
     operator credential, or a consent session cannot decide a
     `device-access-change` transaction.
7. `src-server/runtime/consent/consent-listener.ts`
   - For `ceremony: 'webauthn'` transactions, serve a page with a CSP of
     `script-src 'nonce-<per-render>'` and one first-party inline module that
     calls `navigator.credentials.get`. It keeps `default-src 'none'`,
     `frame-ancestors 'none'`, and COOP.
   - The decide POST becomes a same-origin `fetch`. It still requires:
     - an exact Origin;
     - `Sec-Fetch-Site: same-origin`;
     - the render nonce;
     - the assertion.

     It drops the `navigate`/`?1` requirement only for this kind; the
     assertion's UV replaces user activation as the user-presence proof.
   - The challenge is `H(transactionId ‖ renderNonce ‖ fingerprint ‖ random)`,
     stored server-side and consumed atomically together with the nonce.
   - Server verification:
     - `type === 'webauthn.get'`;
     - origin equals the operator origin;
     - `rpIdHash`;
     - UP and UV flags;
     - the credential belongs to a non-revoked operator passkey;
     - the sign counter;
     - target revalidation (existing step 6).
   - Add routes:
     - `GET /operator/sign-in`, `POST /operator/sign-in/options`,
       `POST /operator/sign-in/complete` (sets the session cookie);
     - `GET /operator/enroll/:requestId`,
       `POST /operator/enroll/:requestId/options`,
       `POST /operator/enroll/:requestId/complete`.

     Update `assertConsentListenerRouteCoverage` for them.
8. New operator auth routes on the main API:
   - `POST /api/operator/passkey-enrollments`: device cookie required.
     Creates a pending request, rate-limited like access requests
     (`remote-access-threat-model.md:1153-1158`), and returns
     `{ requestId, code, reviewUrl }`.
   - `GET /api/operator/passkey-enrollments`: host operator only.
   - `POST /api/operator/passkey-enrollments/:id/confirm` and
     `DELETE /api/operator/passkey-enrollments/:id`: host operator only.
   - `GET /api/operator/passkeys`: host operator or operator session.
   - `DELETE /api/operator/passkeys/:id`: host operator. Remote revocation
     with step-up from a *different* passkey is D8.
   - `GET /api/operator/session` and `DELETE /api/operator/session`: own
     session status and sign-out.
   - `DELETE /api/operator/sessions`: revoke all; host operator, or step-up.
9. Cascades:
   - revoking a device → revoke the sessions bound to it (`revokeDevice`, `:2148`);
   - revoking a passkey → revoke the sessions created with it;
   - `station environment reset` clears passkeys and sessions (**REASONED**:
     reset already clears every device credential,
     `remote-access-threat-model.md:1238-1242`);
   - `credential rotate` revokes operator sessions but keeps passkeys (D8).
10. Audit: one event per privileged action,
    `station.operator.device_access_change`, with:
    - `action`;
    - `targetDeviceId`;
    - `actor: { kind: 'operator-passkey', passkeyLabel, passkeyIdPseudonym, viaDeviceId }`
      or `{ kind: 'host-operator', mint: 'operator-credential-loopback' | 'local-grant' }`;
    - `confirmation: 'passkey-uv' | 'host-channel'`;
    - `transactionId`;
    - `timestamp`.

    Pseudonymize ids with the existing keyed pseudonym
    (`pseudonymizePairingAuditSource`, `environment-security-service.ts:369-386`). Record enrollment, sign-in,
    sign-out, and revocation the same way.

### 4.3 CLI

11. `packages/cli/src/commands/device-access.ts`: **no change**. Test that by
    pinning the file's git hash in the slice-4 PR description and checking it
    in review.
12. `packages/cli/src/commands/environment.ts`: add host verbs that reuse
    `openLocalOperatorChannel` (`:1461`):
    - `station environment operator passkeys [--json]`
    - `station environment operator passkeys approve <request> [--code=NNNNNN]`
    - `station environment operator passkeys deny <request>`
    - `station environment operator passkeys revoke <id>`
    - `station environment operator sessions revoke --all`
13. Slice 5 (optional): `openRemoteOperatorChannel`. Its `request()`:
    - sends the CLI's paired-device bearer plus an operator session token
      that it obtains through a browser handoff bound to that device;
    - on a 202 `step_up_required`, prints the `reviewUrl` (and opens it when
      a browser is available), polls the transaction, and returns `effect`.

    `runDeviceScopeCommand`'s check of the returned device
    (`device-access.ts:324-327`) then holds unchanged.

### 4.4 UI

14. `packages/connect/src/react/connection-manager-modal/PairedDevicesPanel.tsx`:
    - Remove the operator-credential field and `deviceAdminFetch`
      (`:54, :74-97, :271-291`) on non-native surfaces (D2).
    - Read the inventory with the session cookie (same-origin
      `credentials: 'include'`).
    - On 401 `operator_session_required`, or 403 from a non-operator device,
      show **Sign in as operator**, which opens `/operator/sign-in` on the
      operator origin in a new window, then poll `GET /api/operator/session`.
    - On a 202 from a scope change, open `reviewUrl` in a new window, poll the
      transaction, and render `FullAccessRevocationNotice` from `effect`.
    - Show the session expiry and a **Sign out** control.
    - Fix the status mapping so 403 no longer reads as "reconnect".
15. Host surfaces (desktop app, host browser): add an **Operator passkeys**
    section listing pending enrollment requests (code, requesting device,
    RP ID), enrolled passkeys, and active sessions, with confirm, deny, and
    revoke.

---

## 5. Enrollment and step-up UX

### Enrollment (once per operator origin)

1. On the remote browser (already paired), open Paired devices and choose
   **Set up operator sign-in**. The page creates an enrollment request and
   opens the operator origin. The page shows: "Confirm on your Station host:
   code 482 913, this device 'Phone browser'."
2. On the host (desktop app section or `station environment operator passkeys`),
   the pending request shows the code, the requesting device's verified name,
   the RP ID (`station.example.ts.net`), and its expiry (5 minutes). The
   operator chooses **Confirm**.
3. The remote page advances: "Create your operator passkey." The browser and
   OS passkey sheet appears; the operator confirms with biometric or PIN. The
   server verifies the registration with attestation `none`, UV required, and
   resident key preferred (D7), then stores it with `confirmedVia`.
4. The page prompts: "Add a second passkey (recommended), for example a
   security key or a phone." Same flow, without a new host confirmation if it
   happens within the same confirmed request window (D5).

Ordering alternative: create first, host confirms after. Rejected, because an
unconfirmed authenticator would sit in the store. With confirmation first, a
confirmed request is single-use and expires.

### Sign-in

From **Sign in as operator** to the operator origin: one passkey prompt, then
the session is set and the panel's list loads. Expiry is shown, and the
session expires after 15 minutes idle or 60 minutes absolute.

### Step-up (each scope change, revoke, or record removal)

1. In the panel, the operator chooses Change access, picks the scopes, and
   clicks **Apply**.
2. A new window opens on the operator origin with canonical review text, for
   example: "Change access for 'Work laptop' (a1b2c3d4): add Full access.
   Before: Operate, Read. After: Operate, Read, Full access." The text comes
   only from the transaction description (`consent-transactions.ts:13-15`).
   Granting `approval:full-access` gets an additional warning line.
3. The operator chooses **Confirm with passkey**, completes the passkey
   prompt, and the window shows "Applied". The panel's poll picks up `effect`
   and shows the full-access reset report.
4. If the operator cancels or the transaction expires (5 minutes,
   `consent-transactions.ts:45`), nothing changes, and the panel says so.

---

## 6. Revocation and recovery

| Event | Action | Who |
|---|---|---|
| Paired browser stolen | Revoke the device on the host. Bound operator sessions end, and live leases drop (existing `disconnectDevice`, `runtime-routes.ts:8670`). | host, or another operator session + step-up |
| Passkey lost | `station environment operator passkeys revoke <id>`. Sessions created with it end. | host (D8 for remote) |
| Every passkey lost | Use the host. Device admin keeps working through the host CLI and desktop app. Enroll a new passkey with host confirmation. | host |
| Suspected session theft | `DELETE /api/operator/sessions` (all), or `sessions revoke --all` on the host | host, or step-up |
| Operator credential rotated | Operator sessions revoked; passkeys kept (D8) | automatic |
| `environment reset` | Passkeys, sessions, and devices all cleared | automatic |
| Host unreachable and passkey lost | No remote admin until the host is reachable. This is by design: there is no email or password reset path. | — |

---

## 7. Test plan

Every route test drives the real `configureDevicePairingHostRoutes` through the
real `runtime-http` middleware (`src-server/runtime/__tests__/device-pairing-routes.test.ts`),
with real principal stamps.

### 7.1 Unit and service tests

- **Passkey verification.** Use fixtures captured from a real Chromium
  virtual authenticator run (exact writer shape), committed under
  `__tests__/fixtures/`. Cover:
  - valid;
  - wrong origin (the app origin);
  - wrong RP ID;
  - UV flag clear;
  - UP clear;
  - sign-counter regression;
  - unknown credential;
  - revoked credential;
  - challenge reuse;
  - challenge minted for transaction A presented on transaction B;
  - fingerprint mismatch after the target changed.
- **Sessions:**
  - idle and absolute expiry, at boundary and boundary + 1 ms;
  - device revoked;
  - passkey revoked;
  - a cookie presented with a *different* device cookie;
  - a cookie with no device cookie.
- **Enrollment:**
  - an unconfirmed request cannot register;
  - a confirmed request is single-use;
  - an expired request is refused;
  - a non-host caller cannot confirm (internal token, local-grant
    `ui-bootstrap` mint, remote operator credential);
  - the rate limit refuses the sixth request.

### 7.2 Route matrix

Each row is driven as a child request through the middleware, with the exact
status and body asserted.

Callers:
- host operator credential over loopback;
- the same credential via the UI proxy (remote);
- a local-grant-minted credential;
- a `ui-bootstrap` mint;
- the internal token;
- an ordinary paired device;
- a device holding `access:manage`;
- a device holding `access:approve`;
- a device holding `consent:decide`;
- a delegation device;
- a valid operator session;
- an expired operator session;
- an operator session bound to another device.

Routes: the five routes in section 3.2.

The required rows:
- an operator session gets 202 and **no mutation** on the scope route, read
  back through the host channel;
- a **non-operator device is refused** on every route;
- the remote operator credential is refused after D2.

### 7.3 Consent listener

- A `device-access-change` transaction refuses decisions via device cookie,
  operator credential, consent session, and native host; only
  `operator-passkey` decides it.
- The decide POST is refused when any of these is missing or wrong: Origin,
  nonce, `Sec-Fetch-Site`, or the assertion.

### 7.4 Fault injection

For each, commit, confirm a clean `git status --short`, inject, show the named
test failing with the expected assertion text (not "no tests found" or a build
break), restore, and confirm green.

| Injection | Expected failure |
|---|---|
| `operatorSessionReader` mutates instead of returning 202 | "202 and no mutation" row |
| Origin check in the assertion verifier removed | wrong-origin fixture |
| UV check removed | UV-clear fixture |
| Challenge not consumed | replay test |
| Device binding of the session ignored | other-device row |
| Operator-session branch falls through to device admission on an invalid cookie | invalid-cookie test |
| `isHostOperator` host-secret proof clause removed | remote operator credential row (S1 itself injects the forwarding-evidence check and the position clause against its off-host rows) |
| `ceremony: 'webauthn'` gate removed | device-cookie decision row |

### 7.5 CLI

- `device-access.test.ts` with a fake channel that answers 202 and then
  returns `effect`. Output must be identical to the direct path.
- Pin that `device-access.ts` is unchanged in slices 2-4.

### 7.6 Local-first invariant

`src-server/services/identity/__tests__/local-mode-invariant.test.ts` stays
green. With no passkeys and no consent HTTPS origin, the host paths behave as
before.

### 7.7 Rendered paired-browser verification (e2e)

A new browser spec covers passkey device access.

Important: the suite's default "paired" context presents the **operator
credential** as a bearer (`tests/helpers/device-class-context.ts:14-22`), so it
cannot stand in for a non-operator device. The spec needs a new fixture that
pairs a real device through the pairing flow and presents only its device
cookie. A second such fixture is the non-operator device.

The authenticator is Chromium's virtual authenticator via a CDP session
(`WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator` with
`hasUserVerification` and `isUserVerified: true`), with RP ID `localhost` and
the operator origin `http://localhost:<consent port>`.

Steps, with screenshots read and inspected (not just stamped) at each marked
point:

1. A paired, non-operator browser opens Paired devices. It sees **Sign in as
   operator**, and no inventory loads. *Screenshot.*
2. Enroll. The host confirms through a child-process `station environment
   operator passkeys approve <id> --code=…` with the exit status asserted.
   The passkey is created.
3. Sign in. The list loads and shows the second device. *Screenshot.*
4. Change the second device's scope (add `approval:full-access`). The review
   window shows the canonical text (*screenshot*). The assertion succeeds.
   Verify the new scope through an **independent read**:
   `station environment access devices --json` as a child process.
5. Set the virtual authenticator to `isUserVerified: false` and repeat. The
   change is refused, and the scope is unchanged on read-back.
6. In the second, non-operator device context, the panel is refused, and a
   direct `POST /api/pairing/devices/:id/scope` with its cookie gets 403.
   *Screenshot.*
7. Revoke the first device from the host. The next operator read gets
   `operator_session_required`.

### 7.8 Real-origin verification (manual; the owner runs the remote origin)

- An isolated Station home, instance name, and non-default ports.
- Tailscale Serve HTTPS on the app port and a second HTTPS mapping for the
  consent port, with `STATION_TRUSTED_CONSENT_ORIGIN` set.
- A real phone passkey and a real security key.
- Repeat steps 1-7 on the rendered phone browser and attach the screenshots.
- Record what CI cannot cover as **NOT_VERIFIED in CI**:
  - a real RP ID on a DNS name;
  - synced-passkey behaviour;
  - cross-device (hybrid) sign-in.

---

## 8. Slicing (PR-sized)

| Slice | Content | Behaviour change | Depends |
|---|---|---|---|
| **S0** (this change, except the threat model) | Docs: amend `identity.md` "Where passkeys fit" (operator passkeys yes, pairing passkeys still no) and `principals.md`, and record the decisions. The threat model's credential and recovery sections change with S1b and S3, when behaviour does. | none | owner decisions |
| **S1** (this change) | The host-locality predicate (`src-server/security/host-operator-credential.ts`) and its route-matrix test. The host desktop credential question is resolved (section 1). Observe only: each raw operator-credential use on the four device-admin routes is recorded with its position; an off-host use is logged at warn with a per-process count (readable through the diagnostics log read) and counted in `station.device_pairing.operator_credential_uses`. Nothing is refused, and the panel's paste field stays. | none (observation) | S0 |
| **S1b** | After an owner-chosen observation period: refuse the raw operator credential on the four device-admin routes **unless it comes with proof of a host-only secret** (not network position), with a stable error that names the host CLI. | D2 | S1, owner |
| **S2a** | HTTPS operator origin: `STATION_TRUSTED_CONSENT_ORIGIN`, `reviewUrlFor` HTTPS, docs for the second Tailscale Serve mapping. | none by default | S0 |
| **S2b** | Passkey registry, enrollment requests, host confirm/deny/revoke (CLI verbs, desktop section), enrollment pages on the operator origin, WebAuthn dependency. | new opt-in surface | S2a, D6 |
| **S3** | Operator sessions: sign-in pages, the middleware branch, the `'operator-session'` authority (with the negative-comparison audit), `GET /api/pairing/devices` accepting a session, panel sign-in, list load. | reads only | S2b |
| **S4** | Step-up: `device-access-change` transactions, the `'operator-passkey'` decision authority, 202 from the three write routes, the transaction status route, panel apply flow, audit events, cascades. Remove the panel's pasted-credential field on non-native surfaces (D2: only once the passkey path exists). The e2e spec in section 7.7. | the issue's acceptance | S3 |
| **S5** (optional) | Remote CLI operator channel with browser handoff. | new | S4, D9 |
| **S6** (deferred) | Native shells: a system-browser handoff for the ceremony (Android WebView lacks WebAuthn, `identity.md:86-88`). | new | S4, D9 |

Sequencing: per the owner comment, design and security review come after
#2377 slice C2b. S1-S4 touch `runtime-http.ts` and `runtime-routes.ts`, which
the #2377 slices also edit. Check for in-flight lanes before starting.

---

## 9. Decisions

### Decided (owner, 2026-10-03)

| # | Decision |
|---|---|
| D1 | Step-up runs on the **separate consent origin**, as a new kind of the existing consent transaction. Remote use needs an HTTPS mapping for that origin (S2a). |
| D2 | The raw operator credential on the device-admin routes becomes **host-only** (loopback, or the desktop app's local-grant credential). **Observe first:** log and count off-host uses for a period (S1), then refuse in a later step (S1b). The panel's paste field is removed only when the passkey path exists (S4), not in S1. Security review of S1 (2026-10-03): "host-only" must be enforced by proof of a host-only secret; loopback position is telemetry, because a same-host proxy or tunnel can fake it. |
| D6 | Add `@simplewebauthn/server` (and `/browser`) in the enrollment slice (S2b), not before. It must pass the Dependency review check. |

Scope: this record and S1. S2a, S2b, S3, S4 (and S1b) are follow-ups.

### Open, with recommendations

| # | Decision | Recommendation |
|---|---|---|
| D3 | Bind operator sessions to a paired device, or allow any browser | Bind. It gives "from which device" for audit and a revocation cascade, and keeps the device ingress gate. |
| D4 | Session lifetimes; confirm per-action step-up with no window | 15 minutes idle, 60 minutes absolute; per action |
| D5 | Enrollment: browser request + host confirm with code, or host-minted code. Whether one confirmation may enroll two passkeys. | Browser request + host confirm. Allow two passkeys within 5 minutes. |
| D7 | Authenticator policy: UV required, attestation `none`, synced passkeys allowed, AAGUID allowlist? | UV required, `none`, synced allowed, no allowlist |
| D8 | Remote revocation of a passkey with a step-up from another passkey; `credential rotate` revokes sessions | Allow with a different passkey; yes, rotate revokes sessions |
| D9 | v1 scope: remote confirmation of pairing requests? Remote CLI (S5)? Native shells (S6)? | None in v1. Pairing approval stays on the host or with `access:approve`. |
| D10 | Stations reachable only by IP or without a DNS name get no remote operator sign-in | Accept and document |
| D11 | Hosted tenants | Out of scope; refuse operator passkey routes when a hosted tenant registry is present |
