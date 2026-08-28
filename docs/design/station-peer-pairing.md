# Design: Station-to-Station peer pairing (spike, station#1123)

> Status: **spike deliverable — decision doc, no implementation**. Answers the
> three decision points from the owner's reframing comment on #1123
> (2026-07-28). Refs #1123, #1134, #1133, #1128, #1119, #1116, #1114/#1098,
> #1131, #1143.

> **Supersession note (added 2026-08-03).** §9 slices 1–3 **shipped** on
> 2026-07-28 (`b4e0e887` and follow-ups). §1 "Current state, verified" now
> describes the **pre-slice** tree and is retained as the record of what the
> decision was made against — it is no longer current behaviour. Read §1 as
> history; verify any present-tense claim against the code before acting on it.
>
> This matters most in the safe-to-unsafe direction: §1 and §4 describe the
> loopback bypass as unconditional and SSH delegation as carrying no
> `Authorization` header. **Both are false today**, so a reviewer trusting this
> section would file findings against protections that already exist, or
> inherit a threat model the code has moved past.
>
> What shipped, with current evidence:
>
> | §1/§4 claim | Now |
> | --- | --- |
> | "no field distinguishing an interactive device from anything else" | `PairedDeviceKind = 'device' \| 'delegation'` — `packages/contracts/src/environment-security.ts:393`, used at `:414` |
> | delegation resolves `kind: 'current' \| 'ssh'` only | `kind: 'current' \| 'ssh' \| 'peer'` — `src-server/tools/station-control-delegation.ts:100` |
> | SSH calls carry "no `Authorization` header of any kind" | an `'ssh'` target attaches `Authorization: Bearer` when a peer credential exists for that `environmentId` — `station-control-delegation.ts:87-93,643-648` |
> | "no way to express 'standard minus terminal'; a third preset is required" | the `delegation` preset exists — `environment-security.ts:174` (and a fourth, `inference`) |
> | the loopback bypass "returns immediately: `if (effectivePeerClass === 'loopback') return next();`" | retired by station#2051: ordinary protected callers, including direct loopback and SSH, require a bearer/device-session credential; only the exact internal-token attestation is separate |
> | the outbound credential "needs a **new** server-side store" | it exists — `src-server/services/peers/peer-credential-store.ts`, routes in `src-server/routes/environments/peer-credential-routes.ts`, CLI verbs `station environment peers list\|add\|remove` |
>
> Kept rather than rewritten because the doc's value is the *decision record*:
> rewriting §1 to match today would destroy the evidence the decisions were
> weighed against, and this doc is cited by later work.

## 0. What changed in the reframe

The original #1123 asked a narrower question: should `delegate_task` target any
`KnownEnvironment`, not just SSH profiles. The owner's reframing comment
replaced that with a bigger claim: pairing is symmetric by nature, so a single
pairing act should establish *both* directions — "device may control Station"
and "Station may delegate to peer" — at once. Under that model, SSH stops being
a relationship and becomes one of several **access methods** (how you reach a
peer with no direct HTTP path), and #1133's managed launch becomes a property of
that access method rather than of the peer relationship.

This doc evaluates the reframe against the current code and answers the three
questions, with file:line evidence for every claim about current behavior.

## 1. Current state, verified

Three separate mechanisms exist today; none of them talk to each other.

- **Device pairing** (client → server, "may control me"): `DevicePairingService`
  persists a `PairedDevice { id, name, scope, createdAt, lastUsedAt, revokedAt }`
  per exchanged credential, keyed by `environmentId`, in `paired-devices.json`
  (`src-server/services/ssh/device-pairing-service.ts:279-291`; registry load at
  `:83-87`). There is **no field distinguishing an interactive device from
  anything else** — every entry is presented and revoked identically.
- **SSH environments** (server → server, "I may delegate to it"):
  `SshEnvironmentProfile { id, hostAlias, remoteProjectPath, remotePort,
  environmentId, verifiedProjectPath, ... }`
  (`src-server/services/ssh/ssh-environment-profile-store.ts:27-41`) has **no
  credential field at all** — trust is entirely "I can SSH to this host". The
  tunnel is a plain OpenSSH local forward
  (`src-server/services/ssh/openssh-environment-adapter.ts:148`).
