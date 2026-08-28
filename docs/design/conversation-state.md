# Design: conversation state — channel-home logs, signed proposals, per-noun consistency

> Status: **draft for owner review (2026-08-01); tracking issue
> [#1484](https://github.com/kontourai/station/issues/1484).** The complete
> brief is the 2026-08-01 comment thread on
> [#1392](https://github.com/kontourai/station/issues/1392): the owner-shaped
> product model, the availability model and its owner correction, the
> hosted-tier relationship, and an **independent adversarial review (external
> engine) whose verdict was UPHOLD-WITH-AMENDMENTS**. This doc turns that
> thread into a contract. Twelve open questions are open — see §11, each with
> a recommendation.
>
> **The review's amendments are requirements in this doc, not an appendix.**
> Two of them are corrections that invalidate a construction recorded earlier
> in the thread (epoch-only fencing; home-authored chains as evidence), and
> they are carried in §3 as the design rather than as a footnote to it. Where
> this doc and an earlier #1392 comment disagree, this doc follows the review.
>
> **Nothing here is scheduled yet.** Implementation is sequenced *after* the
> Flow 3 arc and the fleet arc per the recorded priority order (§12). The doc
> is commissioned early because it is cheap and because #1423 (share
> permalinks) is the read-only degenerate case of this design and should not
> be built in a shape this design would have to undo.
>
> Every claim about current behavior carries file:line evidence; §13 lists
> what is UNVERIFIED. Refs #1392 (the brief; the multi-tenant tier), #1425
> (contribution/backing vocabulary — **a draft pending owner approval**,
> §9.2), #1423 (permalinks), #1398 /
> [inference-fleet](inference-fleet.md) (contribution pattern, receipt
> discipline, the "receipted, not signed" finding), #1410 (turn provenance
> envelope), #741 (personal fleet), #1123 (peer pairing).

## 0. Naming, sources, and one repo-policy note

This repo does not name competitors (`AGENTS.md:21`; precedent
`docs/design/settings-architecture.md:3-5`). The system #1392 studied is called
**"the reference implementation"** throughout this doc. It is the same codebase
[inference-fleet.md](inference-fleet.md) calls "the reference mesh"; its product
name, repo, and file:line evidence live in #1392's and #1398's comments and in
the private ops workspace analysis. Nothing here depends on reading them.

Two readings of that implementation are load-bearing, and both are code
readings rather than marketing readings:

- **Its conversation truth is centralized.** Despite the mesh branding, message
  state is one signed, append-only event log per community with
  server-authoritative fan-out — no gossip, no replication, thin clients. Its
  hardest-won properties (fail-closed tenancy, membership-gated delivery,
  instant moderation, threaded pagination) all depend on that centralization.
- **Its fencing is generation-based**, the same shape as this repo's own
  mutation-lock pattern — which is exactly the construction the adversarial
  review says is insufficient on its own (§3.4).

**Survivorship caveat, recorded because the review insisted on it.** "The
reference implementation does X and works" is evidence that X is *survivable*,
not that X is *correct*. We see the systems that shipped, not the ones whose
centralized authority became a liability and died quietly. Every argument in
this doc that leans on that implementation is marked, and none of them are load
-bearing alone.

## 1. Problem, and the decided architecture

### 1.1 The question

Station today is a single-operator runtime (§2.6). #1392 asks it to host shared
spaces: a project or channel where several people — and several people's agents
— read and write the same conversation, with membership, moderation, threads,
and provenance. The design question the owner posed is the load-bearing one:
**how is message/thread state shared? A mesh database?**

### 1.2 The answer

**No CRDT or mesh replication for conversation state.** Each channel has ONE
authority that holds a committed, hash-chained log of messages, membership,
moderation, and agent actions, and evaluates policy at delivery time. Members
read from local caches and queue writes as proposals; there are no merge
semantics for these nouns.

The reason is not "logs are neat." It is that the three properties this product
must have — *membership-now* delivery gating, *instant* revocation, and *instant*
moderation — are all evaluations against current policy at the moment of
delivery. A replicated multi-writer store makes each of them eventual at best:
a revoked member's writes merge everywhere during a partition, and a deletion
propagates as a suggestion. An authority that evaluates policy at commit time is
the only construction where "removed" means removed at a defined instant.

