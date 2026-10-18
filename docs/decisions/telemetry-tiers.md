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
disclosure inventories and per-publisher Settings controls. The daily sender lane
adds completed-day Lite pings, the bounded local ledger, action-bound feedback and
CLI/log notices. The UI lane adds Lite notices, ledger presentation, and optional lowering reasons.
Author Full consent, plugin publishers, receiver
changes, dashboards, release injection and deployment remain separate lanes. This decision does not assert that any of them is deployed.
The numbered ADR directory is frozen; new decisions use this topic-keyed record.

## Consent and publishers

Each publisher has its own Off, Lite, or Full choice. `kontour` is the app author;
`operator` is the existing configured product receiver; `publisher:<registry id>`
identifies a plugin or distribution publisher. The two built-in choices are
stored in `telemetryTier` in Station configuration. Plugin publisher registration
and storage are future work. Sinks are independent: an operator endpoint never
replaces, disables or grants consent to an author endpoint.

Off stops automatic telemetry for that publisher. Explicit feedback for a recent
lowering is the limited exception described below. Lite is the default: one identifier-free
daily aggregate per publisher, after clear notice and with an always-available
Off switch. It requires no acknowledgement. Headless/CLI/portable/Docker startup
must print a one-time notice and record its inventory revision before Lite sends.
An updated Lite inventory requires showing the updated notice. The daily sender implements that notice and startup behavior; desktop sidecars
retain the UI receipt gate.

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
with the publisher ID and UTC `YYYY-MM`. It rotates monthly and is never account-derived. No account
files are read for telemetry. Identity is accessed only after Full admission and
an endpoint is configured. Lite cannot reuse this identity. Keep retry batches
within their identity period in a future durable sender; receivers cannot treat
this as a permanent installation or person count.

Lowering a tier or uninstalling a plugin may offer an optional one-tap reason:
privacy, too-much-data, performance, not-useful, unexpected, other, or skip.
Feedback is an explicit, identifier-free action to that publisher only. Skip
means no feedback transmission; it must not create another background signal.

## Transparency and receivers

The daily sender records sent payloads and coalesced dropped-observation counts
with publisher, tier, outcome and reason in a local ledger. It retains at most
30 days and 5 MiB, evicting oldest first, and is exposed through an authenticated
API and `station telemetry outbox`. Settings presents the latest 50 records per publisher, with sent JSON and
reason/count-only presentation for suppressed or dropped records.
`station telemetry status` and `station telemetry set <publisher> <tier>` use the
running Station's authenticated APIs and report effective policy reasons.

A receiver must accept Lite without an installation secret: official binaries
cannot keep a shared secret. Use a public per-channel source identifier, strict
schema validation, bounded requests and in-memory rate limits keyed by a daily
salted hash of IP. Never persist IPs or user agents, including proxy/access logs,
error reporting, backups, and derived raw request records. Rotate and discard
the salt and rate-limit state daily. A public aggregates API and static dashboard
must suppress every bucket below k=10, including combinations and differencing
queries. Plugin/distribution aggregate access uses scoped publisher keys.
These are requirements for the receiver lane, not properties proved for the
existing private broker by this foundation.

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
Kontour URL. An empty build constant leaves the author sender inert.

Do not deploy the broker, set that repository variable, publish artifacts, or
enable real traffic as part of this program's implementation lanes. Each is an
owner-gated action. Receiver/proxy retention review, public disclosure and store
classification approval, endpoint enablement, and end-to-end release qualification
remain separate from local source/tests and from this decision's acceptance.

## Consent repair after foundation review

Settings renders each status publisher's saved choice, with Off always
available. Effective resolution is shown separately, including DO_NOT_TRACK
and Full awaiting acknowledgement. Declining Full writes operator Off before
acknowledging the inventory; acknowledging alone must not turn a pending saved
Full choice into consent after an Off decision.

Environment and baked defaults are policy, never explicit consent. Even
`STATION_TELEMETRY_TIER=full` and legacy environment `true` resolve to at most
Lite, with reason `environment`. A saved choice wins over defaults; DNT still
forces Off. Status includes each publisher's source and saved `userChoice`.
The top-level source remains the operator compatibility projection.

