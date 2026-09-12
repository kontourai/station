# Design: Principals — what "people" means in Station, and when it changes

> Status: **decision record**. Principal attribution is now landed; independent
> human membership remains target work. Written 2026-08-03 to reconcile five
> epics that had accumulated overlapping answers to "how do people work here"
> (#1392, #1393, #1707, #741, #1859) and to record the small number of
> decisions that are expensive to reverse.
>
> This document is the contract for the *principal* axis. The identity **seam**
> is a separate, already-landed contract — see
> [identity.md](identity.md), which owns how a request is attributed to a
> verified identity. This document owns what a principal *is* and when Station
> gains more than one.
>
> Complementary topology decision: [station-topology.md](station-topology.md)
> distinguishes principals from machines, Station instances, environments,
> tenants, Project bindings, room homes, and execution offers.

## 0. Why this exists

The question that prompted it: *"do we need to start working on the auth
integrations, because I do think people will also be a thing here?"*

The original answer was **no, not yet**. That historical scheduling answer is
superseded by the authorized program in section 5. The useful distinction is
that "people" names three different problems, and the five epics addressing them had been
filed months apart with four conflicting assumptions. Building
any one of them first, without this reconciliation, would make the others more
expensive.

The cost of *not* writing this down was already being paid: five epics, three of
which independently assume an identity primitive, one of which would build a
parallel one, and one whose done-state silently rewrites the security contract.

## 1. Landed attribution; single-operator membership remains implicit

The production request resolver now attributes each request/session as one of:

- a verified identity, with the stable `human:<provider>:<subject>`
  `PrincipalRef` id; paired devices without a person binding may receive
  per-device attribution, which does not prove independent human membership;
- the contract-defined `human:local:operator`, but only after verifying the
  personal-mode home-possession or operator-credential authority fact; or
- a bound hosted tenant principal when no human identity is present.

Task-room request authority consumes that resolved `PrincipalRef.id` and fails
closed if resolution was unavailable. This is attribution, not membership or a
capability grant: it does not deliver independent-human roles, invitations, or
shared authorization.

The local product's membership model remains one implicit operator, not a row
in a member table — the following facts still describe that local authority:

- `verifyOperatorCredential` — `src-server/services/ssh/environment-security-service.ts:330-342`
- the local-grant secret: possession of an owner-only file in the Station home
  *is* the authority (`runtime-routes.ts`, the `local-grant` route)
- `TenantExecutionContext.source: 'request' | 'session' | 'operator'` —
  `packages/contracts/src/tenancy.ts:29-33`

`/api/users` and `/api/auth` are **cosmetic**: `routes/system/auth.ts:22-28`
falls back to `os.userInfo().username`. They are display, not principals. Do not
mistake them for an identity system that needs replacing — replacing them early
manufactures a user model with exactly one user in it.

Device-pairing grants remain scoped to a **device**
(`PairedDevice`, `packages/contracts/src/environment-security.ts:395-418`);
they are not a person-membership registry.

## 2. "People" is three problems, not one

| | Problem | What it needs | Issues |
| --- | --- | --- | --- |
| **(a)** | **One principal, many positions** — devices, browsers, the phone, and whole machines in a fleet | Capability tokens + attribution metadata. **Zero auth.** | #741, #1878, #1730, #1212, `access:approve` |
| **(b)** | **Many principals, one surface** — a shared workspace with members | Person identity, membership, per-person audit | #1392 |
| **(c)** | **Many customers, hosted, billed** | (b)'s identity at the login/billing edge only | #1393, #1707 |

Two classifications that are easy to get wrong, and were:

- **#741 (personal fleet) is (a), not (b).** Every slice is one human whose
  positions happen to be entire machines. It needs no person model.
- **#1707 (hosted foundation) involves no humans at all.** Tenant isolation
  works off URL authority; it is boundary-between-customers plumbing and is
  correctly proceeding today without any identity model. The service account
  and storage administrator that can write its home are trusted infrastructure
  actors, not human principals or a membership model.

**Station remains a problem-(a) product for membership** until a trigger in §5
fires. The landed attribution seam gives those device, presence, delegation,
and Task-room actions stable principal references; it does not itself create
the shared-membership model in (b).

## 3. The four contradictions this resolves

Recorded because each will otherwise be rediscovered by whoever picks up an
epic.

**C1 — two authorities, no composition rule.** #1392 authorizes by *membership*
("is it in the room?"). The shipped model authorizes by *credential scope
subset* — one route→scope table (`src-server/security/pairing-route-scopes.ts`),
subset rule at `environment-security.ts:220-235`. Nobody owns the rule for how
they compose. **Resolution: #1859 owns the capability axis** and must be shaped
before #1392 builds anything, or every extension point ends up answering to two
authorities.

**C2 — "tenant" means two things.** The landed `TenantId` is a DNS-authority
deployment boundary with *zero people in it*, and its parsers reject extra keys
(`tenancy.ts:39,197-206`), so there is deliberately nowhere to put a person.
#1392's tenant is a community of members. **Resolution: three orthogonal axes,
never merged** — see §4.

**C3 — historical concern, resolved by station#2051.** This document once
treated the credential-less loopback floor as load-bearing for peer delegation
and the SSH installed base. Protected routes now require a bearer or
device-session credential regardless of direct loopback or SSH transport; only
the exact Station-internal token attestation is a separate process credential.
Any role-based access/OIDC work must build on that current boundary rather than
reintroducing implicit transport trust.

**C4 — three epics assume an identity primitive; the seam already exists.**
`identity.md` is **landed**: `VerifiedIdentity { provider, subject,
federatedVia }` with an ordered source list. #1392 and #1393 cite it; **#741
does not, and would plausibly build a parallel owner-id.** **Resolution: #741
slice 1's "stable user/account id" binds to `VerifiedIdentity.subject`. No new
primitive.**

## 4. The one-way doors — three rules

Everything else in this space is additive behind seams that already exist. These
three are not.

### R1 — Attribution not captured at a boundary is gone forever

This is the only item in the entire people space with **expiry cost**. #1878:
`source` and `requester` are in hand at pairing approval and discarded before
persistence, so every device paired before that is fixed is permanently
unattributable — `PairedDevice` carries only `id, name, scope, kind, createdAt,
lastUsedAt, revokedAt`, and `name` is client-self-declared.

**Rule:** an authority-bearing persisted act (approval, grant, revocation) is
stamped with the acting credential/device id and the provenance available at
that boundary, *at the time it happens*. A later person model can only be
layered over history that recorded which position acted.

### R2 — The scope string is a wire format, and must never carry identity

`parsePairingScope` returns `null` for the **whole string** on one unknown token
(`environment-security.ts:196-209`), so old peers refuse rather than degrade.
`DEFAULT_GRANT_PAIRING_SCOPE` is a frozen curated constant precisely because
vocabulary growth once silently re-widened live grants.

**Rule:** scopes are a *capability* vocabulary. A principal or role dimension,
when it arrives, is a **separate additive field** on the grant record — exactly
how `kind` was added (`environment-security.ts:406-414`). Adding a token is
inert *provided* it stays out of `DEFAULT_GRANT_PAIRING_SCOPE`. Enforced by
`PAIRING_SCOPE_GRANT_PATHS` (#1883): a token cannot compile without declaring
how a human obtains it.

### R3 — Tenant ≠ account ≠ member: three axes, three owners

| Axis | Means | Owner |
| --- | --- | --- |
| **Tenant** | deployment/customer boundary, keyed off request authority | `packages/contracts/src/tenancy.ts` |
| **Account** | a verified human identity | `docs/design/identity.md` |
| **Member** | a principal's authorized participation in one Project or room, further constrained by applicable organization policy | [#488](https://github.com/kontourai/station/issues/488) and [#162](https://github.com/kontourai/station/issues/162) |

**Rule:** `TenantId` must never be overloaded into a person id. Adding a
principal dimension later is a deliberate, versioned contract change — fine —
but only if nobody meanwhile treats these as the same axis.

### R4 — #1707 trusts the storage writer; it does not manufacture a principal

Hosted #1707's private-home boundary limits who can write the persisted store:
the Station service UID and the storage administrator that controls it are
trusted. If either makes a syntactically valid rewrite from configured tenant
alpha to configured tenant bravo, it changes the stored authority; that is
outside the request-isolation promise. A MAC over only a tenant column is not a
claimed safeguard, because the same writer can rewrite the corresponding
session/event/cursor state. Whole-store authenticated integrity with external
key authority is later storage work, not identity, membership, or a reason to
treat `TenantId` as a person ID.

## 5. Build authorization and enablement gates

### Historical trigger reasoning, superseded for sequencing

This record originally made a second human's shared member access the trigger
for #1859 capability shaping before #1392 membership. That sequencing is now
superseded: it is circular because safe member access depends on the authority
work it deferred.

### Current delivery boundary

- **Build authorization:** the owner-authorized shared-Project program permits
  prerequisite identity, grant, and membership-authority design,
  implementation, and proof before any second human receives shared access.
- **Enablement gate:** grant a second human shared member access only after
  those prerequisite gates are satisfied and an explicit access approval is
  made. This document does not claim that a second human already has access.
- A resolved `PrincipalRef` is attribution, not a membership grant or evidence
  that the enablement gate has been crossed.

The hosted identity trigger remains separate:

- **(c)'s identity work fires when BOTH:** the external Kontour token contract
  exists, **and** a hosted tenant not operated by us is real. Until then only
  #1707 continues, because it is isolation work that needs no principals.
  `identity.md:41-43` already forbids implementing `KontourAccountIdentitySource`
  ahead of that contract.

Until the enablement gate is crossed, the correct scope is the prerequisite
authority work above and **zero enabled shared membership**; attribution work
remains required by R1.

## 6. Remaining restrictions

These restrictions bound the authorized prerequisite work in §5:

- `KontourAccountIdentitySource` / OAuth / SSO — seam landed, upstream contract
  absent, `identity.md` forbids it
- Membership, roles, and invites — their prerequisite design and implementation
  are authorized by §5; enabling shared access still waits for the named gates
  and explicit access approval
- Replacing the cosmetic `os.userInfo()` alias — display-only; replacing it
  early manufactures a user model with one user
- Passkeys for pairing — `identity.md:47-74` already rejects them on RP-ID
  grounds
- User tables, DPoP, an OAuth server — #1098's recorded non-goals
- Anything added to `DEFAULT_GRANT_PAIRING_SCOPE` (R2)

Scoped membership data required by the authorized work is not a prohibited
generic identity platform. It must remain bounded by its Project/room authority
and must not silently widen a default grant.

## 7. Where the work lives

Rule: **if closing it requires merging code into Station, it lives in Station's
tracker; if closing it requires a portfolio or cross-repository decision, it
lives in the suite-level planning tracker.**

- **Station:** [authorization #162](https://github.com/kontourai/station/issues/162),
  [identity #437](https://github.com/kontourai/station/issues/437),
  [Projects #106](https://github.com/kontourai/station/issues/106),
  [fleet #593](https://github.com/kontourai/station/issues/593), and
  [membership #488](https://github.com/kontourai/station/issues/488) own the
  engineering contracts and their specific acceptance gates.
- **Suite-level planning:** commercial and provider decisions and the
  ordered delivery through the owning Station epics.
  Prerequisite identity and membership implementation may proceed before a
  second human is enabled; the old blanket trigger prohibition is superseded.
