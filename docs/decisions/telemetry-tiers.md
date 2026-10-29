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
CLI/log notices. The UI lane adds one usage-sharing choice, current-revision author consent, ledger
presentation, and optional lowering reasons. Official release workflows can inject
the configured author endpoint. Plugin publishers, receiver changes, dashboards,
endpoint enablement and deployment remain separate lanes. This decision does not
assert that any of them is deployed.
The numbered ADR directory is frozen; new decisions use this topic-keyed record.

## Consent and publishers

Each publisher has its own Off, Lite, or Full choice. `kontour` is the app author;
`operator` is the existing configured product receiver; `publisher:<registry-key-digest>/<registry item id>`
identifies a plugin or distribution publisher. The two built-in choices are
stored in `telemetryTier` in Station configuration. Plugin publisher registration and storage use verified signed public-registry
installations; distribution manifest loading remains future work. Sinks are independent: an operator endpoint never
replaces, disables or grants consent to an author endpoint.

Off stops telemetry for that publisher, including plugin uninstall feedback. Built-in publishers retain the explicit lowering-feedback exception described below. Kontour and operator default to Lite: one identifier-free
daily aggregate per publisher, after clear notice and with an always-available
Off switch. It requires no acknowledgement. Headless/CLI/portable/Docker startup
must print a one-time notice and record its inventory revision before Lite sends.
An updated Lite inventory requires showing the updated notice. The daily sender implements that notice and startup behavior; desktop sidecars
retain the UI receipt gate.

Third-party plugin publishers default **Off**. A notice is an opt-in prompt: choose Lite, Full, or keep Off. Recording a notice does not enable sending. Station adds no identifier to plugin Lite, but plugin-chosen counts within the declared inventory can encode a stable identifier; plugin Lite is not identifier-free. Operator policy cannot raise this default.

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
the salt and rate-limit state daily.

Owner decision (2026-10-17): Kontour's analytics view is **exact and operator-only**.
`/v1/operator/lite/daily` and `/weekly` require the private `sto_` key and expose
exact per-publisher marginals from `lite_marginals`. Daily contributor counts are
distinct daily network keys. Weekly counts sum contributor-days: salts rotate
daily, so weekly unique contributors cannot be deduplicated without changing the
linkability contract. Both endpoints reject query filters and use `no-store`.

Published public-dashboard and third-party publisher views release **weekly**
ISO-8601 UTC-arrival totals, with noisy estimates over ten profile/adoption
fields: channel, version, platform, arch, surfaces_today, engines_used_today,
first_active_this_week, first_active_this_month, distribution and
public_plugins_enabled. Counters/friction and customization remain private.
The fixed public domain contains all enum/boolean/empty-set values and each
publisher's operator-configured public release versions/registry IDs. Custom
version/distribution values collapse to `custom`. Every coordinate, even true
zero, always receives noise. There is no true k=10 pre-filter or presence oracle.
Catalogs must be public configuration independent of private observations.
Publisher keys see only their publisher's domain. Bounded 200-cell keyset pages
replace the prior 10,000-row published cap; publisher-scoped HMAC cursors navigate, never filter. Forged cursors return 400
before they can occupy or evict cached pages.

Published counts sum **distinct daily contributor keys per value** (`clients`),
not raw pings. They measure network-days: each IPv4 or IPv6 /48 network contributes
at most one per value/UTC day and seven per value/UTC week. Installs sharing a
network count once per value/day, so NAT undercounts installations. Exact
operator views retain pings and clients separately.

Adding/removing one ping changes at most seven scalar counts plus five surfaces,
eight engines and twenty public plugins: **sensitivity 40**. Per-count ε=1/280
composes to **ε≤1/7 per added ping**. For a network with at most 40 distinct
coordinates per day, network-week L1 sensitivity is **7×40=280**, giving
**ε≤1**. Distinct daily keys enforce the per-value cap, not that total-coordinate
premise: variable pings can cover more than 40 values. The unconditional
network-week bound is **7D/280=D/40** for a fixed public domain of D coordinates;
responses compute a conservative bound from the largest stored domain in their
four-week window. No installation identity or unconditional install-week ε≤1
claim is available. Replacement doubles add/remove bounds. Multiple weeks and
publishers compose.

The ideal fixed-domain two-sided geometric mechanism is **pure ε-DP**. The
persistent-key HMAC implementation uses finite 52-bit uniforms; cryptographic
and finite-precision qualifications apply to the implementation. Prior exact
or thresholded releases remain exposed.

Unclamped expected absolute noise is ≈280 weekly network-days (95% ≤839). Clamping at
zero improves absolute error near zero while introducing upward bias. Utility
for a value present in every daily network contribution is:

| Daily networks | Weekly network-days | MAE | Relative MAE | 95% absolute error / weekly total |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 700 | ≈280 | 40% | 839 / 120% |
| 1,000 | 7,000 | ≈280 | 4% | 839 / 12% |
| 10,000 | 70,000 | ≈280 | 0.4% | 839 / 1.2% |

Sparse values can be uninformative. Overlapping set histograms cannot be summed
or joined. Calendar flags count network-days carrying that flag, not distinct people.

Migration 6 stores immutable publisher/week markers and every published cell.
Finalization sums daily clients per value once per closed week and snapshots the
public domain. Public/publisher reads and reopen reuse the stored estimates.
The HMAC coordinate includes publisher, week, dimension and value, never count;
a changed-count re-release would reveal an exact difference and is forbidden.
Back up markers, cells and the migration-5 secret together; never regenerate
historical publications. Restrict database/service/backup access; the secret's
`PUBLIC` privileges are revoked. There is no rotation/republication endpoint.
Compromise reveals the noise.