- **`KnownEnvironment`** (#1116, merged): an explicitly **client-side,
  no-secrets, read-only reference model** that device-paired origins, the CLI
  host registry, and SSH profiles all project onto for display, joined by
  `environmentId` after a handshake
  (`packages/contracts/src/known-environment.ts:82-103`). Its doc comment is
  explicit that it deliberately does **not** model credentials (`:30-35`) or
  launch (`:24-28`).

Delegation (`src-server/tools/station-control-delegation.ts`) resolves a target
as `kind: 'current' | 'ssh'` only (`:60-64`, `:111`, `:143`, `:152`). For
`'ssh'`, `connectSshTarget` (`:417-479`) returns a `DelegationTarget` whose
`apiBase` is the loopback-forced local end of the tunnel (`requireLoopbackTunnel`,
`:393-415`) — **with no `requestOptions` set at all** (compare `:487-493`, which
sets `requestOptions: controlRequestOptions()` only for `kind: 'current'`). Every
subsequent call against an SSH target therefore carries **no Authorization header
of any kind**. It works today purely because the remote classifies the arriving
connection as loopback and skips authentication entirely — see §4.

Notably, the client-side split the reframe wants already exists once:
`packages/connect/src/core/types.ts` defines `EnvironmentAccessMethod` as a union
of `DirectHttpAccessMethod` (`:35-39`) and `HostTunnelAccessMethod` (`:44-51`,
`adapter: 'ssh'`). Station has already drawn this "relationship vs transport"
line for the browser reaching a server; the reframe asks for its server-side
mirror.

## 2. Decision 1 — Delegation credential scope shape

**Recommendation: adopt `orchestration:read orchestration:operate` (no
`terminal:operate`, no `access:manage`), revocable from the peer's device list
and visibly labeled — shipped as a NEW named preset, with two corrections.**

**Why this scope suffices.** Every call `delegate_task` makes against a remote
target (`getProject`, `getAgent`, `startSession`, `sendTurn`,
`getOrchestrationSession`, `respondToRequest`, `interruptTurn` — `:504`,
`:777-785`, `:1710`, `:1756`, `:1792`, `:1824`, `:1834`, `:1858`, `:1892`,
`:1915`) resolves under the route-scope table
(`src-server/security/pairing-route-scopes.ts:178-268`) to either
`orchestration:read` (GET/HEAD) or `orchestration:operate` (mutating). No call
touches the terminal routes or the terminal WebSocket. This is the exact minimum
for the delegation tool's actual wire surface.

**Correction 1 — this must be a NEW preset.** The shipped presets
(`packages/contracts/src/environment-security.ts:69-76`) are `'read-only'`
(`orchestration:read`) and `'standard'` (`orchestration:read
orchestration:operate terminal:operate`). `standard` **includes terminal**.
There is no way to express "standard minus terminal" today, because
`terminal:operate` is enforced independently at the WebSocket layer
(`PAIRING_WS_SCOPES.terminal`, `pairing-route-scopes.ts:279-282`). A third
preset is required.

**Correction 2 — "no terminal" bounds the peer's own reach, not the remote
agent's tools.** The scope gates the API surface *the calling peer* uses to
submit and monitor a task. It says nothing about what tools the *remote's own
agent* has inside that session (e.g. shell access) — that is governed by the
remote's local tool/approval configuration. Excluding `terminal:operate` does
**not** prevent a delegated agent from running shell commands; it prevents the
delegating peer from opening a side-channel PTY on the remote outside the
orchestration session. Document this distinction wherever the scope is
described; conflating the two would misstate the boundary.

**What it also grants — a real finding.** `orchestration:operate` is the tier
`GET /api/environments/ssh/sessions` was deliberately raised to (leaf override,
`pairing-route-scopes.ts:209-231`; `docs/security/remote-access-threat-model.md:183-205`).
So a delegation credential also lets that peer enumerate summaries (titles,
project slugs, agents, models) of *any SSH environment the grantor separately
has configured*. Not new exposure — `standard` already carries it — but peer
pairing makes this a **routine** grant rather than a rare one, which changes the
risk calculus. Open item for the owner: accept as consistent with existing
tiering, or add a targeted leaf override the way #1131 did (Slice 6).

## 3. Decision 2 — Mutual exchange mechanics

**Recommendation: two checkboxes, each confirmed by the side that is GRANTING
that direction, on its own screen — not one code whose creator pre-bakes both
directions for a blindly-scanning counterpart.**

This refines rather than rubber-stamps the owner's lean. "Two checkboxes in one
flow, defaulting to control-only" is right about the default and right about
wanting a conscious grant, but under-specifies *whose screen* the second
checkbox lives on — and the current protocol makes that decisive:

- The host side already performs the only real approval that exists: a
  scope-preset radio at offer creation
  (`packages/connect/src/react/DevicePairingPanel.tsx:933-950`) and a
  confirm/deny of the incoming request (`:719-753`;
  `device-pairing-service.ts:453-465`).
- The joining side (`JoinDevicePairingPanel`, `DevicePairingPanel.tsx:51-563`)
  has **no confirm step of any kind**. It scans or types a code, names the
  device, and immediately polls `exchange()` (`:173-247`). `describeDeviceScope`
  is used only in the host panel (`:851`, `:996`) — the joiner never sees, and
  never accepts, the scope it receives.

If the second checkbox lived only on the host's offer-creation screen, the
joiner's grant of the powerful reverse direction would be implicit in scanning a
code — exactly the failure mode the owner warned against. A flat reading of "two
checkboxes in one flow" lands there by default, because today's flow already has
this asymmetry baked in.

**Refined mechanics:**

1. The initiating side sets one checkbox on its own offer-creation screen —
   *"Also let this peer delegate work to me"* (default **off**) — carried as an
   additional field on the wire offer, expressing a *conditional* outbound grant.
2. The joining side, before `requestPairing`/`exchange`, must see **both**
   directions plainly and independently confirm its own outbound checkbox
   (default **off**). This is new UI/state in `JoinDevicePairingPanel`; there is
   no existing gate to extend.
3. The host's existing `confirmRequest` is unchanged in mechanism but now also
   displays the joiner's reciprocal decision, since it is the finalizing click.
4. `exchange()` mints the forward credential unconditionally, **plus** a
   reverse-direction credential (Decision-1 scope) only when *both* toggles
   resolved true.

A headless/CLI joiner satisfies the same principle with a text prompt naming
both directions; the affordance is a build detail, not part of this decision.

**Rejected — always-symmetric with no toggles:** the implicit-grant failure mode,
merely automated. **Rejected — keep them fully separate acts:** defeats the
reframe and leaves #1134 unsolved.

## 4. Historical decision record — The loopback bypass (pre-station#2051)

> **Historical context only.** The recommendation and coexistence assumptions
> below were written before station#2051 retired the generic loopback/SSH
> floor. They explain the original decision; the current contract is the
> credential requirement summarized above.

**Recommendation: narrow it additively — never touch the loopback classification
itself, and preserve today's behavior exactly for any peer without a delegation
credential.**

**The mechanism.** `configureRuntimeSecurity` computes `effectivePeerClass` from
the raw TCP peer (`classifyRuntimePeer`,
`src-server/security/runtime-request-security.ts:56-71` — loopback iff the direct
socket address is `127.0.0.1`/`::1`) and, before parsing any `Authorization`
header or cookie, returns immediately: `if (effectivePeerClass === 'loopback')
return next();` (`src-server/runtime/bootstrap/runtime-http.ts:152-153`). An SSH
local forward delivers via `sshd`'s own loopback socket, so on the remote this is
**structurally indistinguishable at the TCP layer** from a genuinely local
caller.

**Why the fix cannot be "change `classifyRuntimePeer`".** Zero-friction
same-machine access is a load-bearing product principle
(`remote-access-threat-model.md:16-23`) and is mechanically inseparable from the
SSH case at that layer — both really are loopback connections.

**The lever: order credential-checking ahead of the loopback short-circuit,
conditioned on whether a credential was presented at all.** Parse
`Authorization`/the device cookie *before* the early return
(`runtime-http.ts:152-221`); take the unconditional loopback pass only when
**no** credential is presented. If one **is** presented, always run the normal
verify + `requiredPairingScope`/`resolveGrantedScope` path (`:173-221`). Strictly
additive; loopback's meaning is unchanged.

**Why it doesn't regress today's loopback-credentialed paths** (verified by
reading, not execution):

- Station's internal MCP calls (`station-control-shared.ts`'s
  `controlRequestOptions()`) send no `Authorization` header or device cookie —
  they use `x-station-internal-token`/`x-station-internal-caller`, checked by
  `classifyAttestedProxyCaller` (`runtime-http.ts:118-121`, `:282-297`). With no
  credential present the new check is a no-op.