Distribution stays where this repo already puts it: **compute** (fleet routing,
#1398), **artifacts** (content-addressed provenance), and **tasks**
(delegation). Conversation state is deliberately the exception.

### 1.3 The refinement that makes it sovereign

Single-authority is not the same as centralized-on-a-vendor. Each channel has
ONE **home** — a member's Station, or the hosted tier for members who bring
nothing — and because the log is signed and chained, a channel can move homes
verifiably by copying the log. Single authority per channel, federated across
channels, sovereign because any Station can be a home. A solo Station is
trivially the home of its own spaces, so the local-only experience is untouched
(§4.4).

### 1.4 The two CRITICAL corrections, stated up front

The adversarial review upheld §1.2 and rejected two constructions the thread had
already recorded. Both are corrections of the *trust* model, not the *topology*
model, and both are carried as design in §3.

1. **Epochs alone do not fence.** A monotonically increasing epoch number is a
   *labeling*, not a mutual exclusion. A partitioned-but-alive old home keeps
   committing for the members who can still reach it, and both sides believe
   they are the single writer — optimistic dual-primary wearing a single-writer
   name. **Adopted:** hosted/witnessed spaces use a linearizable lease service
   as the promotion arbiter; **peer-only spaces freeze rather than
   auto-promote**; witness-less recovery is an explicit, labeled fork decision
   and is never described as lossless failover. And the channel's authority
   metadata (home, lease, epoch) lives in **its own construct, not in the
   portable project manifest**, which stays an identity/reference object
   (§3.3, §9.2).
2. **A home-authored chain is not evidence against the home.** If the authority
   both authors every record and computes the chain over its own records, the
   chain proves only that the authority is internally consistent with the
   version of history it is currently showing you. **Adopted:** signed member
   and agent **proposals** (so the authority cannot manufacture a member's
   words), authority-signed **sequencing envelopes** (so ordering is
   attributable), signed **checkpoints** exchanged opportunistically between
   members with an **equivocation-proof** format, and **inclusion commitments**
   so censorship is detectable rather than merely deniable (§3.2, §3.5).

### 1.5 What this design does not claim

The review's honest-costs list (§10) is part of the contract. In particular:
transparency machinery **exposes** a misbehaving authority; it does not
**force** it to behave. Every mechanism in §3.5 makes equivocation and
censorship *provable*, and none of them make a channel available when its home
decides not to serve it.

## 2. Current state, verified

Read this before proposing anything. Several plausible designs are already
foreclosed, and one whole category of work that reads like "integration" is
actually new invention.

### 2.1 There is a real append-only, sequence-numbered log — for one machine's own runs

The orchestration event store is SQLite over Node's built-in `node:sqlite`
`DatabaseSync` (`src-server/services/orchestration/event-store.ts:32-45`); there
is no `better-sqlite3` dependency. Its schema
(`src-server/domain/migrations/003-orchestration-events.ts:14-29`) is
`orchestration_events (id, provider, thread_id, turn_id, method, payload,
created_at, sequence, global_sequence)` with indexes on `(thread_id, sequence)`
and on `method`; the database is at `<projectHomeDir>/data/orchestration.sqlite`
(`:144-146`).

Two sequence axes already exist, and their docblock states the invariant this
design needs at channel scope:
`sequence` is "Monotonic within `threadId` only" and `globalSequence` is
"Monotonic across every thread"
(`src-server/services/orchestration/event-store.ts:47-66`). Assignment is
`COALESCE(MAX(...), 0) + 1` inside the single writer process (`:1129-1134`,
`:1149-1153`). **Ordering is by sequence, not by timestamp** — `listEvents`
is `ORDER BY sequence ASC` (`:288`).

**Design consequence: the per-channel committed log is the same shape Station
already operates, with the thread axis replaced by a channel axis and the
implicit single writer made explicit.** That is a genuine head start, and §2.2
is where it stops.

### 2.2 There is no message record, no membership, and no moderation

- Chat messages are a **projection**, not a table. `projectRuntimeEventsToMessages`
  (`packages/shared/src/runtime-event-projection.ts`) folds events into
  `ConversationMessage { id, role, parts, metadata }`
  (`packages/shared/src/conversation-message.ts:24-52`) — which carries **no
  sequence, no parent id, and no thread id**.
- The legacy Station-engine chat memory is NDJSON files appended in file order
  with a `Date.now()` stamp as the only time field
  (`src-server/adapters/file/memory-adapter-paths.ts:16-28`,
  `src-server/adapters/file/memory-adapter-messages.ts:63-67`). Ordering is
  append order.
- Membership, moderation, participants, and tenancy **do not exist**. The three
  in-repo mentions are all forward-looking comments: the runtime sets
  `ownerlessSessionAccess: 'single-user-compat'` with the note that "Station
  currently exposes one local account ... a multi-user runtime must migrate them
  and switch this to `deny`"
  (`src-server/runtime/bootstrap/runtime-initialize.ts:354-357`); the
  orchestration service repeats it (`:410`); and the UI's owner attribution
  helper says "a single Station instance has one operator"
  (`src-ui/src/utils/ownerAttribution.ts:1-19`).
- Authorization is single-owner-per-session, not membership:
  `canReadSession` is `ownerUserId === userId`, with ownerless rows readable
  only under the compatibility mode
  (`src-server/services/orchestration/orchestration-service.ts:1655-1661`).

**Design consequence: "add membership to the existing store" is not a
refactor.** There is no member noun to extend. Everything in §3 that is not the
log substrate is new.

### 2.3 Nothing in this repo signs anything

This is the single most important current-state finding for this design.

A repo-wide sweep for `ed25519`, `createSign`, `createVerify`,
`generateKeyPair`, `sigstore`, and `jsonwebtoken` across `packages/`,
`src-server/`, and `src-shared/` matches exactly one file, and it is a test
helper (`src-server/services/__tests__/helpers/hermetic-openssh.ts`). Everything
else is SHA-256 content digests.

The fleet arc met this and made the honest choice. `receipt-chain.ts`'s header
states it in the source:

> **"Receipted", not "signed" (§10 OQ-3).** Nothing in the building-block layer
> signs anything ... `receiptId` is the digest of the record's own canonicalized
> content, `previousReceiptId` links it to the one before, and `signature` stays
> `null`.

(`src-server/runtime/conversation/receipt-chain.ts:12-17`.) `signature: null`
is a reserved field on both shipped receipt shapes
(`packages/contracts/src/fleet-routing-receipt.ts:465-469`, `:538`).

**Conversation state cannot make the same choice.** The fleet's threat model is
one owner's own machines, where a content digest is enough. This design's threat
model explicitly includes a *malicious or compromised home*, and §1.4's
correction 2 is unimplementable with digests alone: a digest chain authored
entirely by the party you are checking proves nothing about that party. **So
this arc is the one that has to introduce real signing, with key identity and a
revocation path** — new work in this repo, sized as such in §12 and carried as
OQ-5.

What *is* reusable is the discipline and the substrate around the signature:
`ChainedReceipt { receiptId, previousReceiptId }` (`receipt-chain.ts:46-49`),
the three-state `ReceiptChainStatus = 'intact' | 'broken' | 'unknown'` with the
comment "because 'we did not check' must never render as 'it verified'" (`:64`),
`computeChainedReceiptId` over `canonicalizeForDigest` (`:73-79`;
`packages/contracts/src/fleet-routing-receipt.ts:105-116`), and — the part most
likely to be skipped — the **head anchor** that catches tail truncation, which
a backward-linked chain alone cannot see (`receipt-chain.ts:19-28`, `:91-114`).
A channel log needs all four, plus signatures.

### 2.4 Pagination exists, in exactly the shape this design needs, for one noun

`GET /api/orchestration/sessions/:threadId/event-page`
(`src-server/routes/orchestration/orchestration.ts:752-777`) takes
`afterSequence` (int >= 0, default 0) and `limit` (1..100, default 50)
(`:210-213`), and the store query is
`WHERE thread_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`
(`src-server/services/orchestration/event-store.ts:318-322`), returning
`{ events, hasMore, nextSequence }` (`:67-71`).

The SSE stream has a second, cross-thread cursor: `Last-Event-ID` parsed as a
`global_sequence` integer, with a documented fallback to a snapshot when it is
not parseable (`orchestration.ts:275-289`; replay at `event-store.ts:385-400`).

**Design consequence: §8's cursor is this cursor plus an epoch and a checkpoint
binding.** Note also what is *not* paginated: the chat conversation routes
return whole arrays (`src-server/routes/chat/conversations.ts:143`, `:274`), as
does `GET /sessions/:threadId/events` (`orchestration.ts:741`). A shared channel
cannot use those shapes.

### 2.5 Fan-out is in-process only, twice

Two independent mechanisms, neither of which crosses a process boundary:
`EventBus` is a `Set<Listener>` iterated synchronously
(`src-server/services/orchestration/event-bus.ts:15-38`), and `SSEBroadcaster`
is a `Set` of writers used by the scheduler
(`src-server/services/infra/sse-broadcaster.ts:7-26`). Presence is SSE
connection counting for push suppression, explicitly "in-memory/process-local ...
there is exactly one Station server process per instance"
(`src-server/services/orchestration/orchestration-stream-presence.ts:1-19`).

**Design consequence: the personal-Station implementation of the channel-home
contract needs no new fan-out at all** — one process, one writer, one bus. The
hosted tier needs cross-node fan-out, and that difference is confined to the
fan-out seam (§3.6). Durable replay is what makes reconnect correct today
(`event-store.ts:372-412`), not the bus, and that stays true.

### 2.6 There is no CRDT anywhere, and no collaborative document surface

No `yjs`, `automerge`, `loro`, or `crdt` dependency in the root or any package
manifest; no collaborative canvas or document view. All current conflict
handling is last-write-wins on a file or a SQLite row.

**Design consequence: §6's CRDT row is a future dependency and a future arc, not
an existing asset to point at.** It is correctly scoped to canvases and
documents, and nothing in §3 depends on it.

### 2.7 What exists for identity, and what it is not

- `VerifiedIdentity { provider: 'tailscale-serve' | 'kontour-account' | 'device',
  subject, displayName, federatedVia? }`
  (`src-server/services/identity/identity-source.ts:19-27`) — only
  `tailscale-serve` is implemented; `kontour-account` is reserved and unused
  (`:26`).
- Machine-to-machine pairing is real and scoped: five closed pairing scopes with
  presets (`packages/contracts/src/environment-security.ts:41-64`, `:153`),
  outbound peer credentials (`src-server/services/peers/peer-credential-store.ts:63-72`),
  and a route-to-scope coverage guard (`src-server/security/pairing-route-scopes.ts`).

**Design consequence: Station has machine identity and no member identity.** A
channel's signing keys (OQ-5) attach to devices and members, which is a
different axis from the pairing credential, and conflating them would make
"revoke this laptop's pairing" silently mean "invalidate everything that laptop
ever said."

### 2.8 The shipped fleet contribution contract is the vocabulary to reuse

`station.fleet-contribution/v1`
(`packages/contracts/src/fleet-contribution.ts:49-50`) already encodes four
decisions this design adopts verbatim (§9.3): fail-closed allowlist opt-in
(`:66-80`, `:261-265`); four-state participation
`contributing | disabled | nothing-contributed | contributed-unavailable` where
the empty array is never the signal (`:90-105`); two separable clocks
`projectedAt` vs `sourceObservedAt` (`:229-255`); and **no self-asserted
identity in the body** — a manifest is attributed by the consumer to the
environment it authenticated to.

### 2.9 #1410's provenance envelope is a projection, and that is a problem at channel scope

`TurnProvenanceEnvelope` (`packages/contracts/src/turn-provenance.ts:278-296`)
carries `envelopeVersion`, session/turn ids, engine, requested and reported
model, tools, usage, and refs to a routing receipt, sources, and a trust report,
with a slot algebra of `observed` / `referenced` / `unavailable` and four
distinct unavailable reasons (`:56-107`). It is assembled by
`packages/shared/src/turn-provenance-fold.ts` and folded into messages at
`packages/shared/src/runtime-event-projection.ts:59-60`, rendered by
`src-ui/src/components/chat/TurnProvenanceCard.tsx:221-231`.

Its own docblock is explicit: "The envelope is a **projection**, not a second
store (#1410 R5): it is re-derived from the durable orchestration event stream
on every read" (`turn-provenance.ts:36-40`).

**Design consequence, and it is a real finding: a projection re-derived from a
local event stream is not re-derivable by another member.** In a shared channel,
either the envelope's inputs are committed to the channel log, or the envelope
becomes a `referenced` slot pointing at the authoring Station. §9.4 takes that
decision.

### 2.10 #1423 permalinks — the sweep, and its correction

**This section as originally written is now false, and is corrected here rather
than absorbed** (station#1598). It read: *"A sweep for `permalink`, `shareLink`,
`share_token`, and sharing routes returns zero implementation hits. There is no
share route, no share contract, and no share token on `origin/main`. Design
consequence: #1423 is unconstrained by existing code and should be built as the
read-only degenerate case of §3's addressing."*

That was true when the sweep was run and stopped being true when #1423 shipped.
On `origin/main` today there is a share contract
(`packages/contracts/src/answer-share.ts`), a public view route
(`/.well-known/station/v1/share/view`), an operator management family
(`/api/shares`), a token store, and a viewer page. **#1423 was therefore not
unconstrained**, and the correction matters because the conclusion drawn from
the sweep — that #1423 could adopt §3's addressing wholesale — is the half of
§9.1 that had to be withdrawn.

**Design consequence, restated: #1423 exists, and channel addressing joins it
additively rather than replacing its lookup key.** See §9.1 for the resolved
contract.

## 3. The channel-home contract

One contract, two implementations (§3.6). Everything in this section is the
contract; nothing in it is implementation-specific unless it says so.

### 3.1 In one paragraph

A **channel** has exactly one **home** at a time: a Station (a member's, or the
hosted tier's) that holds the channel's committed log and is the only party
permitted to sequence writes into it. Members and agents author **signed
proposals**; the home evaluates policy against membership-and-moderation-now and
either commits the proposal inside a **signed sequencing envelope** at
`(epoch, seq)` or refuses it with a named reason. The home periodically emits
**signed checkpoints** over the log head; members exchange checkpoints
opportunistically, and two conflicting checkpoints for one `(channel, epoch,
seq)` are a self-contained **equivocation proof**. The home's right to sequence
is a **lease** on an epoch, not merely a high epoch number. Members hold verified
partial or full **copies**; a copy can become the home through witnessed
handover, or — with no witness — the channel **freezes** until its home returns.

### 3.2 The log: three record kinds

**Proposal** (`station.channel-proposal/v1`) — authored and signed by a member
device or by an agent:

| Field | Meaning |
|---|---|
| `proposalId` | Stable, client-generated. The **idempotency key** for the whole system (§5). |
| `channelId` | Which channel this is for. |
| `author` | `{ memberId, deviceId, keyId }` — the key that signed it. |
| `onBehalfOf` | Agent proposals only: `{ ownerMemberId, authorizationId }` (§3.7). |
| `kind` | `message` / `edit` / `reaction` / `membership-change` / `moderation` / `agent-action`. |
| `parent` | **Parent identity, never parent position** — a `proposalId` or a committed message id, never a sequence number. |
| `baseEpoch` | The epoch the author believed was current when authoring. |
| `baseCheckpoint` | Optional digest of the newest checkpoint the author had verified. |
| `happenedAt` | The author's clock. **Untrusted, and labeled as such everywhere.** |
| `body` / `bodyRef` | Inline content, or a content-addressed ref (§6). |
| `signature` | Over the canonicalized proposal. |

**Sequencing envelope** (`station.channel-sequence/v1`) — authored and signed by
the home, embedding the proposal **verbatim**:

| Field | Meaning |
|---|---|
| `channelId`, `epoch`, `seq` | The commit coordinate. |
| `proposal` | The member's signed proposal, byte-identical, so its signature stays checkable. |
| `proposalDigest` | Digest of the embedded proposal. |
| `committedAt` | The **home's** clock. This is the ordering clock; `happenedAt` never is. |
| `prevEnvelopeDigest` | The hash chain link. |
| `policyRevision` | The membership/moderation revision evaluated at commit time. |
| `leaseRef` | The lease under which this epoch is being sequenced (§3.4). |
| `signature` | The home's epoch signing key. |

Embedding the proposal verbatim rather than restating its fields is the same
decision the fleet made for its routing envelope: it "keeps the boundary
intact ... and the embedded receipt stays byte-identical so its digests remain
checkable" ([inference-fleet.md](inference-fleet.md) §3.4). Here it does more
work — it is what makes a member's words unforgeable by the home.

**Checkpoint** (`station.channel-checkpoint/v1`) — periodic, signed by the home:
`{ channelId, epoch, seq, headEnvelopeDigest, logDigest, policyRevision,
observedAt, signature }`.

**Refusals are not committed.** A refused proposal returns a signed refusal
receipt to its author naming `proposalId`, a reason code, and the policy
revision — and is **not** inserted into the sequence. Committing refusals would
let any member write into everyone else's history by proposing garbage. The
refusal is signed so a censoring home's refusals are at least attributable, and
the author's draft is preserved locally with the named reason (§5).

### 3.3 The channel-home record is its own construct

`station.channel-home/v1`: `{ channelId, epoch, homeRef, leaseRef,
leaseExpiresAt, witnessRef, policyRevision, previousEpochCloseCheckpoint }`.

**This does not live in the portable project manifest** (§1.4 correction 1). The
manifest is an identity/reference object — stable, shareable, and boring; the
channel-home record is operational state that changes on every handover and
carries an expiry. Putting a leased, expiring, frequently-rewritten field inside
a portable identity document would make the identity document unstable, and would
make "who may write" a property that travels in a file anyone can copy. The
manifest carries at most a channel id and a locator hint; authority is resolved
from the home record, which is served by the authority (and by the witness, when
there is one) and cached by members with its own freshness (OQ-12).

### 3.4 The lease is the fence; the epoch is only the label

**The correction, stated as mechanism.** A lease is a grant from a
**linearizable** arbiter: `(channelId) -> (epoch, holder, expiry)`, mutated only
by compare-and-set. A home may sign envelopes for epoch E only while it holds an
unexpired lease for E, and **clients verify the lease, not the epoch number**.
A partitioned old home cannot renew, so its lease expires and its subsequent
envelopes are invalid by construction rather than by comparison — which is the
property an epoch counter alone does not provide.

Three regimes, and the product must never blur them:

| Regime | Arbiter | Behavior when the home is unreachable |
|---|---|---|
| **Witnessed** (hosted, or any channel with a configured witness) | A linearizable lease service | Lease expires; a successor named by a promotion certificate takes epoch+1; reads continue from copies throughout |
| **Peer-only** (no witness) | None | **Freeze.** Reads serve from caches with honest staleness; writes queue as proposals; **no automatic promotion, ever** |
| **Witness-less recovery** | The owner, explicitly | A **labeled fork** at a named divergence point — never called failover, never called lossless |

**Promotion certificate.** A successor is not merely "some copy that is up to
date." It presents a certificate binding: the channel, the source epoch, the
eligible identity, an expiry, the **minimum replicated checkpoint** it must have
reached, the policy revision, and an explicit **loss-allowed flag**. The
loss-allowed flag is the honest field: promoting a copy that is behind the old
home's committed head *loses committed messages*, and a system that can do that
silently is lying about durability. When it is set, the fork label (below) is
mandatory.

**Labeled fork.** When there is no witness and the owner chooses recovery
anyway, the new home starts at epoch+1 with a `forkedFrom { epoch, seq,
checkpointDigest }` record committed as its first entry. Every member's client
renders the channel as recovered-with-a-divergence-point, naming the last
message that survived. The product word is not "fork" (§4.1); the product
sentence is *"this channel was recovered from a copy. Messages after <time>
were not recovered."*

**The lease service is the only linearizable component in the whole design.**
Keeping it that small is deliberate: it is a compare-and-set on one row per
channel, it is not on the message path, and its unavailability degrades
handover, not conversation (OQ-11).

### 3.5 What makes a malicious home detectable

Four mechanisms, each answering a specific attack. None of them prevent the
attack; all of them make it provable.

1. **Signed proposals** — the home cannot manufacture a member's message,
   because it cannot produce that member's signature. The strongest single
   property here, and the reason §2.3's signing work is not optional.
2. **Signed sequencing envelopes** — the home cannot deny having ordered
   something the way it did, and a member can show a third party an envelope the
   home signed.
3. **Signed checkpoints + opportunistic exchange -> equivocation proofs** — the
   attack signing alone does not cover is *showing different histories to
   different members*. Two checkpoints signed by the same home for the same
   `(channel, epoch, seq)` with different `headEnvelopeDigest` are a
   self-contained, third-party-verifiable proof of equivocation: no context, no
   trusted observer, no log access needed to check it. Exchange is opportunistic
   — every read response carries the current checkpoint, and clients compare
   what they have seen (OQ-9). This is the mechanism that turns "trust the home"
   into "the home is trusted only until the first member compares notes."
4. **Inclusion commitments** — on accepting a proposal, the home returns a signed
   commitment that `proposalId` will appear at or before `seq S` under epoch E,
   or by time T. A checkpoint past that bound that does not include it, held
   alongside the commitment, is evidence of censorship.

**Two honest limits on #4.** Proving *non*-inclusion requires the complaining
member to hold the log segment between the commitment and the checkpoint, so
detection is strong for members who stay reasonably current and weak for members
who were away. And detection is not availability: a home that refuses to accept
the proposal at all issues no commitment, which is visible as a refusal, and a
home that simply stops answering is unavailable — a case §3.4 handles as
freeze-or-handover, not as fraud.

### 3.6 Two implementations of one contract

| | Personal Station | Hosted tier |
|---|---|---|
| Store | `node:sqlite`, one file, one process (§2.1) | Multi-tenant, tenant-keyed, Postgres/Redis class |
| Writer exclusivity | The process **is** the writer; a transaction assigns `seq` | The node holding the channel's lease is the writer |
| Routing | None needed | Shard by channel; sticky routing to the lease-holding node |
| Fan-out | The existing in-process bus (§2.5) | Cross-node pub/sub to SSE-holding nodes |
| Rebalancing | N/A | The same lease handover, between the tier's own nodes |
| Scale target | 2-50 members per channel | The tier's own limits |

**Single-writer-per-channel is why the hosted tier scales cleanly**, not a
constraint it works around: sharding by channel means no cross-node write
coordination and no consensus on the message path. The tier's existence proof is
the reference implementation's production shape (host-resolved tenant, shared
datastore, one relay authority per community) — with §0's survivorship caveat
attached.

**The contract-neutrality is the sovereignty proof.** Moving a channel to the
hosted tier is a *promotion* within one contract, and moving it back is the
identical operation in reverse. A product where "leaving" is a different,
lossier, later-built code path than "joining" has not actually promised
sovereignty. This is also why the personal implementation must ship first
(§12): it is the thing the hosted tier has to stay compatible with.

Note the deliberate non-goal: today's `station-control` is one process with
SQLite and in-memory presence (§2.5) and **stays that way**. Scaling lives only
in the hosted tier.

### 3.7 Agents are writers, with owner attribution

An agent's proposal carries `onBehalfOf { ownerMemberId, authorizationId }` and
is signed by the agent's own key, not the owner's. The **authorization itself is
a committed log record**, so three properties hold that a per-proposal claim
could not give:

- Every member can evaluate, from the log alone, whether an agent action was
  authorized **at the moment it was committed** — not whether it is authorized
  now.
- Revocation is a log fact with a commit coordinate, so "when did this agent stop
  being allowed to post" has an answer.
- An agent that outlives its owner's membership stops being able to commit at a
  defined instant, rather than at whatever moment a cache refreshes.

This is the channel-scoped shape of #1392's owner attestation and the natural
consumer of `OwnerAttribution` (`src-ui/src/utils/ownerAttribution.ts:15-19`),
whose own comment already anticipates it. §5.3 covers the operational half
(quotas, idempotency, coalescing).

### 3.8 Durability levels

Four levels, named on the wire and surfaced in product language (§4.2):

| Level | Means | Failure that loses it |
|---|---|---|
| `pending-local` | The signed proposal exists only on the author's device | Losing the device |
| `committed-home` | Sequenced and durable at the home | Losing the home's storage |
| `replicated-copy` | Present in at least one verified copy at a named checkpoint | Losing home and that copy |
| `checkpoint-witnessed` | Covered by a checkpoint a witness or another member has acknowledged | Losing home, copy, and every acknowledger |

**Senders retain the signed proposal until the required level is reached.** That
is what makes a home crash between accept and commit recoverable: the author can
re-propose the identical `proposalId` and the system deduplicates (§5.2).

**The sync-vs-async tradeoff, stated rather than defaulted.** Acknowledging only
after `replicated-copy` means every message pays a round trip to a second
machine — and when the copy is a laptop that sleeps, that is a chat that
intermittently stops working. Acknowledging at `committed-home` means the tail
between the last replication and a home loss is lost. **Recommendation (OQ-4):
acknowledge at `committed-home`, display `replicated-copy` as a distinct
quieter state, and make synchronous copy a per-channel policy that is off by
default.** What is not acceptable is showing one checkmark that means either.

## 4. The product surface

### 4.1 Vocabulary: what reaches a screen

| Design word | Product word | Rule |
|---|---|---|
| home / primary | **lives** — "this channel lives on My Station" | The creation question is "Where does this channel live?" |
| standby / replica | **copy** — "your copy", "a copy on Kontour Cloud" | Always possessive or located; never "replica" |
| migration / promotion / failover | **move** — "Move this channel to my Station" | One verb for every direction |
| epoch / lease / sequence | *(nothing)* | Never rendered, not even in advanced settings |
| labeled fork | **"recovered from a copy"** + the divergence point | Never "fork", never "lossless" |
| freeze | **"read-only until <home> is back"** | Names the home and the last message |

**Primary, standby, failover, promotion, epoch, lease, and quorum are
design-doc words only.** A user has three verbs: a channel *lives* somewhere,
keeps *copies* elsewhere, and can *move*.

### 4.2 The two copy stories

One mechanism (a verified copy plus fenced handover), two product stories that
differ by direction:

- **Hosted-homed -> "your copy."** The channel owner's Station keeps a
  continuous chain-verified copy automatically. This is the sovereignty
  guarantee made physical: readable when the hosted tier is unreachable, and
  "Move back to my Station" is one click because the copy is already current.
  The exit door is pre-built rather than promised.
- **Self-homed -> "coverage."** An optional backup on Kontour Cloud or a second
  Station, with a plain-language pre-consent: *"if my Station is offline for
  more than [N], Kontour hosts this channel until it's back."* The consent text
  is the setting; there is no separate policy object the user is asked to
  understand.

Message state in the composer, mapping §3.8 without exposing it: *Sending* ->
*Saved* -> *Copied to your Station*. "Not yet copied to your Station" is a named,
visible state — the same rule as the fleet's honest degraded states
([inference-fleet.md](inference-fleet.md) §4.5): never a silent omission, never a
default that decides.

### 4.3 Custody disclosure

**A copy is custody, and must be disclosed as custody.** The Station holding a
copy of a channel can read every message in it. That is obvious for the home and
easy to forget for the copy — which is exactly why the review made it an
amendment.

Two disclosures are mandatory, both at join time and both re-findable in channel
info:

1. **Who holds this channel.** "This channel lives on Kontour Cloud. Alex's
   Station keeps a copy." Not a settings sub-page: a member is trusting two
   custodians and must be told at the moment they decide to join.
2. **What a promotion right is.** A copy with a pre-consented promotion policy
   holds a conditional right to become the home. That is a governance fact about
   the channel, not an implementation detail, and it belongs in the same
   disclosure.

Corollary from the #1392 thread that survives review: **ownership is not
homing.** Owned by members and admins is a governance fact in the log; homed on a
Station is an operational fact. **Moving a channel — including to the hosted tier
— moves homing and never moves ownership.** Custody disclosure is how a member
can see that the two are separate rather than having to trust that they are.

### 4.4 Join-time onboarding, and the local-only invariant

> **The local-only experience must not degrade.** A single-user, single-machine
> Station shows no member list, no home picker, no copy settings, no
> contribution question, and no custody disclosure. It shows projects and chats,
> exactly as today.

This is constitution non-negotiable #5 (*Local-first, user owns their data*,
`docs/strategy/constitution.md`) applied to vocabulary as well as to data, and it
is the same invariant the portable-project draft states from the project side.
The zero-config first-run journey is pinned by a named regression test
(`tests/first-run-live.spec.ts`, bucketed in `tests/e2e-manifest.mjs`): **if a
slice in this arc makes first-run ask about members, homes, or copies, the slice
is wrong.**

Every concept in §4 appears for the first time at the moment a user creates or
joins a shared space. Creating one asks exactly one question ("Where does this
channel live?"); joining one shows exactly one disclosure (§4.3). Everything else
is progressive.

## 5. Queued writes are proposals, not events

### 5.1 The distinction, and why it is the whole design

An **event** is something that happened and must be recorded. A **proposal** is
something a member asked for, which the authority may accept or refuse. Offline
writes are proposals. This is not a naming preference: if a queued write were an
event, then draining a queue would mean *inserting into committed history*, and
a member who was offline for a week would be able to rewrite the middle of the
log by reconnecting.

**Rejection preserves the draft with a named reason and inserts nothing.** The
message stays in the composer, labeled, with a specific sentence about why. It
never appears and then vanishes; it never appears retroactively in the middle of
a conversation other people already read.

### 5.2 The replay decision matrix

Evaluated by the home at drain time, against policy-now, in `proposalId` order
within an author and interleaved across authors (§5.3):

| Situation | Decision | What the author sees |
|---|---|---|
| **Parent was moderated/deleted** while queued | Refuse | "The message you replied to was removed." Draft preserved; re-target offered |
| **Parent never committed** (refused, or itself expired) | Refuse | "The message you replied to was never posted." |
| **Author's membership expired or was revoked** | Refuse, all queued proposals | "You are no longer a member of this channel." Drafts preserved locally and exportable |
| **Membership was revoked and re-granted** while queued | Refuse pre-revocation proposals; accept post-grant ones | Named as a membership gap, not a silent partial send |
| **`baseEpoch` is stale** (a handover happened) | **Accept** if policy and parent still hold | Nothing — epoch is not a product concept (§4.1) |
| **Base epoch is from a discarded fork** | Refuse | "This channel was recovered from a copy; this message was written after the recovery point." |
| **`happenedAt` far behind `committedAt`** | Accept; order by `committedAt`; render both | "Sent <then>, delivered <now>" — never reordered into the past |
| **`happenedAt` in the future** | Accept; clamp display to `committedAt` | Nothing; the author's clock is never authoritative |
| **Duplicate `proposalId`** (retry after an ambiguous ack) | Accept once, idempotently; return the existing coordinate | Nothing — this is the mechanism that makes retry safe |
| **Same content, different `proposalId`** | Accept both | Nothing. Deduplication is by declared identity, never by content similarity |
| **Edit to a message deleted while queued** | Refuse | "That message was removed; your edit was not applied." |
| **Edit to a message the author no longer may edit** (policy change) | Refuse | Named policy reason |
| **Moderation proposal for an already-moderated target** | Accept as a no-op supersession | Nothing |
| **Quota exceeded** (agent authors, §5.3) | Refuse the excess, keep the earliest | Named in the agent's run surface, never silent |

Two rules that generalize the table: **ordering is always by the home's
`committedAt`/`seq`**, never by an author clock; and **every refusal names its
reason** rather than rendering as a failed send. The second is the honesty bar
from the delivery protocol applied to the composer — "a missing fact renders as
an explicit named gap" (`docs/strategy/multi-agent-delivery-protocol.md` §6).

### 5.3 Agent writers get stricter rules

Agents write faster than people, retry more, and fail differently. Five
requirements, all from the review's MEDIUM set:

1. **Quotas** are per (agent, channel) and per unit time, distinct from and
   stricter than a human member's. A queued agent that comes back after four
   hours does not get to commit four hours of backlog at once.
2. **Deterministic idempotency keys for external actions.** An agent action with
   an external effect derives its `proposalId` from the action's own inputs, so a
   replay after an ambiguous failure is provably the same action rather than a
   second one.
3. **Progress-event coalescing.** An agent's streaming progress must not become N
   committed records. Progress is ephemeral (§6); only terminal state is
   proposed, with a revision counter if it must be updated.
4. **Per-author replay fairness.** A drain interleaves by author. One agent's
   4,000 queued proposals must not monopolize the head of the log while a
   person's single message waits behind them.
5. **Pause and escalate when the authority is unavailable.** An agent that cannot
   commit **stops and says so**. It does not spin, does not retry unboundedly,
   and does not proceed on the assumption that its writes will land. This is the
   agent-side expression of freeze-not-fail, and it is the difference between a
   degraded channel and a runaway.

## 6. Per-noun consistency

**Different nouns get different mechanisms, and that is the architecture — not a
compromise.** A single consistency model for everything is what produces either
an unmoderatable canvas or an unusable whiteboard.

| Noun | Mechanism | Why this one |
|---|---|---|
| Messages, threads | **Authority committed log** | Order is meaning; delivery must be gated on membership-now |
| Membership | **Authority committed log** | Revocation must have an instant, and it must be the same instant for everyone |
| Moderation | **Authority committed log**, append-only tombstone/supersession | A deletion is a record, never an implied erasure of replicated content |
| Agent actions | **Authority committed log** with owner authorization (§3.7) | Attribution and authorization must be evaluable at commit time |
| Drafts, outboxes | **Signed local proposals**, multi-replica | They are the member's, not the channel's, until proposed |
| Canvases, documents, whiteboards | **CRDT**, distribution gated by membership | §6.1 |
| Attachments | **Content-addressed**, peer-distributed | Identity is the hash; distribution is not consistency |
| Presence, typing | **Ephemeral lossy peer state** | Never durable, never in the log, never replayed |

### 6.1 The CRDT rationale, in its correct narrow form

The wrong argument — the one this doc explicitly does not make — is that "CRDT
merges are unauditable." They are not: merges can be signed, logged, and audited
perfectly well.

The correct argument is about **what a CRDT buys and what it costs, per noun**:

- A CRDT's benefit is **write availability during partition** — two members edit
  and both writes survive without a round trip to an authority.
- That benefit is only real if the write can be applied **without consulting the
  authority**. But messages, membership, and moderation writes must be
  authorized against *current* policy at delivery time. A CRDT that must check
  membership-now before merging **has already given up the availability win**;
  it needs the authority online anyway, and has only added merge machinery.
- And if it *doesn't* check — the only configuration where the CRDT actually
  wins — it inherits **revocation staleness**: during a partition, a removed
  member's writes merge into every replica, and moderation propagates as a
  suggestion. That is precisely the failure the product cannot have.
- For a **canvas**, the tradeoff inverts. Concurrent edits by two *already
  authorized* members must merge without a round trip; the cost of a bounded
  revocation-staleness window is a revoked member's late strokes on a drawing,
  which is recoverable and low-stakes. So the canvas gets the CRDT, and its
  *distribution* is gated by channel membership — the log decides who may hold a
  replica; the CRDT decides how replicas converge.

**Moderation is append-only, always.** A delete commits a tombstone that
supersedes; a retraction is a record, not an absence. Every uncertainty state —
missing authority, unverifiable segment, replication lag, uncertain promotion —
renders as a **named gap**, per the delivery protocol's honesty rule
(`docs/strategy/multi-agent-delivery-protocol.md` §6).

## 7. Resource leases during a home outage

The #1392 thread originally claimed that channel state and contributed resources
"degrade independently" — that a backing Station's resources keep working while
the channel's home is down, because they ride pairing credentials rather than the
home. **The review qualified this, and the qualification is adopted.**

- Access to a channel-scoped resource is a **short-lived capability lease**
  minted by the channel authority: `(channelId, epoch, grantee, capability,
  expiry)`, with the expiry in minutes, not days.
- While the home is unreachable, a Station may keep using a lease it **already
  holds**, until it expires. It cannot renew, and it cannot obtain a new one.
- **So the offline window is bounded by the lease TTL, and after that the
  contribution stops.** That is a real degradation, stated rather than papered
  over. The honest sentence in the UI is *"this channel's home is offline;
  contributed resources stop working in <N> minutes."*

Why not longer leases: a long lease is an unrevocable grant. The whole reason
conversation state has an authority is that revocation must have an instant
(§6.1); a resource grant that outlives revocation by a day reintroduces exactly
the staleness the architecture was chosen to avoid, on the surface where it costs
the most.

Activity performed under a still-valid lease during an outage journals locally
and posts on the home's return **with two clocks** — `happenedAt` (untrusted,
the doer's) and `committedAt` (the home's) — under §5.2's rules. The backing view
renders home liveness and contribution liveness as **separate** columns, because
they are separate facts.

## 8. Pagination, caching, and cache verification states

### 8.1 Everything readable is bound to a coordinate

A page cursor is `{ channelId, epoch, afterSeq, throughSeq, checkpointDigest }`.
A thread summary carries the same binding. The rule: **any read result that a
client will cache or cite must name the epoch and the checkpoint it was
consistent with.** A page that names only a sequence range is ambiguous across a
fork or a recovery, and ambiguity here means silently showing a discarded
history.

The existing cursor (`afterSequence` + `limit`, sequence-ordered,
`src-server/routes/orchestration/orchestration.ts:210-213`;
`src-server/services/orchestration/event-store.ts:318-322`) is this shape minus
the epoch and checkpoint fields, which is the honest way to describe the work:
extend the cursor, do not invent pagination.

### 8.2 Cache verification states

A client renders which of these it holds, and never renders the last one as if it
were one of the first three. This is `ReceiptChainStatus`'s three-state
discipline (`src-server/runtime/conversation/receipt-chain.ts:64`, "because 'we
did not check' must never render as 'it verified'") widened by one:

| State | Means |
|---|---|
| `genesis-verified` | The envelope chain is verified back to channel genesis |
| `segment-verified` | Every envelope in this range verified, and the range links to a signed checkpoint |
| `checkpoint-anchored` | A signed checkpoint covers this range; individual envelopes are trusted transitively through digests |
| `unverified` | Bytes from a cache with no chain link — rendered as such, always |

**Tail truncation is the attack a backward-linked chain cannot see**, and the
in-repo answer already exists: a small head anchor rewritten atomically after
every append, checked on every read, so truncation requires two coordinated edits
and a removed anchor reports `unknown` rather than `intact`
(`src-server/runtime/conversation/receipt-chain.ts:19-28`, `:91-114`). A channel
log needs the anchor for the same reason and gets it from the same substrate.

### 8.3 Staleness labels

When the home is unreachable, reads continue from cache with a sentence, not a
spinner: *"Home offline since 14:02. History through <last message>."* This is
the freeze half of freeze-not-fail, and it is why every cache is a partial
replica by construction rather than by configuration.

## 9. Relationship to shipped and in-flight work

### 9.1 #1423 permalinks — the read-only degenerate case, as resolved

A permalink is a channel-state read with no membership, no writes, and no
liveness. Everything in §3.2 and §8.1 is exercised; nothing in §3.4, §5, or §7
is. That much survives contact with the implementation. The addressing claim
did not.

**Two halves of this section were false and are corrected rather than absorbed**
(station#1598, closing slice-1 finding 4):

1. It said a permalink *is* `{ channelId, epoch, seq, checkpointDigest }`. It is
   not. #1423 shipped a **bearer token** as the lookup key, and the record it
   resolves is bound to `{ sessionId, turnId }` — the turn the operator pointed
   at. A coordinate is not a capability, and replacing the token with one would
   have made every permalink an offline-constructible address to somebody else's
   answer.
2. It said "#1423 is free to adopt this addressing directly." #1423 had already
   shipped when this was written (see §2.10's correction), so it was not free to,
   and the sentence licensed a rewrite of a live capability surface.

**The resolved contract**, as implemented:

| Concern | What answers it | Why |
| --- | --- | --- |
| Lookup | the share **token** (SHA-256 digest is the store key) | possession is the authorization; a coordinate would be guessable |
| Capability binding | `{ sessionId, turnId }` | the thing the operator pointed at |
| Serve binding | `ChannelRecordRef` — **identity** | §3.2: a position names a different record after a recovery |
| Consistency binding | `{ channelId, epoch, seq }` + `checkpointDigest` | §8.1: a cached, cited read names its epoch and its anchor |

The two bindings live in **one record**, as a discriminated `channel` field, not
as two peer addresses — two addresses can disagree and nothing would say which
one the operator meant.

**§9.1's proof is taken in full, server-side, and does not go in the URL.**
Resolution goes through the `ref` only; `(epoch, seq, checkpointDigest)` is
**verified, never dereferenced**, and a disagreement is disclosed as
`coordinate-mismatch` rather than silently re-resolved by position. The
checkpoint digest is deliberately absent from the permalink on three grounds: it
would put private log structure into a link before possession is proven; a digest
pinned in an immutable URL either rots or lies; and an integrity anchor belongs
in an evidence record, not in a locator.

One consequence worth stating plainly, because it inverts this section's original
framing: a permalink built on `(conversationId, messageId)` alone indeed cannot
say *which* history it came from — but the fix is to **record** the coordinate
alongside the identity, not to address by it.

### 9.2 #1425 portable project identity — a draft, and the contribution contract

`docs/design/portable-project-identity.md` is **a draft pending owner approval**
(status: "draft for owner review (2026-08-01, revision 2)", twelve open
questions) and is **not on `origin/main`** — it lives in a sibling worktree at
the time of writing. Everything this doc takes from it is therefore provisional
and marked as such.

What it gives this design, if approved:

- **Membership is not backing.** A member who brings no machine, no checkout, and
  no contributed inference is a first-class participant, not an incomplete setup.
  This design inherits that rule wholesale: a non-backing member's channel
  experience is complete, and nothing in §4 renders them as deficient.
- **Contribution is the per-space consent layer**, and its scope table already
  names this doc's scope: `{ kind: 'channel', channelId }`, alongside the shipped
  `{ kind: 'fleet' }` instance and the proposed `{ kind: 'project', projectId }`.
  Channel membership is the trust boundary for a channel-scoped contribution.
- **Binding stays private.** A member's local realization of a resource never
  leaves their machine; only what was deliberately offered is observable. §7's
  leases are grants over *contributions*, never over bindings.
- **"Host" and "client" are transport words** and stay out of product copy. This
  doc adds "home" to the product vocabulary precisely because it is a statement
  about *where a channel lives*, not about an HTTP role.

If #1425 is not approved in that shape, the affected surfaces here are §7 and
§9.3's vocabulary reuse — not §3.

### 9.3 #1398's backing vocabulary — reused, not re-invented

The channel-home advertisement and the backing view reuse four decisions from
the shipped `station.fleet-contribution/v1`
(`packages/contracts/src/fleet-contribution.ts`) rather than restating them:

1. **Fail-closed, allowlist-only opt-in** (`:66-80`, `:261-265`) — no value of
   the config contributes something the operator did not name.
2. **Four-state participation; the empty array is never the signal** (`:90-105`).
   A channel's copy states need the same discipline: "no copy configured", "copy
   configured but never reached", and "copy current" are three sentences.
3. **Two clocks, kept separable** (`:229-255`) — `projectedAt` is when the view
   was produced, `sourceObservedAt` is the freshness input. A fresh projection of
   a stale copy is a stale claim.
4. **No self-asserted identity in the body** — a manifest is attributed by the
   consumer to the environment it authenticated to. A channel-home record a peer
   serves about itself is attributed the same way.

And one receipt-discipline inheritance: `signature: null` reserved fields
(`packages/contracts/src/fleet-routing-receipt.ts:465-469`) are the fleet's
honest posture for a threat model that does not need signing. §2.3 explains why
this design cannot copy it.

### 9.4 #1410's turn envelope — message-level provenance, with a decision

The provenance envelope (§2.9) is the right per-message provenance record for a
shared channel: its slot algebra already distinguishes `observed`, `referenced`,
and `unavailable`, with four distinct unavailable reasons
(`packages/contracts/src/turn-provenance.ts:56-107`), which is exactly the
honesty vocabulary a cross-member read needs.

**The decision this design forces:** because the envelope is a projection
re-derived from a *local* event stream (`:36-40`), another member cannot
re-derive it. Two options, and the recommendation is OQ-8's sibling:

- **Commit the envelope's inputs to the channel log** — every member can
  re-derive, at the cost of putting engine/model/usage facts into shared history.
- **Commit the envelope as a `referenced` slot** — the record names the
  authoring Station and the turn, and a member who can reach that Station can
  fetch the detail; a member who cannot sees `referenced`, which is a true
  statement rather than a gap.

*Recommend the second as the default with the first as a per-channel policy*:
the referenced form is honest for every reader, preserves the local-only
invariant (nothing is published that the author did not choose to publish), and
does not silently make model/usage telemetry a channel-visible fact.

## 10. Honest costs: what neither architecture solves

The review recorded these as unsolvable by *either* single-authority or mesh, and
they are reproduced here in substance because a design doc that lists only the
problems its choice solves is an advertisement.

1. **Revocation cannot retract downloaded plaintext.** Once a member has read a
   message, removing them removes future access, not past knowledge. No
   architecture changes this.
2. **End-to-end encryption and server-side moderation are in tension.** An
   authority that cannot read content cannot moderate it; an authority that can
   moderate it can read it. This design's authority reads content, and that is a
   choice with a cost, not a free property.
3. **Signatures authenticate keys, not truth.** A signed message proves which key
   signed it. It does not prove the holder is who they claim, that they were not
   coerced, or that the content is true.
4. **Key recovery becomes a trust root.** Any mechanism that lets a user recover
   from a lost device is a mechanism that can be abused to impersonate them. A
   product with no recovery is a product that loses accounts.
5. **A malicious authority can still delay and censor.** §3.5 makes equivocation
   and censorship *provable*. Transparency exposes; it does not compel
   availability, and a home that stops serving cannot be made to serve.
6. **Append-only and deletion law are in tension.** Tombstones preserve
   auditability; some jurisdictions require actual erasure. The two cannot both
   be fully satisfied, and the compromise (erase content, retain the tombstone
   and its coordinate) is a compromise.
7. **Device compromise defeats everything above it.** A compromised device holds
   valid keys and produces valid signatures.
8. **Partition forces a choice between authorization and availability.** This
   design chooses authorization for messages/membership/moderation (freeze) and
   availability for canvases (CRDT). Neither choice is free, and the choice is
   per noun because there is no globally right answer.
9. **Metadata is sensitive even when content is not.** Who talks to whom, how
   often, and when is exposed to the home and to the copy holder, and remains
   exposed under any encryption of content.
10. **Agent spam and prompt injection are policy problems, not architecture
    problems.** Quotas and idempotency (§5.3) bound the blast radius; they do not
    make an agent trustworthy, and no log shape does.

## 11. Open questions, with recommendations

Each carries a recommendation. Deciding these unblocks the contract slices; none
of them block the doc.

- **OQ-1 — Who witnesses a hosted-homed channel: the hosted tier itself, or an
  independent witness?** *Recommend: the tier is the default witness at launch,
  with the circularity disclosed in custody (§4.3), and the witness interface
  kept separate from the serving interface from day one.* A tier that both serves
  and arbitrates can, in principle, hand itself a lease it should not have.
  Separating the interfaces makes an independent witness a configuration change
  rather than a redesign, which is the cheapest way to keep the option honest.

- **OQ-2 — Peer-only channels: freeze only, or opt-in labeled-fork recovery?**
  *Recommend: freeze by default; labeled fork only as an explicit, owner-initiated
  action with the divergence point rendered to every member.* Automatic promotion
  without a witness is the dual-primary failure §1.4 corrects, and an "advanced"
  toggle that enables it is that failure with a consent form attached.

- **OQ-3 — Is "your copy" on by default for hosted-homed channels?**
  *Recommend: yes, for the channel owner's Station, disclosed to every member at
  join.* A default-off copy means the exit door is a promise rather than a
  mechanism, and "Move back to my Station" becomes a long cold migration exactly
  when the user is least happy with us. Cost accepted: the owner's Station stores
  every message of every channel it owns, and every other member must be told.

- **OQ-4 — What durability level does the composer acknowledge at?**
  *Recommend: `committed-home`, with `replicated-copy` as a distinct quieter
  state and synchronous copy as a per-channel policy, default off* (§3.8). One
  checkmark meaning either level is the dishonest option.

- **OQ-5 — What is the signing key model, and is there recovery in v1?**
  *Recommend: per-device signing keys certified by a member-level identity key;
  Station-scoped keys for agent owner-authorization (§3.7); and **no key recovery
  in v1**.* A lost device is re-enrolled, its old proposals remain valid, and the
  member's history is intact because the member key certified the device key.
  Recovery is a trust root (§10.4) and deserves its own decision rather than a
  default. **This is the largest new-work item in the arc** (§2.3) and is worth
  its own review round.

- **OQ-6 — Do refused proposals ever enter the committed log?**
  *Recommend: no — a signed refusal receipt to the author only* (§3.2). Otherwise
  any member can write into everyone's history by proposing garbage, and the
  moderation surface acquires an unmoderatable channel.

- **OQ-7 — Is an agent's authorization a per-proposal claim or a committed
  channel-scoped grant?** *Recommend: a committed grant, referenced by id* (§3.7).
  It makes revocation a log fact with a coordinate and lets any member evaluate
  authorization-at-commit-time from the log alone.

- **OQ-8 — Is an edit a supersession record or a mutable field?**
  *Recommend: a supersession record; the rendered message is a fold over the
  original and its supersessions.* A mutable field cannot be moderated, cannot be
  cited stably by a permalink, and breaks the chain's meaning. Cost accepted: an
  edited message costs more than one record, and the fold is read-path work.

- **OQ-9 — Does checkpoint exchange need a gossip protocol in v1?**
  *Recommend: no.* Every read response and SSE frame carries the current
  checkpoint; clients compare what they have seen and surface a mismatch. That
  gets equivocation detection from ordinary traffic. A dedicated gossip layer is
  deferred until there is evidence the opportunistic path misses real cases.

- **OQ-10 — Attachment custody and deletion.** *Recommend: the home serves
  attachments, copies mirror lazily, the content hash is committed to the log so
  any member can verify, and deletion is a tombstone plus a best-effort unpin —
  disclosed as best-effort.* Claiming attachment deletion is complete would be a
  claim §10.1 says we cannot make.

- **OQ-11 — How small can the lease service be?** *Recommend: as small as
  compare-and-set on one row per channel `(channelId -> epoch, holder, expiry)`,
  off the message path entirely.* Its unavailability should degrade handover, not
  conversation. Resist every future request to put anything else in it; a
  linearizable component that grows features becomes the availability floor for
  the whole product.

- **OQ-12 — Where does the channel-home record live for discovery?**
  *Recommend: served by the authority itself (and by the witness where one
  exists), cached by members with its own freshness, with the project manifest
  carrying only a channel id and a locator hint* (§3.3). Explicitly **not** in the
  portable project manifest — that is CRITICAL correction 1, and the remaining
  question is only the caching and freshness policy, not the location.

## 12. Slice plan

**Sequencing first, because it is the most important line in this section.**
Implementation of this arc starts **after the Flow 3 arc and the fleet arc**, per
the recorded priority order. The one exception is slice 0, which is #1423 and is
already independently scheduled — it is listed here so it is built in a shape
this design does not have to undo.

Sized by dependency and shippability, not by estimate. Slices 0-2 are the honest
personal-Station product; 3-7 are the collaboration tier; 8 is #1392's
multi-quarter program.

- **Slice 0 — Permalinks as the read-only degenerate case (#1423).** The
  addressing tuple (§8.1) and a bounded read route. No log, no authority, no
  membership. Independently useful, independently shippable, and the proof that
  §3.2's coordinate is the right one. *Small.*

- **Slice 1 — Contracts and the signing decision (OQ-5).** Proposal, sequencing
  envelope, checkpoint, and channel-home record types in `packages/contracts`,
  canonicalized with the existing digest helper; plus the key model and a
  sign/verify implementation with key identity and revocation. Zero behavior
  change to any running surface. **This slice is dominated by the signing work,
  not the types** (§2.3), and deserves an independent security review round of
  its own. *Medium, and the riskiest small slice in the arc.*

- **Slice 2 — Single-Station channel log.** A channel-scoped committed log in the
  existing SQLite store, sequence assignment in a transaction, signed envelopes
  under the local key, chain plus head anchor reused from
  `src-server/runtime/conversation/receipt-chain.ts`. **Solo owner only: no
  membership, no remote reads, no copies.** The local-only invariant is untouched
  because nothing new is rendered. *Medium.*

- **Slice 3 — Membership, delivery-time policy, append-only moderation.** The
  member noun, membership records in the log, policy evaluation at commit,
  tombstone/supersession moderation. This is the slice where "Station is
  single-user" (§2.2) stops being true, and every authorization path it touches
  needs fresh-context review. *Large.*

- **Slice 4 — Copies and durability levels.** Verified replication to a second
  Station, the four durability levels on the wire and in the composer (§3.8,
  §4.2), staleness labels, custody disclosure (§4.3). *Medium-large.*

- **Slice 5 — The lease service, handover, and freeze.** The compare-and-set
  arbiter (OQ-11), promotion certificates with the loss-allowed flag, witnessed
  handover, peer-only freeze, and labeled-fork recovery as an explicit owner
  action. *Large; this is the slice that must not be rushed, because it is the
  one whose bugs lose committed messages.*

- **Slice 6 — Queued proposals, the replay matrix, and agent write discipline.**
  §5 end to end, including quotas, deterministic idempotency keys, coalescing,
  fairness, and pause-and-escalate. *Medium-large.*

- **Slice 7 — Checkpoint exchange, equivocation proofs, inclusion commitments.**
  §3.5's transparency machinery, opportunistic over existing traffic (OQ-9), plus
  the verifier and the product surface for a detected equivocation. *Medium.*

- **Slice 8 — The hosted tier implementation of the same contract.** Multi-tenant,
  tenant-keyed, shard-by-channel, sticky routing, cross-node fan-out, rebalancing
  via the same lease handover. **This is #1392's core and is already sized there
  as a multi-quarter security and data-boundary program.** *Very large.*

- **Deferred to its own arc — canvases and documents (§6).** A CRDT dependency,
  a collaborative surface, and membership-gated replica distribution. Nothing in
  slices 0-8 depends on it.

**Honest sizing.** Slices 1-4 alone are a quarter-scale arc for one lane, and
slice 3 changes an authorization model that currently assumes one operator
(`src-server/runtime/bootstrap/runtime-initialize.ts:354-357`). **If the arc has
to stop somewhere, stopping after slice 2 leaves a coherent shipped product** —
Station's own conversations get a real committed log with verifiable history and
permalinks that survive it, with no new vocabulary on any screen. Stopping after
slice 4 leaves a working two-Station collaboration with honest durability and no
handover. Stopping between slices 4 and 5 is the *only* dangerous resting point:
copies exist and handover does not, which is a product that promises a copy and
cannot use it.

## 13. UNVERIFIED

Recording a direction does not verify it. Each item is a gap this doc knows it
has.

- **Every current-behavior claim in §2 was read, not executed.** No test was run,
  no Station was started, and no scenario was reproduced for this doc.
- **The "nothing signs anything" claim (§2.3) is a grep sweep**, over
  `packages/`, `src-server/`, and `src-shared/` for a named set of primitives and
  libraries. A signing implementation using a primitive not in that set, or
  reached through a dependency rather than an import, would not appear. Slice 1
  must re-derive it before building on it.
- **No performance or storage sizing exists for a per-channel log.** Message
  volume, checkpoint cadence, chain verification cost on a cold client, and the
  storage cost of "your copy" on an owner's laptop for every channel they own
  (OQ-3) are all unmeasured. A spike belongs before slice 2, not during it.
- **The lease service has no chosen implementation.** "Linearizable
  compare-and-set" is a requirement, not a design; whether it is a row in the
  hosted tier's own datastore, a separate service, or something else is
  undecided, and its availability characteristics directly bound handover
  latency.
- **The signing key model (OQ-5) has no threat model written.** Device
  enrollment, member key custody, agent key issuance, and revocation propagation
  are named as requirements and not designed. This is the single largest
  unverified area in the doc.
- **Equivocation detection assumes members compare checkpoints.** No estimate
  exists of how often that actually happens in a small channel where most members
  are idle, and a detection mechanism nobody exercises is a detection mechanism
  in name. Slice 7 should state a measurable detection expectation rather than
  ship the format alone.
- **Inclusion-commitment non-inclusion proofs require the complaining member to
  hold the intervening segment** (§3.5). The coverage this actually provides for
  members who were away is unquantified.
- **The #1425 vocabulary this doc builds on is a draft pending owner approval**
  (§9.2) and is not on `origin/main`. If its membership/contribution model
  changes, §7 and §9.3 change with it.
- **The reference-implementation readings (§0) are second-hand here.** They were
  established in #1392's and #1398's threads and in the private ops workspace
  analysis; this doc did not re-derive them, and §0's survivorship caveat applies
  to all of them.
- **No decision has been taken on any OQ in §11.** Every recommendation is the
  author's, and the doc's slices assume them; a different answer to OQ-1, OQ-3,
  or OQ-5 changes slice content materially.
- **The adversarial review was not re-run against this document.** It reviewed
  the architecture as described in #1392's thread. This doc's rendering of its
  amendments — particularly §3.4's lease mechanics, §3.5's inclusion
  commitments, and §5.2's matrix — is an interpretation that has not itself been
  independently reviewed.