After migration `telemetryTier` is the sole persisted authority. Legacy boolean
writes translate into tier changes and are not retained beside the map. An
agent cannot change a choice. A standard paired device may lower a tier,
including to Off; raising requires the operator or `access:manage`. The route
compares with the state it replaces inside the serialized mutation. Reset
preserves tier choices. Kontour Full is refused until a Kontour disclosure
exists; operator acknowledgement cannot authorize another publisher.

### Disclosure and wire revisions

Full disclosure wording revision 2 resets existing acknowledgements because the
earlier lede overstated anonymity: Full events are pseudonymous, with a monthly
installation hash. `FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION` hashes this wording
revision together with the event/property/envelope inventory. The existing
`USAGE_TELEMETRY_INVENTORY_REVISION` export remains for compatibility but is
deprecated in favor of the explicit acknowledgement name for receipts and the
disclosure API. A saved operator Full choice remains pending
until the accurate disclosure is acknowledged again.

`PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION` hashes only the data inventory and
belongs in batches and probes. Receiver parser names remain unchanged. A
wording-only bump changes acknowledgement validity without changing wire
compatibility. Lite notice revisions are independent. Broker and Station must
ship together when the data inventory wire revision changes: an older broker
rejects the new revision, and this foundation has no legacy wire fallback.

### Choices while Do Not Track is active

DNT itself never changes saved choices. While it is active, the disclosure
leads with the fact that nothing is sent and that Full still needs confirmation
after DNT is removed. It offers visible **Off**, **Lite**, and **Full** radio
choices and a save action named **Save operator choice as** the selected tier.
Saving writes only that operator tier, without a disclosure acknowledgement.
Saving Lite preserves a saved-Lite user's choice. Saving Full leaves Full
pending: removing DNT shows the unacknowledged dialog again, and no Full event
is admitted until the person allows it. Every successful Save closes the dialog
and records a local, host-bound decision for the current disclosure revision,
without acknowledging it. It stays closed across reloads while DNT is active.
After DNT is removed, only saved Full re-prompts for confirmation; saved Off or
Lite does not, since neither requires acknowledgement. A new disclosure revision
re-prompts. This decision record is separate from the timed “Not now” snooze;
the service and acknowledgement route also refuse acknowledgement under DNT.

Known residual: operator and `access:manage` callers can submit full tier maps
without compare-and-swap. Serialized per-publisher merging preserves omitted
publishers, but a stale full-map write can replace another caller's intervening
choice. This foundation does not add conflict detection for those callers.


The Lite sender reports only yesterday's completed UTC snapshot, with no backlog.
Non-desktop starts use a first-start log notice even when a UI port is configured;
the CLI mirrors new notices to its launching terminal. Desktop starts retain the
UI notice gate. Unknown channel, distribution and layout-customization facts are
explicit `unknown` values, and the changed Lite inventory invalidates old notices.

Full IDs now hash `install_secret || publisherId || YYYY-MM`, separating Kontour
and operator within the month. This disclosed envelope change also resets Full
receipts independently of wording revision 2. Tier-change requests can include an
optional fixed-enum reason, sent once before the lower choice is applied,
including Off. Standalone feedback requires a lowering within 10 minutes and is
limited to one per publisher per UTC day. DNT permits neither path.

### Lite notice and feedback presentation

The kernel-owned desktop/web Lite notice is non-modal and records its current
publisher/revision only after visible presentation, without adding a blocking
first-run step. DNT hides it and refuses notice writes. An inline Off control
remains available. Status projects persisted Lite receipts so reloads and
server restarts do not cause a second notice for the same inventory.

Settings derives publisher rows from status, preserving a separate draft choice
and optional fixed-enum reason for each publisher. Save sends each edited
publisher with its reason in the same config write; Skip transmits no feedback.
The disclosure dialog uses the same optional prompt before its existing
write-before-acknowledge order. DNT offers neither reason prompt. Kontour Full
remains unavailable in the UI until its separate destination-bound disclosure
journey is implemented. Registry publisher registration/storage remains another
lane; generic presentation alone does not register one.
