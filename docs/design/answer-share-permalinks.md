# Scoped answer share permalinks (archive#1423)

> Status: **shipped, v1** — the design contract for `/api/shares`,
> `/.well-known/station/v1/share/view`, and the standalone `/share` page.
> Parent: archive#1391 (per-answer provenance cards). Depends on archive#1410 (turn
> provenance envelope), archive#1424/#1434 (attribution + composition), and archive#1467's
> pairing-scope decoupling. Successor: archive#1392 (Kontour-account identities).

Station's first sharing primitive: an operator shares **one answer**, and the
recipient gets that answer plus its provenance card, read-only, revocable, and
expiring. Nothing else on the Station is reachable from the link.

## 1. The share grant: a bearer credential, not a pairing scope

The issue proposed riding the pairing-scope machinery — a narrow read scope
bound to specific turn/session ids. Implementing it that way was considered and
**rejected**; the smaller honest design is a bearer credential bound to the
resource, with no new scope token at all.

A pairing scope answers *"which route families may this credential reach"*: a
station-wide, resource-blind question. A share answers *"which single turn may
this holder read"*. The scope vocabulary structurally cannot express the
second — `parsePairingScope` validates opaque space-delimited tokens against a
fixed set; there is nowhere for a session id to live. So a `share:read` token
would authorize the share *route family* while the record still carried the
only binding that matters: two mechanisms for one decision, with the weaker one
being the one a reader sees in a scope string. That is the same
"the lower tier is the effective one and the higher gate is decorative" failure
archive#1398's security review named (M-4).

Two further reasons the pairing machinery is the wrong host:

- A pairing grant is a **device relationship** — a registry entry, an
  offer/confirm handshake, push subscriptions, a name in the operator's
  paired-device list. A share recipient is not a device, and putting them in
  that list would misstate what the operator agreed to.
- `PAIRING_SCOPE_PRESETS` is a vocabulary for **breadth** — every scope grants a
  credential many routes. A share is the opposite shape: one resource, one verb.

**What ships instead.** `AnswerShareStore` mints 32 random bytes (base64url),
stores only `sha256(token)` as hex, and binds the record to `{sessionId,
turnId, ownerUserId}` at mint time. The token is returned exactly once. The
digest is the *only* lookup key a viewer request can reach — there is no
id-plus-secret split, so possession of the token is the whole authentication.

**What DOES ride the pairing vocabulary** is the operator's management surface.
`/api/shares` is gated at `access:manage`, the ceiling `/api/pairing` and
`/api/environments/peers` use, because *minting a share mints a credential*.
`access:manage` is the one scope no pairing preset ever grants a paired device,
so no device — however broadly scoped — can publish the operator's answers or
revoke their links. The `GET` is deliberately not split down to
`orchestration:read`: the list names which answers have been published and to
how many live links, which is a relationship fact of the same class
`/api/environments/peers` is gated for.

### 1.1 Protected-route authorization (security review H-1)

The runtime authenticates every protected route before resolving its pairing
scope. A bare direct loopback socket has no authority: it may be an SSH local
forward, so a credential-less `GET`, `POST`, or `DELETE /api/shares` returns
`401 authentication_required`. The previous method-specific loopback floor is
retired.

`/api/shares` then requires the `access:manage` scope for every verb. A
supported client presents a bearer or device-session credential; an invalid or
insufficient credential receives the named authentication or scope refusal.
Station's exact internal callers are separate from its UI proxy: the per-boot
internal token, `caller: local` marker, and direct loopback socket form an
exact process credential for Station-internal/MCP use. The UI proxy always
marks browser traffic remote and relays that browser's credential. Neither
path is a TCP-loopback bypass or can be recreated by an SSH forward or a
caller-supplied address header.

## 2. Where the token travels

The permalink is `<origin>/share#t=<token>`. The token is in the URL
**fragment**, which browsers never send to a server, so it stays out of access
logs, proxy logs, and `Referer` headers on any outbound click. The standalone
page reads it client-side, immediately `history.replaceState`s it out of the
address bar (so it is not left in session history, session restore, or a screen
share), and presents it in the body of
`POST /.well-known/station/v1/share/view`.

