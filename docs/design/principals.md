# Design: Principals — what "people" means in Station, and when it changes

> Status: **decision record**. No implementation. Written 2026-08-03 to
> reconcile five epics that had accumulated overlapping answers to "how do
> people work here" (#1392, #1393, #1707, #741, #1859) and to record the small
> number of decisions that are expensive to reverse.
>
> This document is the contract for the *principal* axis. The identity **seam**
> is a separate, already-landed contract — see
> [identity.md](identity.md), which owns how a request is attributed to a
> verified identity. This document owns what a principal *is* and when Station
> gains more than one.

## 0. Why this exists

The question that prompted it: *"do we need to start working on the auth
integrations, because I do think people will also be a thing here?"*

The honest answer is **no, not yet** — but the reason is not caution, and it is
not "later." It is that "people" names three different problems, Station is
living entirely inside the first one, and the five epics that address them were
filed months apart and now contradict each other in four concrete ways. Building
any one of them first, without this reconciliation, would make the others more
expensive.

The cost of *not* writing this down was already being paid: five epics, three of
which independently assume an identity primitive, one of which would build a
parallel one, and one whose done-state silently rewrites the security contract.

## 1. Station today has exactly one principal, and it is implicit

The operator. Not a row in a table — a set of facts that each mean "the one
human who owns this machine":

- `verifyOperatorCredential` — `src-server/services/ssh/environment-security-service.ts:330-342`
- the local-grant secret: possession of an owner-only file in the Station home
  *is* the authority (`runtime-routes.ts`, the `local-grant` route)
- `TenantExecutionContext.source: 'request' | 'session' | 'operator'` —
  `packages/contracts/src/tenancy.ts:29-33`

`/api/users` and `/api/auth` are **cosmetic**: `routes/system/auth.ts:22-28`
falls back to `os.userInfo().username`. They are display, not principals. Do not
mistake them for an identity system that needs replacing — replacing them early
manufactures a user model with exactly one user in it.

Every permission grant in Station binds to a **device**, not a person
(`PairedDevice`, `packages/contracts/src/environment-security.ts:395-418`).

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

**Station is a problem-(a) product** until a trigger in §5 fires. A
single-operator product with a phone generates device-attribution, presence, and
delegation problems — all (a).

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
| **Member** | an account's standing within a tenant | #1859's future capability model |

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

## 5. Triggers — when this document changes

Written as observable events, so the decision is not a judgement call under
pressure later.

- **(b) fires when a second real human is granted access to any Station** — a
  design partner, a collaborator. At that point **#1859's capability shaping
  starts, before #1392's membership** (per C1). Not "when we think about
  collaboration"; when a second person actually has access.
- **(c)'s identity work fires when BOTH:** the external Kontour token contract
  exists, **and** a hosted tenant not operated by us is real. Until then only
  #1707 continues, because it is isolation work that needs no principals.
  `identity.md:41-43` already forbids implementing `KontourAccountIdentitySource`
  ahead of that contract.

Until a trigger fires, the correct amount of auth work is **zero**, and the
correct amount of attribution work is **all of it** (R1).

## 6. Do not build yet

Recorded so the temptation is answered once rather than re-litigated:

- `KontourAccountIdentitySource` / OAuth / SSO — seam landed, upstream contract
  absent, `identity.md` forbids it
- Membership, roles, invites — #1707's own contract defers it
- Replacing the cosmetic `os.userInfo()` alias — display-only; replacing it
  early manufactures a user model with one user
- Passkeys for pairing — `identity.md:47-74` already rejects them on RP-ID
  grounds
- User tables, DPoP, an OAuth server — #1098's recorded non-goals
- Anything added to `DEFAULT_GRANT_PAIRING_SCOPE` (R2)

## 7. Where the work lives

Rule: **if closing it requires merging code into Station, it lives in Station's
tracker; if closing it requires a portfolio or cross-repository decision, it
lives in the suite-level planning tracker.**

- **station:** #1859, #1707, #1425, #741, #1878, #1730, #1212, and #1392's
  mechanics — engineering contracts.
- **Suite-level planning:** the commercial half of #1393 (tiers, pricing, hosted-vs-enterprise,
  whitelabel), and the **trigger register** for §5 — demand-evidence watching,
  the same pattern the S5 extraction framework already runs. The station epics
  carry one line each: "blocked on trigger, see ops."