- The same-origin "Request access" continuity cookie always requests **full**
  scope (`remote-access-threat-model.md:157-165`), so it passes unchanged.

**Why this is not cosmetic.** Without it, Decision 1 is theater over SSH
transport: `connectSshTarget` sends **no** credential at all (§1), so nothing
forces the delegating side to present one, and the unconditional loopback bypass
would grant full trust regardless of scope. Closing this needs two coordinated
changes: (a) the middleware reorder above, and (b) the SSH-target path must
attach the minted peer credential's `Authorization: Bearer` on requests to
`target.apiBase` when one exists for that `environmentId`.

### Loopback scopes are not an exception (station#1198)

The same rule applies to a credential stored by a desktop self-pairing flow or
by the CLI for a Station on the current host. A Tauri webview and the bundled
`127.0.0.1` Station have different origins, so the completed exchange stores a
normal scoped bearer rather than relying on a browser session. The CLI also
presents its saved Station bearer when its selected endpoint is loopback.
Those presented bearers go through the route-scope table before a handler runs:
Read-only can read and stream, while Standard can mutate and open a terminal.

This is a deliberate tightening. The pairing UI promises that Read-only cannot
mutate, and treating loopback as an exception made that promise false. The
recovery for a device that needs control is to re-pair it as Standard; Station
does not broaden the existing bearer because of the transport it uses.