**The origin is composed by the CLIENT, never the server** (security review
H-2). The first cut had the mint route build the permalink from
`new URL(c.req.url).origin` — the `Host` header. In the shipped topology the
browser talks to the UI port, whose proxy rewrites `Host` to the backend before
forwarding; the backend serves no static assets and has no `/share` route (the
SPA fallback lives only in the UI server). Every minted link therefore pointed
at a port that could not serve it — dead before any question of remote
reachability, and dead in a way that looked correct. It is not fixable
server-side: behind a rewriting proxy the server cannot know the origin the
user's browser is on. `AnswerShareMintResult` carries `{ share, token }` and
nothing else; `ShareAnswerButton` composes the link with
`answerSharePermalink(window.location.origin, token)`, the one origin known to
be true.

That route is `public` in the runtime's routing sense — registered before
`configureRuntimeHttp`, listed by exact method+path in `PUBLIC_ROUTES` — and
credentialed in the product sense. "Public" here means *carries no pairing
credential*, never *anonymous*: without a token that hashes to a stored,
unrevoked, unexpired record, the route serves nothing.

## 3. Enumeration posture (the deliberate decision)

Two requirements pull against each other. An honest surface must say "revoked"
rather than 404 (archive#1423). A public route must not become an oracle for which
shares exist (archive#1467's discipline). The resolution: **possession of the token is
the discriminator, and the record is keyed by the token's digest so the two are
the same lookup.**

| Caller | Answer | Status |
| --- | --- | --- |
| No record for the presented token — never existed, mistyped, malformed, unparseable body, over-sized body, query string present | `share-not-found` | 404 |
| Token holder, share revoked | `share-revoked` + `revokedAt` | 403 |
| Token holder, share lapsed | `share-expired` + `expiresAt` | 410 |
| Token holder, answer no longer readable as the sharer | `answer-no-longer-available` | 404 |
| Token holder, live share | the answer + re-projected envelope | 200 |

Three properties make this safe rather than merely tidy:

1. **One branch for every no-record case.** A malformed token is not answered
   differently from an unknown one; a body that will not parse is not answered
   differently from a body with no token. A prober never learns that a guess
   was at least well-formed. `answer-share-routes.test.ts` asserts byte-equal
   outcomes across five malformed-input shapes.
2. **Single hash-keyed lookup.** `resolveByToken` computes one digest and does
   one comparison pass; there is no per-record secret compare whose duration
   varies with how close a guess was.
3. **A 256-bit token is not guessable**, so naming a state to its holder
   discloses nothing to anyone else. `answer-no-longer-available` shares 404
   with `share-not-found` because a distinct status would add a signal only the
   already-entitled need.

**Two attempt budgets, not one per-peer bucket** (security review M-1). The
first cut copied the pairing routes and keyed a single bucket on the socket's
`remoteAddress` — but every browser reaches this route through the UI proxy, so
that address is `127.0.0.1` for all of them. It was one globally shared bucket:
any single client could spend it and 429 the entire public share surface for
five minutes, for everyone. Keying on a forwarded-peer header is not the fix
either — the runtime deliberately ignores those (they are caller-controlled),
and trusting one here would let an attacker mint a fresh bucket per request.

`createAnswerShareViewBudget` runs two:

| Budget | Bounds | Key |
| --- | --- | --- |
| Per token (120 / 5 min, soft — see §8) | one viewer hammering their own link | SHA-256 **digest** of the token, never the token — the map outlives the request by minutes |
| Unknown-token, global (60 / 5 min) | brute-force search, which arrives with a *different* token every time and so can never be caught per-token | — |

The global budget is **reserved before the store lookup and refunded when the
token resolves** (security review N-1). Charging it afterwards — the obvious
ordering, and the first fix's — kept starvation-immunity but silently dropped
the *work* bound: every unknown-token request still ran a full
`existsSync`+`lstat`+`readFile`+parse+validate over the whole record set before
the budget could refuse it, measured at ~0.59ms of synchronous event-loop time
at the 500-record ceiling — roughly 1700 req/s to saturate the runtime,
unauthenticated. A rate limiter that bounds only *responses* is not a rate
limiter.

Reserve-then-refund holds both properties independently:

- **Work bound** — a caller past the global budget is refused before the store
  is touched, so a guess costs a map lookup, not a file read.
- **Starvation immunity** — a request whose token resolves has its reservation
  refunded, so legitimate holders never consume the budget an attacker is
  spending, and exhausting it can never lock them out.

The metric `station.answer_share.views` still separates `share_not_found` from
the rest, because the *response* is deliberately uninformative while the
*operator's telemetry* should not be.

## 4. Re-applied authorization on every dereference

archive#1410 R4 requires every dereference to re-apply authorization. A share token
confers no standing on the routes the envelope's references point at, so
`projectEnvelopeForShareViewer` replaces each unauthorized reference with an
explicitly named gap before the envelope leaves the server:

| Reference | Dereferences through | v1 share holder |
| --- | --- | --- |
| `trustReport` | `GET /api/projects/:slug/trust-bundles/:id` (`orchestration:read`) | restricted |
| `routingReceipt` | `/monitoring/fleet-routing-receipts` (`access:manage`) | restricted |
| `sources` | no route exists yet (archive#1409) | restricted |

The reason is a **new** `TurnProvenanceUnavailableReason`,
`restricted-for-this-viewer`, and that is load-bearing. Reusing
`not-captured-by-station` would tell the viewer something false — Station
captured it, they are simply not authorized. Passing the reference through
would leak a project slug and bundle id to someone with no standing on that
project *and* offer a drill-down that can only 403. A named restriction is
simultaneously the more honest answer and the smaller disclosure — archive#1409 AC5's
idiom ("a truthful restricted-source gap with no excerpt leakage").

Two further re-authorizations happen on the same read:

- **The answer itself** is re-read as the *sharer* (`ownerUserId` threaded into
  `readSessionMessages`), so a share can never outlive the sharer's own standing
  on the session.
- **Observed value slots pass through untouched.** They are secret-free by
  archive#1410's construction and they are what a shared receipt is *for*.

An already-`unavailable` slot keeps its own reason: "this engine never reported
it" is a more specific truth than "you may not see it", and it discloses
nothing.

Refs are location-independent by construction (archive#1410) — snapshot ids, bundle
ids, receipt ids — so the card resolves identically for any viewer; nothing in
the payload depends on the sharer's local paths.

## 5. What the share carries, and what it does not

`projectAnswerBlocks` takes **text parts only**. Tool arguments, tool results,
and attachment URLs are exactly the material the envelope's secret-free rule
keeps out of a card, and a share is a *wider* audience than a card. What the
turn did with tools is still reported — by the envelope's tool summary, which
names tools without their payloads. Block count and length are bounded, and the
truncation is disclosed (`omittedBlocks`) rather than silently applied: an
answer that simply stops reads as an answer that ended there.

An envelope the server cannot validate is **omitted** rather than forwarded
raw: the card would render its own unreadable state either way, and shipping
unvalidated bytes to an unauthenticated viewer buys nothing.

## 6. The standalone page

`/share` is mounted **above** the whole provider tree in `main.tsx`, not as a
view inside the app shell. Two concrete reasons:

- `OnboardingGate` refuses to render its children without a reachable,
  credentialed connection — which a share holder does not have and must not
  need.
- `PersistQueryClientProvider` writes fetched data into the browser's
  IndexedDB. Mounting the share page inside it would leave a persisted slice of
  someone else's Station in a stranger's browser. The page fetches once, holds
  nothing, stores nothing.

It is `lazy()`-loaded, so neither it nor its CSS is in the entry chunk every
operator downloads; the entry pays only the pathname predicate, the lazy
wrapper, and `SharedAnswerBoundary`.

That boundary is eager on purpose (security review L-1): it has to exist to
catch the share page's own chunk failing to load. Without it, a failed chunk
fetch and a throw inside the page both rendered the same blank document, and
those mean opposite things to a recipient. It carries no stylesheet and styles
its fallback inline — the one place in this change that departs from the
repo's CSS-class preference, because the failure it reports is precisely the
one where the page's stylesheet may not have loaded either.

**Correction to what "standalone" buys** (security review L-2): the share page
does not avoid downloading the operator's application. Only
`SharedAnswerView` is lazy — `main.tsx` still statically imports `App` and the
whole provider tree, so a share recipient's browser downloads and executes the
entire operator bundle and merely does not *render* it. What the standalone
mount does buy is real and narrower: no `OnboardingGate` credential
requirement, and no `PersistQueryClientProvider`, so nothing of the operator's
data is fetched or written to the recipient's IndexedDB. Making the recipient's
download proportional to what they are shown needs the app tree behind its own
lazy boundary; recorded below.

## 7. Revocation and the operator's surfaces

`DevicePairingService`'s shape, deliberately: revoking **tombstones**
(`revokedAt`), it does not delete. A deleted record would make a revoked share
indistinguishable from one that never existed — precisely the ambiguity this
feature removes for a holder who has proven possession. Revocation is
idempotent and does not move the recorded moment.

- **Mint**: a "Share answer" button beside the provenance card, reading the
  session/turn ids from the *envelope* (never a prop or a position). The result
  is reported **inline and stays on screen** — not in a toast, because the token
  exists exactly once and a self-dismissing notification could take the only
  copy of a capability with it. A failed clipboard write is never reported as a
  copy.
- **Manage**: Settings → Station → *Shared answers*, listing every share with
  its live/revoked/expired state in a sentence, and a two-click inline revoke
  (`PairedDeviceList`'s idiom). The list never shows a token or its digest.

## 8. Out of scope for v1, and recorded residuals

Out of scope by the issue: multi-turn/session shares, public anonymous links,
hosted permalink serving (archive#1393), channel machinery (archive#1392).

Residuals disclosed at merge (the first six are security-review findings
accepted with rationale rather than fixed in this slice):

- **Historical, resolved by archive#2051: `GET /api/shares` previously
  disclosed more than "what was already published"** (N-6). A share's `label`
  is operator-authored prose and the fact-of-publication is a relationship
  fact. All share reads now require a credential and `access:manage`; a bare
  loopback or SSH-forwarded request receives `401 authentication_required`.
- **The per-token view budget is soft under adversarial load** (N-6). The key
  map is bounded at 1024 entries and evicts oldest-first, so an attacker
  presenting 1024 junk tokens evicts a real holder's bucket and resets its
  counter. Harmless today — the counter only rate-limits, so the worst outcome
  is a holder getting *more* budget than intended — but the table in §3 reads
  as a hard per-token bound and it is not one. A keyed sketch or per-share
  storage would make it hard.

- **Allow-by-spread in the viewer projection.**
  `projectEnvelopeForShareViewer` spreads the envelope and re-checks only the
  three named reference slots, so a field added to `TurnProvenanceEnvelope`
  later ships to unauthenticated viewers by default. Tolerable today only
  because the envelope is secret-free by construction (archive#1410 R3/AC3); the
  durable fix is a deny-by-default rewrite that enumerates fields instead of
  spreading. The hazard is called out inline at the spread so the next person
  adding a ref slot sees it.
- **The share recipient downloads the whole operator app** (L-2). Only the
  share VIEW is lazy; `main.tsx` still statically imports the app tree. No
  operator data is fetched or persisted for them, but the bundle is. Fixing it
  means putting the app tree behind its own lazy boundary.
- **No `Cache-Control: no-store` on the share view response** (L-4). The
  response is a `POST`, which shared caches do not store by default, and the
  token travels in the body rather than the URL — but a revoked share could
  still be served from a browser's own back/forward cache, and the header
  should be explicit rather than relying on method semantics.
- **A corrupt `answer-shares.json` fails the whole runtime boot** (L-5). The
  store validates in its constructor and throws, and it is constructed during
  route configuration — so one hand-edited or truncated share file takes
  Station down rather than degrading sharing alone. Consistent with the
  `PeerCredentialStore` precedent it was modelled on, and inherited from it;
  worth revisiting for both together rather than diverging here.

Scope residuals:

- **Serving the SPA to a remote recipient is not solved here.** The share view
  route is public, but Station's static asset serving is outside this change; a
  recipient must be able to load `index.html` from the Station. Hosted serving
  is archive#1393's job.
- **Answer text renders as plain paragraphs**, not markdown. A share is a
  read-only excerpt surface and pulling the markdown renderer into a
  standalone, unauthenticated page is a larger decision (sanitisation surface,
  chunk weight) than this slice should make.
- **No E2E coverage** — hosted CI is down (`local-merge-readiness.md`); the
  journey is proven by focused component tests against rendered output.
- **`ownerUserId` is only ever `null` today.** No caller passes one, because
  the mint route's authenticated caller is the operator and Station has a
  single cached OS-user identity (archive#1392 is the identity seam). The re-read
  threading exists and is tested; it becomes load-bearing when identities do.
- **v2 is the `AnswerShareRefAuthorization` seam.** Kontour-account identities
  (archive#1392) will answer the three reference questions independently — a viewer
  who is a member of the project may well open its trust report while still
  having no standing on this Station's fleet receipts.

### 8.1 archive#1598 — the recorded channel binding

Additive: a share keeps its `{sessionId, turnId}` binding and gains a
discriminated `channel` field recording where the answer sat in a channel log
at mint time, plus a `contentDigest` over the served blocks. Residuals this
slice adds or touches:

- **The `committed` branch has no production producer, by design.** Station has
  no channel log (slice 2 of archive#1484). The mint path can therefore only
  affirmatively observe `{ binding: 'none' }`, and a `committed` record computes
  `unavailable: 'history-not-served'`. That is not a gap being papered over: it
  is the cleanest available proof of the anti-echo requirement, because
  `reported` is *structurally* unreachable without a real resolution. The branch
  is fully typed, validated, and exercised by an injected port double and
  hand-built fixtures. **No stub channel-log service was built**, precisely
  because one would have destroyed that proof.
- **`history-not-served` currently carries two situations that a viewer cannot
  tell apart**: "this Station serves no channel history at all" (every Station
  today) and "this Station serves history but not for this record". The reason
  set is honest in both cases — nothing is being claimed — but it is coarser
  than the other three. Splitting it needs a real log to distinguish against;
  doing it now would invent a distinction with no producer. Disclosed rather
  than pre-emptively split.
- **`{ binding: 'none' }` recorded with no observer wired is a fact about a
  Station that has no channels, not an observation of the answer.** It is true
  today and it stops being interestingly true the moment a channel log exists,
  at which point the `AnswerShareChannelObserver` seam must be wired or every
  new share will keep recording `none` while sitting in a channel. The observer
  is deliberately total — it returns a binding or it throws, and a throw fails
  the mint — because there is no stored state for "I could not tell" and an
  absent field already means something else.
- **A pre-archive#1598 payload gains one additive field.** Its `channel` reads
  `{status: 'unavailable', reason: 'predates-channel-addressing'}` and its
  `schemaVersion` stays `1`. Response bytes for legacy records are therefore
  *not* byte-identical; what is preserved is the resolution path, the version,
  and every existing test. The alternative — omitting the field — would have
  made "this share is older than the question" indistinguishable from "this
  Station is older than the question", which is the ambiguity the slice exists
  to remove.
- **The content digest is brittle by construction.** It is taken over the
  TRUNCATED served blocks, so changing `ANSWER_SHARE_MAX_BLOCKS`,
  `ANSWER_SHARE_MAX_BLOCK_LENGTH`, or the shape of `AnswerShareTextBlock`
  invalidates every digest already recorded. The failure is loud — the
  arbitration refuses with `answer-no-longer-available` rather than serving
  unverified words — which is the trade taken deliberately over a digest that
  silently stops covering what is displayed.
- **The `committed` payload discloses `channelId` to a token holder.** A viewer
  who resolves a `reported` status is shown the channel id, epoch, and seq,
  because §8.1's whole point is that a cited read names its epoch and anchor.
  This is the same disclosure class as the `sessionId`/`turnId` the payload
  already carries, and it is reachable only by possessing the token — but it is
  a *new* identifier in a share response and is named here rather than assumed
  harmless. The checkpoint digest is NOT disclosed to the viewer.
- **The allow-by-spread hazard above is CLOSED.**
  `projectEnvelopeForShareViewer` no longer spreads: it enumerates the
  thirteen fields of `TurnProvenanceEnvelope` it forwards, and
  `ANSWER_SHARE_ENVELOPE_FIELDS` declares that list as data so a test can
  assert it is the whole of it. The seam now fails closed in both directions
  — a required field added to the envelope stops compiling here, and an
  optional field or an undeclared runtime key is dropped rather than
  forwarded to a token holder. This matches the rest of the slice, which was
  deny-by-default already: the binding validator refuses any key outside its
  allowlist (including a `coordinate` smuggled into a `none` binding), the
  store re-maps the binding field by field, and the channel status rebuilds
  the coordinate from the three declared fields rather than forwarding the
  port's object.
- **L-5 (a corrupt `answer-shares.json` fails the whole runtime boot) now has
  more surface.** An invalid `channel` field refuses the document exactly like
  an invalid `sessionId` does, so a hand-edited binding takes Station down
  rather than degrading sharing alone. The store document's `SCHEMA_VERSION`
  was deliberately NOT bumped and both new fields are absent-tolerant, so no
  existing home is affected by the upgrade itself.
- **`ownerUserId` is still always `null`**, unchanged by this slice, and the
  channel binding does not carry an identity of its own — a channel author is
  a member id in the log, not a Station user, and conflating them is archive#1392's
  question rather than this one's.
