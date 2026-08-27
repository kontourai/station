# Offline outbound queue scope

Station's durable outbound queue stores user chat turns only. Each stored turn
keeps its client-generated turn id, and reconnect replays that same id so the
server can deduplicate a request that landed immediately before disconnect.
The queue survives restart and is projected back into the chat dock before a
reconnect flush begins.

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

For every other config family, the SDK's authenticated mutation boundary checks the active
connection's `lastError` through `mutationAllowed` and throws
`StationReadOnlyError` before any non-GET request is issued. That is a
fail-loud prevention rail, not config-edit durability. Any additional family
must independently add an idempotency key and revision/conflict receipt before
it can be queued.

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
