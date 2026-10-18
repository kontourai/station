---
status: current
subject: Per-publisher Station telemetry tiers and consent boundaries
decided: 2026-10-17
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/1229
---

# Per-publisher telemetry tiers

This records the whole program direction. The foundation supplies contracts,
configuration, migration, policy, monthly Full identity, CLI status/choice, and
disclosure inventories. Daily sending, a transparency ledger, consent UI,
plugin publishers, receiver changes, dashboards, release injection and deployment
remain separate lanes. This decision does not assert that any of them is deployed.
The numbered ADR directory is frozen; new decisions use this topic-keyed record.

## Consent and publishers

Each publisher has its own Off, Lite, or Full choice. `kontour` is the app author;
`operator` is the existing configured product receiver; `publisher:<registry id>`
identifies a plugin or distribution publisher. The two built-in choices are
stored in `telemetryTier` in Station configuration. Plugin publisher registration
and storage are future work. Sinks are independent: an operator endpoint never
replaces, disables or grants consent to an author endpoint.

Off sends nothing for that publisher. Lite is the default: one identifier-free
daily aggregate per publisher, after clear notice and with an always-available
Off switch. It requires no acknowledgement. Headless/CLI/portable/Docker startup
must print a one-time notice and record its inventory revision before Lite sends.
An updated Lite inventory requires showing the updated notice. That notice and
startup behavior belong to the daily sender lane, and no Lite sender exists in
this foundation.

Full is an explicit choice and requires the current inventory-bound disclosure
acknowledgement. A changed Full inventory invalidates that acknowledgement. The
existing acknowledgement covers only the operator sink; it cannot consent to a
new author or plugin sink. Later publisher acknowledgements must bind publisher,
current inventory, and disclosed destination. Distributions cannot hide or restyle
kernel consent surfaces.

`DO_NOT_TRACK` with any value except the empty string or `0` forces Off for every
publisher, including an explicit Full choice. It controls product telemetry;
operator OTLP diagnostics retain their separate configuration. CLI status shows
DNT as the reason. Otherwise explicit user choice wins. A distribution default
or operator policy may lower the default from Lite to Off; it may never raise it
to Full, even if an earlier disclosure exists. Without a Full receipt, requested
Full resolves to Lite with reason `disclosure`. The pure policy also reports
`policy`, `default`, or `user`. Policy inputs are contracts for future distribution
and operator wiring, not a claim that manifest consumption exists today.

Migration: a saved legacy false becomes Off for both built-in publishers. Saved
true with a current receipt becomes Full for operator and Lite for Kontour;
without the receipt both become Lite. Explicit tier maps are preserved.
`STATION_TELEMETRY_TIER` supplies an absent choice; canonical and legacy boolean
environment variables remain fallbacks. Saved choices take precedence over these
fallbacks, and DNT overrides them all. A legacy client can still withdraw consent.
A new inventory can invalidate a receipt before migration; that correctly yields
Lite rather than silently extending old consent.

## Fields and identity

The exact Lite catalog and bounded arrays are owned by
[`STATION_DAILY_FIELDS`](../../packages/contracts/src/product-telemetry.ts).
It enumerates version (a public release version or `custom`), channel, platform,
architecture, surfaces used today, first-active-week/month flags, installation-age
and paired-device buckets, known engines, public distribution ID or none/custom,
at most 20 public plugin IDs, a private-plugin count bucket, branding/home/layout
customization booleans, abandoned setup step, per-engine connection-failure
buckets, and safe-mode/crash-disable counts capped at 65,535. Arrays are bounded,
unique sets. Only catalog-verified public IDs/versions are accepted; private
names and custom build labels cannot be laundered through a string-shaped ID.
The ping carries a random event UUID for retry deduplication, never an installation
ID or cross-day key. First-run and last-active day/week/month dates stay local.
Flags permit WAU/MAU estimates by counting first-active flags without identifiers;
exactness requires complete daily delivery and deduplication and cannot be promised
over network loss, uninstall/reinstall, or local-state resets.

Full keeps the classified startup, recovery, and engine-turn events and defines
pane opened, plugin installed/removed, setting category changed, client connected,
setup abandoned, engine connect failed, safe mode entered, and plugin disabled
after crash. Public IDs are catalog checked; private ones become `custom`. No
setting keys/values, prompts, paths, account IDs, device IDs, error text, or private
plugin names are permitted. Existing Full build/time metadata remains disclosed.
New event definitions do not install new producers.

Full `distinct_id` is SHA-256 of the existing random per-install UUID concatenated
with UTC `YYYY-MM`. It rotates monthly and is never account-derived. No account
files are read for telemetry. Identity is accessed only after Full admission and
an endpoint is configured. Lite cannot reuse this identity. Keep retry batches
within their identity period in a future durable sender; receivers cannot treat
this as a permanent installation or person count.

