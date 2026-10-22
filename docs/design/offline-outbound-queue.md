# Offline outbound queue scope

> **Reading status: queue policy with implementation notes.** Reconnect replay
> below is not permission to retry a possibly-started turn. Current
> [OutboundDispatchModule](../architecture/module-map.md#outbounddispatchmodule)
> distinguishes pending work from non-replayable invocation/effect evidence;
> [the queue](../../src-ui/src/lib/outboundQueue.ts) and its
> [send caller](../../src-ui/src/hooks/useActiveChatSessionMessaging.ts) own that decision.
> Log-level edits use a separate [revisioned service](../../src-server/services/config/log-level-edit-service.ts)
> and [route](../../src-server/routes/system/config.ts). The exclusion policy
> below does not certify every current configuration route's concurrency behavior.

Station's durable outbound queue stores user chat turns only. Each stored turn
keeps its client-generated turn id, and reconnect replays that same id so the
server can deduplicate a request that landed immediately before disconnect.
The queue survives restart and is projected back into the chat dock before a
reconnect flush begins.

The same queue keeps a text send from the composer durable while it is in
flight. The send is written as `invoking` before its request goes out (a write
bounded to three seconds; past it the send goes without the row and the
composer keeps its saved draft), and the composer's saved draft is let go only
once that row is written, so closing the app mid-send loses nothing and leaves
no second copy to send under a new key. Station's own answer settles the row:
a refusal removes it and hands the text back to the composer; Station's
"may have started" answer keeps it as unconfirmed (never resent, and it no
longer holds back later messages in the chat); anything else, including a
proxy's or tunnel's 502/503/504 or no answer at all, releases the row for
Station's [delivery lookup](../reference/session-api.md#find-out-what-became-of-a-send). A foreground send that
already has an exact-key `started` answer, or an explicitly keyed turn-start event
matching its authored bubble, remains delivered if the original response later
fails. An unkeyed legacy match is not proof for retiring the send, and a weaker
lookup already in flight cannot erase a witnessed start. Acceptance retires the
key and removes its overlapping attempts together. Durable flush dispatches
(`options.dispatch`) retain their separate provider-turn settlement rules.
While it waits, the message reads "No answer yet · sends once Station confirms
it never arrived" on its bubble and in the outbox list, and its chat notice's and
the list's Discard… withdraw it only after the shared confirmation, which says
that a message which already arrived cannot be taken back. Every open window
re-reads the queue's finished keys on the cross-window change channel and when it
comes back into view, so a discard in one window removes the bubble in all.
That channel refreshes what a window shows. It starts a send there only when a
message the window could not send before, because an earlier message of its chat
went first, now can (for example, the other window's send that held it back has
settled, even if that window then closed). A message that could not be sent for
another reason, such as a turn still running, is not retried on every notice. That
send only sends: it asks Station about nothing and never re-holds the window's
queued follow-ups (which would take back a follow-up a duplicated tab also holds,
and that tab would do the same in turn). A queued message is not sent while a turn is
running in its chat; it goes when the turn ends. If one is tried anyway, it waits
without using up an attempt and is not tried again for a moment and a half,
whatever asks; it is retried once that wait ends. A send another window has claimed reads "Sending", with no Check,
only while that window is proven running (it holds its renderer lock); a claim
left by a window that closed or crashed reads "No answer yet" like its bubble,
with Check and Discard…, and the discard checks again that the window is gone.
A window's own claim reads "Sending" only while its own send is in progress.
While any send reads "Sending" this way the list looks again every few seconds,
since a window that closes says nothing.
The lookup settles released rows, and rows whose app was closed, at the next
launch or reconnect: never received → sent again with the same key; started →
done; received → asked again later; possibly started, or the conversation runs
on another Station → kept as unconfirmed, with a Check that asks Station again
and never resends, and a Discard… that removes it only after the user confirms
"I checked, discard it" with the risk stated (its key is retired, so it is never
sent again). Each row records the Station it was written for and is
only ever sent to, or settled by, that Station; for another it waits, listed.

Station can also hold a follow-up itself, in the conversation's durable inbox
([#3568](https://github.com/kontourai/station/issues/3568), `whenBusy: 'queue'`
in the [Session API](../reference/session-api.md#let-station-hold-a-follow-up)).
The app does not use it yet; until it does, the rules below apply.

Follow-ups held behind a running turn stay in the tab's session storage, and
each keeps a durable copy in the queue under the key the queue will send it
with. Nothing sends that copy automatically: the window's own queue sends it
when the turn ends, a reload's restored queue takes the copies back (so an
edit or a delete there is what counts), and a copy whose window closed, or
another window's, is listed first with Send and Discard for the user (it does
not hold back later messages). A discarded or delivered message is never sent
again from any window. A
message whose row is already on its way or possibly started is never sent
again from the composer or the queue. A send refused because the engine is
busy joins that queue with its own key and copy, and the queue's drain writes
the same before-the-request row as a composer send. Sends with attachments or
a visual skill are not written to the queue (their draft is kept until
Station answers, as before).

Configuration edits are excluded by default. Station has no single
configuration-mutation protocol: agent, connection, plugin, and system edits
have different authority and concurrency rules, and the current write routes
do not accept an idempotency key or a revision precondition. Treating those
writes as "safe" client-side would allow a stale offline edit to overwrite a
newer server value. The cached offline UI therefore remains read-only for
configuration. The one bounded exception is the non-secret app log-level
setting. Every log-level save, online or offline, first writes a dedicated
envelope and then uses `GET/PUT /api/config/app/log-level`; it never passes
through the broad app-config mutation. The endpoint exposes a field revision and
requires both `If-Match` and `Idempotency-Key`; the server serializes edits and
durably records applied or conflict receipts. Its separate IndexedDB envelope
survives restart, remains visible as pending/conflicted in System settings, and
offers awaited retry/discard controls. Each envelope binds the authoritative
connection id, environment id, and normalized origin; a different active
Station leaves it visibly blocked and receives no request. Success is accepted
only when the receipt repeats the operation id and requested value with a valid
resulting revision. Ambiguous response loss preserves the same operation for
replay. Conflict retry is an explicit rebase
with a new operation id. It does not reuse the chat-turn queue.

For other mutation families, both authenticated fetches and SDK mutations fail
before dispatch on a current connection-layer reachability failure, with a
reconnect message. The browser's link-layer offline flag alone does not refuse
writes. A network failure recorded in this browser session refuses writes until
a successful read recovers reachability. Older stored health failures do not
block a new attempt: an accepted request must still be able to
retire stale failure evidence. Native transport does not infer unreachability
from `navigator.onLine`, which can be false while a VPN route works. Existing
request deadlines bound a new attempt when no current reachability failure exists.
This is failure reporting, not mutation durability. Any additional queued family
must independently add an idempotency key and revision/conflict receipt.

The broad `PUT /api/config/app` refuses any payload containing `logLevel`
before mutating any sibling field. The web settings surface and live CLI both
use the dedicated endpoint. After terminal acceptance, the renderer atomically
replaces the pending envelope with a target-scoped revision marker, so a second
online edit uses the accepted revision without waiting for another GET. Queue
read failures and reconciliation-write failures remain globally visible on
Home; a successful read does not erase a write failure, which clears only after
a successful durable write or explicit acknowledgement.

Revision metadata is compacted to one newest marker per Station target and is
never counted against, or allowed to evict, actionable envelopes. At twenty
pending, blocked, conflicted, or failed edits, enqueue refuses visibly and asks
the operator to retry or discard existing work before adding another change.

The server retains the newest 256 terminal log-level receipts. A retained key
replays its original receipt; reusing it with a different payload is a conflict.
After eviction, replay is safe only because this subresource is an idempotent
field assignment: the service recognizes an already-current requested value as
applied without issuing another config write.

Approvals are also excluded. They are live server decisions with expiring
authority. Station queues the user turn that led to an approval, never the
approval response itself.

Personal approval defaults are captured for a first interactive send before it
becomes durable. The pending choice retains the account namespace that selected
it. Unknown authority holds the choice for verification; a different verified
account retires it. Replay under the same account retains the original choice.
Explicit chat picks remain independent of inherited personal defaults.

## Offline reading and the browser shell

The [user guide](../user/getting-started.md#read-recent-conversations-offline)
owns consent, limits and local-device disclosure. The implementation is separate
from outbound intent: [offlineReading](../../src-ui/src/lib/offlineReading.ts)
stores a closed user/assistant text projection from successful history windows.
It retains one explicitly enabled authority shelf, binds it to the connection,
origin, credential authority generation and credential state, fences delayed
writes with an atomic revision,
and clears it on authority changes and sign-out. The local reader is outside the
live access gate; it does not hydrate a QueryClient, verify a person, expose live
approvals, or reuse saved text as current online data. Other tabs hear committed
changes through BroadcastChannel. IndexedDB failure is reported by the setting
and reader; a failed best-effort history capture cannot fail the live read.

Raw `orchestration-sessions` remain excluded from query persistence: they inherit
`resumeCursor`, model routing, runtime diagnostics and prompt-derived titles.
[OfflineSessionIndex](../../src-ui/src/components/OfflineSessionIndex.tsx) projects
only identifiers, capped at 1,000 rows, into `offline-session-index`. The existing
success-only whitelist, 24-hour maxAge, build buster and authority quarantine
apply. This index is not an offline authority credential.

The web build emits `offline-shell.json` before any listener injection. Its HTML
contains external scripts only. The [worker](../../src-ui/public/sw.js) fetches
that shell and its startup assets without credentials, constructs the fallback
with a CSP admitting no inline scripts, and never stores a navigation response
or its per-request nonce. A cached live index would replay its nonce and possibly
its runtime bootstrap; the generated shell avoids both. Navigations use the
network first, falling back on network failure or a 502/503/504 response. Auth refusals are
passed through. The fallback marker opens the local reader even when the browser
link stays online; **Retry connection** loads current server HTML. APIs, SSE, auth routes,
query-bearing URLs, mutations and authorization-bearing requests are not cached.
Hashed assets use cache-first storage after anonymous fetches. New build workers
activate immediately and remove older shell caches; registration bypasses the
HTTP worker cache and checks for updates at launch and on returning to the tab.
An already open page offers **Reload to update** when its controller changes.
A page loaded from the anonymous fallback reloads on reconnect to obtain the
current runtime bootstrap. Ordinary navigations always request fresh HTML.

Executed tests cover a real Chromium offline reload and IndexedDB bounds, a
mounted history-reader capture, the safe query projection and fail-before-send
mutation behavior. They do not establish native offline reading, revoked access
while disconnected, or a guarantee that local plaintext is safe on a shared
browser profile.