**Coexistence guarantee.** Any SSH environment without a peer credential — the
entire installed base — presents nothing and falls through to exactly today's
behavior. Nothing requires migrating or re-verifying a single existing
environment.

**What the floor still covers, and one thing it no longer does (station#1490).**
The coexistence guarantee above is about *reach*, and it is unchanged. It was
also, unintentionally, a guarantee about *approval*: a caller on the floor could
approve its own pairing request and exchange it for a credential that outlived
the tunnel. Approval is now decided inside `DevicePairingService.confirmRequest`
rather than at the HTTP boundary the floor bypasses — an approver presenting no
credential may confirm only a request this host could PROVE came from another
network stack (`isDefinitelyOffBox`, which refuses loopback, link-local, and
every address this host currently holds; Station's UI proxy attests the address
it saw so the proxy hop stays transparent). Tailscale Serve is judged by its
server-verified ingress identity rather than by address, because Serve re-dials
the UI port from loopback and so has no off-box address to offer. Pairing a
device that is somewhere else is therefore unaffected — every LAN journey and,
by identity, every Serve journey; pairing a second browser or shell on the host
itself now needs `station environment access approve` there. See
`docs/security/remote-access-threat-model.md` for the probe, the residue this
does not close, and why `/api/pairing/**` was not added to
`PAIRING_CREDENTIAL_REQUIRED_PREFIXES`.

## 5. Where the peer relationship is stored

Mutual pairing produces **two server-side artifacts**, because the directions are
structurally different:

- **Inbound ("peer may control me")** reuses `paired-devices.json`
  (`device-pairing-service.ts:279-291`) unchanged, plus one additive field:
  `kind: 'device' | 'delegation'`, defaulting to `'device'` on read for
  back-compat. This satisfies "revocable from the peer's device list, visibly
  labeled" — same list, one more column.
- **Outbound ("I may delegate to peer")** fits neither existing store:
  `paired-devices.json` is inbound-only, and `KnownEnvironment` explicitly
  refuses credentials (`known-environment.ts:30-35`). This needs a **new**
  server-side store keyed by the remote's `environmentId`, holding the bearer
  credential this Station presents and the scope it carries — the server-side
  mirror of `SavedConnection.credentialRef` + `packages/connect`'s
  `StorageAdapter` (`packages/connect/src/core/types.ts:96-100`). The server has
  never needed an *outbound* credential before, because SSH delegation never
  needed one.

`environmentId` stays the join key (`known-environment.ts:93-97`). This doc does
**not** recommend folding `SshEnvironmentProfile`, `paired-devices.json`, and the
new store into one server-side directory in this pass — that is Slice 6, and
"start separate, join key only" is the safer default until the outbound store has
shipped and been exercised.

## 6. Reachability: the server needs its own view

`ConnectionSupervisor` (`packages/connect/src/core/ConnectionSupervisor.ts`) is
transport-agnostic but **client-side** — built for a browser/CLI managing its own
connection (`:1-40`; six states at `:44-51`). Nothing gives the **server** a
persistent reachability model for a peer it wants to delegate to;
`station-control-delegation.ts` does one-shot fetches per attempt (`:335-356`)
with no retry ladder, backoff, or carried "unreachable" state.

Recommendation: port the *shape* of `ConnectionSupervisor` (states, the
transient/terminal split, the retry ladder) into a server-side peer-reachability
tracker. Whether that is a clean extraction or a contentious package boundary is
**UNVERIFIED** (§10). Reuse `KnownEnvironment`'s `AccessEndpointKind`
(`'direct' | 'ssh-forward' | 'discovered'`, `known-environment.ts:67`) rather than
inventing new vocabulary.

## 7. Historical migration and coexistence assumptions

- A credential-less SSH environment behaves identically after every change above
  (§4's coexistence guarantee is load-bearing).
- A peer-paired Station reached over SSH is simply an SSH profile that *also* has
  an outbound peer credential against the same `environmentId`; at that point the
  delegating side presents it and the remote enforces real scope.
- Upgrading an existing SSH environment should re-run peer pairing against the
  already-verified `environmentId` (`ssh-environment-profile-store.ts:34`), not
  redo host/path setup (Slice 8) — cross-reference #1119's hub double-listing
  concern so this doesn't reproduce it for a third source.
- Every change is additive (optional fields, a new store, a new preset) — no
  schema bump, no forced re-pairing, matching the conventions of
  `StationCapabilityFlags` and `PairedDevice.scope`'s in-place migration
  (`remote-access-threat-model.md:219-224`).

## 8. #1133's managed launch as a transport property

Managed launch is a capability of the `ssh-forward` access method's connect
sequence, parallel to how `HostTunnelAccessMethod` already separates "how do I
reach this" from "what state is it in" client-side
(`packages/connect/src/core/types.ts:44-51`). Whether reaching a peer requires
bootstrapping a remote process is a fact about that access method, not about the
peer relationship. Its logic belongs inside the `ssh-forward` connect
implementation — never in delegation target resolution or the peer-credential
store.

## 9. Follow-on build slices

1. **New `delegation` scope preset + `PairedDevice.kind`.** Additive; surfaces a
   distinctly-labeled, manually-mintable delegation credential before any
   mutual-exchange UX exists.
2. **Outbound peer-credential store + `DelegationTarget.kind: 'peer'`**, read
   alongside (not replacing) the SSH path. `delegate_task` can then target a
   directly-reachable peer with its own scoped credential, no SSH required.
3. **Loopback-bypass narrowing (§4)**, with the no-credential fallback unchanged.
   Safe to land before any peer-creation UI — it closes the gap Slice 2 would
   otherwise leave open.
4. **Mutual pairing exchange protocol (§3).** The largest slice; everything above
   is independently exercisable first.
5. **"Add a peer" UI (#1134's collapse).** One code, two-sided independent
   confirm, unified device+peer list.
6. **Target-list unification + residual scope review.** Merge
   `discoverDelegationEnvironments`'s SSH-only read
   (`station-control-delegation.ts:716-760`) across peer store and SSH profiles;
   revisit the §2 cross-station-read exposure.
7. **Server-side peer-reachability tracker (§6).**
8. **SSH-environment-to-peer upgrade path (§7).**

## 10. UNVERIFIED

- Whether `packages/connect`/`ConnectionSupervisor` is already imported
  server-side, or whether extracting its state machine is clean vs contentious —
  not checked; flagged for Slice 7.
- Whether any shipped flow sends a real `Authorization`/device cookie on a
  loopback-classified connection *other than* the two cases in §4 — reasoned from
  code, not executed. Slice 3 must add regression tests pinning both before the
  middleware reorder ships.
- The current saved Station implementation
  (`packages/cli/src/commands/profile-store.ts`) was not part of this earlier
  peer-store assessment; its interaction with a server-side peer store remains
  outside this document's evidence.
