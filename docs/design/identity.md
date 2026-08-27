# Design: Identity (pluggable sources, local-first invariant)

> Status: **landed**. One identity source ships today
> (`TailscaleServeIdentitySource`, tailnet WhoIs ingress). The abstraction and
> the ordered source list are the seam for future, additive providers; the
> local-first invariant below is enforced by a named regression guard
> (`src-server/services/identity/__tests__/local-mode-invariant.test.ts`).
>
> Companion contract: [principals.md](principals.md) owns what a *principal* is
> (Station has exactly one today, implicitly), the three orthogonal axes
> tenant/account/member, and the triggers that change that. This document owns
> how a request is attributed to a verified identity; it does not decide how
> many principals exist.
>
> This document is the contract for the identity area. The Kontour-account and
> device providers described under "Model" are the *shape* of planned additive
> work — not yet implemented — and are recorded here so they land without
> touching the pairing/authz layer or the local-first floor.

## Model

Station verifies *who* a request is from through pluggable **identity sources**.
Each source inspects an ingress request and either produces a provider-agnostic
`VerifiedIdentity` or returns `null` when it cannot vouch for the request. The
authz/pairing layer never learns which provider produced an identity — it
consumes the identity keyed by its stable `subject`.

The seam is defined in `src-server/services/identity/identity-source.ts`:

- `VerifiedIdentity` — `{ provider: 'tailscale-serve' | 'kontour-account' | 'device'; subject; displayName?; federatedVia? }`.
  `subject` is the stable id within the provider; `federatedVia` is reserved for
  an upstream issuer (e.g. github/google) behind a Kontour account.
- `IdentitySource` — `{ readonly provider; identify(context): VerifiedIdentity | null }`.
- `IdentityRequestContext` — `{ environment: unknown; header(name): string | undefined }`:
  the node environment (for transport-trust checks such as the loopback
  attestation the tailnet source performs) plus a raw header accessor, so each
  provider reads only the headers it cares about.

### Sources

- **`TailscaleServeIdentitySource`** (today, the only one). Wraps
  `readVerifiedIngressIdentity` verbatim — same loopback + internal-token
  attestation, same validation — and maps the tailnet WhoIs `login` onto
  `VerifiedIdentity.subject` with `provider: 'tailscale-serve'`.
- **`KontourAccountIdentitySource`** (future, additive). Would validate a Kontour
  AI account session token federated from an upstream identity provider
  (GitHub/Google/etc.), returning `provider: 'kontour-account'` with
  `federatedVia` set to that issuer. It waits on the external Kontour token
  contract and must not be implemented ahead of it.
- **Identity-bound device credentials** (future, additive). Device credentials
  bound to a verified identity would surface as `provider: 'device'`.

### Where passkeys fit (and where they do not)

Recorded so the reasoning is here when the two future sources above get picked
up, rather than rediscovered against a wall.

**Passkeys belong in `kontour-account`, not in device pairing.** A WebAuthn
credential is bound to an RP ID — a single domain. That is a good fit for a
hosted account: one stable HTTPS origin, one phishing-resistant identity, and
Stations federate through `federatedVia` instead of authenticating the user
themselves.

**They fit device pairing badly, for reasons already demonstrated in this
codebase.** A native shell's page origin is `tauri.localhost` while a Station
is reached at whatever address the user has — a tailnet MagicDNS name, a LAN
IP, loopback. A passkey enrolled against one of those is unusable from the
others, because the RP ID no longer matches. This is the same origin mismatch
that already makes `SameSite=Strict` dead weight on the device-session cookie
(`runtime-routes.ts`): from the native shell every request to a Station is
cross-site. Per-RP binding also means one passkey *per Station*, which is the
opposite of a unified identity. Android WebView additionally does not expose
WebAuthn the way a browser does, so it would need a native bridge to Android
Credential Manager / `ASAuthorization` before any of this is even reachable.

**For `provider: 'device'`, the better primitive is a device keypair.**
Generate it in the OS keystore and sign a per-request challenge. That buys the
same property people actually want from passkeys here — no bearer secret
sitting on the device — without inheriting the RP-ID constraint, and it works
from a native shell to a Station at any address.

**None of this blocks fixing credential storage first.** Every design above
still needs somewhere on the device to keep *something*: a bearer credential
today, a key handle later. `ConnectionStore`'s injectable `credentialStorage`
is that seam, and swapping what is stored is a backend change rather than a
redesign. Waiting for unified auth to fix storage would leave native shells
re-pairing on every launch in the meantime.

### The ingress boundary

`src-server/runtime/routes/runtime-routes.ts` holds an **ordered** source list,
`INGRESS_IDENTITY_SOURCES`, and a **first-match** helper, `identifyIngress(c)`:
the first source that recognizes a request wins; if none do, `identifyIngress`
returns `null`. Registering a new provider is purely additive — append its
source to the list. The pairing/authz boundary adapts the provider-agnostic
`VerifiedIdentity` back to whatever the pairing service's requester contract
needs (today: `subject → login` for the Tailscale Serve requester shape), so no
authz change is required when a new source is added.

## Local-first is non-negotiable

**Station MUST be fully functional with zero identity providers and zero
network.** Identity — tailnet, a Kontour account, fleet federation — is strictly
an *additive enhancement layer*, never a precondition for using Station. This is
the same DNA the constitution makes non-negotiable: *"All runtime data lives in
the user's home directory. No cloud account required."* (constitution belief #5,
"Local-first, user owns their data") and *"No hardcoded vendor dependencies in
core paths. The core runtime, SDK, and CLI work without any specific cloud or
model provider."* (constitution non-negotiable #3). Identity is an adapter-layer
concern, not a core-path dependency.

Concretely:

- **No sign-in requirement.** The default first-run local experience (the
  desktop-bundled server on loopback) needs no Kontour account and no external
  identity of any kind.
- **Empty / all-null source list ⇒ unchanged auth.** When
  `identifyIngress` returns `null` (no source recognizes the request, which is
  every request when the list is empty or no ingress credential is presented),
  Station's authentication is exactly today's: the local operator credential
  plus the device-pairing bearer, with same-origin manual approval. The presence
  of the source list never makes identity mandatory.
- **Local state is the source of truth.** A host's own `~/.station`
  session/config is authoritative. Fleet federation is *read augmentation* over
  local state — never a replacement for it and never a precondition. A host with
  no reachable peers and no account still shows its own complete local history.
- **Offline degrades fleet features, never the app.** Being offline means
  Station cannot reach peers or validate a Kontour token; those augmentations go
  dark. The local application keeps working.
- **No core hard-dependency on remote identity.** Nowhere in the core runtime,
  SDK, or CLI is a Kontour account or a remote identity service a hard
  dependency — vendor-neutral, own-your-infra, as the constitution requires.

### Standing acceptance criterion (every identity/fleet PR)

A Station instance with **no identity source configured and no network** must
start, complete first-run, pair a local device, authenticate, and chat —
identical to pre-identity behavior. Every PR that touches identity or fleet
federation carries this as an acceptance criterion.

This invariant is guarded by
`src-server/services/identity/__tests__/local-mode-invariant.test.ts`, which
asserts against the **real** `INGRESS_IDENTITY_SOURCES` / `identifyIngress` (not
a fixture) that a loopback request with no ingress-identity headers yields no
identity, and — at the handler layer — that such a request follows the
same-origin/manual-approval path rather than being labeled `tailnet`. If a
future change makes identity a precondition for the local path, that guard
fails.