Closed-day exact marginal work commits per dimension. Erasure runs in bounded
batches for each completed publisher/day; a stuck dimension retains only that
publisher/day's associations while others progress. Raw/Full retention runs
independently. Reads serve stored publications and finalized days without
running finalization. Operator diagnostics record skipped daily/weekly jobs.
Publication uses the captured cutoff and arrival fence; a pass crossing from
Sunday into Monday waits for the next pass to publish that week. Public pages
cache for at most 60 seconds and reset at UTC midnight. Snapshot
refresh failure beyond 60 seconds returns 503, not unauthorized; fresh revoked
keys are still refused immediately by database checks. These local receiver
behaviors do not establish deployed privacy, proxy logging policy or an installed
Station sender. See the [receiver contract and verification](../../packages/telemetry-broker/README.md#public-aggregates).

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
Official release workflows inject an owner-managed repository variable when
configured; see [author telemetry in official builds](../guides/release-rings.md#author-telemetry-in-official-builds).
Fork, development and Docker workflows must leave it empty unless
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
and Full awaiting acknowledgement. The current combined Don't share action saves
both built-in destinations Off without acknowledging Detailed. The legacy
disclosure path retains its write-Off-before-acknowledge repair; acknowledging
alone must not turn a pending saved Full choice into consent after an Off decision.

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
limited to one per publisher per UTC day, sharing that budget with inline
tier-lowering reasons. DNT permits neither path.

### Usage sharing presentation

One first-run dialog presents Don't share, Anonymous usage counts (the default),
and Detailed usage to help improve Station. It covers Kontour and a configured
additional endpoint together; plugin destinations remain outside first-run.
Closing or Not now keeps the current choice and records the shown notice, so
anonymous counts remain suppressed until a visibly presented prompt is explicitly
acted on. Merely viewing it or Privacy & sharing records nothing. Save persists
the choice first, then records the notice; Off stays blocked throughout. Printed
CLI/headless notices retain their existing shown semantics.
DNT explains that nothing is shared and that the choice applies if it is disabled;
existing notice-write and acknowledgement restrictions still apply.

Detailed begins with a readable summary. The complete field definitions remain
under collapsed Technical details and acknowledgement binds the same server
revision. Saving Detailed acknowledges the current destination and revision before
saving the preference. The config route admits a new Kontour Full preference only
when the runtime confirms that acknowledgement; absent capability refuses it.
DNT or an absent destination can retain a pending preference without emission.
Agent and paired-device authority checks remain independent of acknowledgement.

Privacy & sharing uses the same combined primary choice, staged behind the
standard Save/Discard actions. Advanced keeps independent destination choices and
optional fixed-enum feedback. Skip sends nothing, and DNT offers no reason prompt.
Registry registration/storage remains a separate owner; presentation does not
register third-party destinations.

### Plugin publisher implementation

Plugin telemetry declarations now use the shared bounded publisher schema. Because
registry signature receipts do not classify catalog visibility, operators must
explicitly list public catalog source keys in `publicTelemetryRegistries`. Signature
verification and matching registry item identity are independently required.
`telemetryPublisherPolicy` feeds the foundation resolver and can only lower defaults.
The authoring API uses a Pane-scoped `useTelemetry()` or explicit
`createPluginTelemetry(apiBase, paneCapability)`; the kernel mints a five-minute,
unforgeable token per mounted Pane, bound to plugin, namespaced publisher, installation
generation and declaration revision. Only the token attributes counts; plugin headers
confer no count authority. Agent principals cannot count. Pane-marked requests and
capability-bearing requests cannot raise tiers, acknowledge Full, or write notice
receipts.

These Pane-context checks prevent accidental or well-behaved SDK misuse. They recognize
only the explicit `x-station-plugin-capability` and `x-station-plugin` headers; browser
fetch/XHR requests use `Sec-Fetch-Dest: empty`, which provides no Pane identity.
Same-origin plugin code shares the existing shell trust model: it can omit those
headers, call shell APIs, raise its telemetry tier, mint Pane tokens, and read the
shared query cache. It can also mint tokens under another plugin’s name to evict that
plugin’s live tokens within the 16-token limit. Distinct-origin isolation is tracked
in [#3826](https://github.com/kontourai/station/issues/3826).

Legacy ambient count/track and automatic instrument() observations are no-ops; development instrumentation warns. Kernel consent surfaces retain
their ownership and appearance. Broker acceptance and distribution manifest
loading remain deferred; no deployment or real endpoint is enabled.

Plugin destinations reject non-public literal hosts during declaration parsing. Before every send the shared development-proxy validator checks every DNS answer; the HTTPS connection is pinned to one validated address with TLS hostname verification. Redirects are refused. Each publisher admits at most 100 count requests and 100 Full observations per UTC day. Full delivery batches queued observations into one request per flush without retries. Dropped observations coalesce in the outbox per publisher/day/reason. Uninstall synchronously fences ordinary sends and aborts active requests before asynchronous withdrawal; Off and DNT suppress explicit uninstall reasons.

Pane telemetry capabilities are limited to 16 live tokens per plugin, with the oldest
token evicted when another is minted; a global 1024-token limit also applies. An aborted
uninstall restores persisted telemetry state and permits fresh tokens, while sends
admitted before withdrawal stay fenced.