Lowering a tier or uninstalling a plugin may offer an optional one-tap reason:
privacy, too-much-data, performance, not-useful, unexpected, other, or skip.
Feedback is an explicit, identifier-free action to that publisher only. Skip
means no feedback transmission; it must not create another background signal.

## Transparency and receivers

A local outbox ledger will record every sent or dropped payload with publisher,
tier, outcome and reason. Retain at most 30 days and 5 MiB, evicting oldest first;
serve it through an authenticated API, Settings, and `station telemetry outbox`.
This foundation defines its type and limits; it does not implement that ledger.
`station telemetry status` and `station telemetry set <publisher> <tier>` use the
running Station's authenticated APIs and report effective policy reasons.

A receiver must accept Lite without an installation secret: official binaries
cannot keep a shared secret. Use a public per-channel source identifier, strict
schema validation, bounded requests and in-memory rate limits keyed by a daily
salted hash of IP. Never persist IPs or user agents, including proxy/access logs,
error reporting, backups, and derived raw request records. Rotate and discard
the salt and rate-limit state daily. Public and publisher counts use the same
true k=10 distinct-contributor pre-filter followed by deterministic per-coordinate
two-sided geometric noise. The schema permits 16 scalar/bucket increments plus
5 surfaces, 8 engines, 20 public plugins and 8 engine-failure buckets: sensitivity
57 per added/removed ping. Per-count ε=1/57 composes to ε≤1 per ping per publisher
per UTC arrival day for fixed release support (replacement adjacency costs ≤2).
Counts are rounded, clamped nonnegative estimates; expected absolute noise is
about 57 pings and 95% absolute error is at most 171 pings. Small values near k
are often uninformative; 100k-scale values have roughly 0.171% 95% relative error.

The hard true-count pre-filter itself is **not differential privacy**: adding a
victim can change a value from absent to present. k−1 colluding keys plus the
victim can pass the pre-filter; noise bounds what is learned from the released
counts, not that threshold decision. Consequently the complete API has no pure
ε=1 guarantee. Full support privacy needs a private threshold or fixed public
domain. This preserves the orchestrator's requested k pre-filter while stating
its remaining disclosure. Counts bound one ping's influence, not a person or
installation; repeated pings, multi-day lifetime contributions and cross-publisher
contributions compose with growing privacy loss. Prior exact publications remain
exposed. Set histograms overlap and noisy differences do not give exact counts.
Plugin/distribution aggregate access uses scoped publisher keys and an independent
post-auth admission budget. Unknown keys never open database transactions.

The receiver generates a persistent random 32-byte HMAC key on first migration
and stores it in a database table with `PUBLIC` privileges revoked. Restrict
service/database-owner and backup access. Domain-separated HMAC seeds include
publisher, day, dimension and value; both views and repeated reads reuse the same
noise, including across restarts. This is a finite-precision cryptographic
implementation of the geometric mechanism. Back up the key with the schema.
Losing/rotating it changes historical estimates, creates additional independent
releases and enables averaging; preserve old keys or published estimates before
any future rotation. Compromise reveals the noise. No rotation endpoint exists.

The receiver computes closed-day marginals in resumable per-dimension SQL
transactions, erases temporary contributor associations in bounded batches, and
runs raw/Full retention independently. Public reads never take the ingest
admission lock. These local receiver behaviors do not establish deployed privacy,
proxy logging policy or an installed Station sender. See the
[receiver contract and verification](../../packages/telemetry-broker/README.md#public-aggregates).

## Deferred privacy transport

OHTTP removes the receiver's view of client IP. Adopt it before claiming network
unlinkability, when a privacy audit identifies IP-based linkability unacceptable
for the deployment, or before an operator requires that guarantee. Deployment
requires an independently operated relay, a documented trust split, and failure
behavior that does not silently fall back to direct transport.

DAP/Prio limits receivers to aggregate totals. Evaluate/adopt it before adding
sensitive or high-cardinality dimensions, when independent publishers require
non-observation of individual reports, or when a privacy review shows that
schema minimization and k suppression cannot bound linkage. Preserve enum,
bool, bucket and count shapes for that move. Both mechanisms remain deferred;
implementation, availability, and adoption thresholds need a separate reviewed
decision before changing a deployed privacy claim.

## Build and owner boundaries

The server's build banner supplies `STATION_AUTHOR_TELEMETRY_ENDPOINT`; source
execution has an empty constant, and runtime environment cannot enable it.
Official release workflows may inject an owner-managed repository variable in
a later lane. Fork, development and Docker workflows must leave it empty unless
the owner deliberately changes their distribution policy. There is no hardcoded
Kontour URL. Exposing a build constant adds no sender.

Do not deploy the broker, set that repository variable, publish artifacts, or
enable real traffic as part of this program's implementation lanes. Each is an
owner-gated action. Receiver/proxy retention review, public disclosure and store
classification approval, endpoint enablement, and end-to-end release qualification
remain separate from local source/tests and from this decision's acceptance.
