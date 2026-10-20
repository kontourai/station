# Usage telemetry

Station product telemetry is server-side only and sends no prompts, paths, repository names, hostnames, branches, account identities, or other free text. It does not read third-party vendor configuration or credential homes.

First run asks one usage-sharing question, with three equally presented choices.
A fresh install preselects Anonymous usage counts. Reopened prompts use the
existing saved choices, including a Detailed preference awaiting renewed
confirmation. If the two destinations differ, no option is selected and Save
is disabled until an option is chosen; Not now keeps the separate choices.
Initial keyboard focus goes to the selected radio, or the first radio when
none is selected. Settings → Privacy & sharing uses the same labels:

| Display label | Config/API/CLI value | Meaning |
| --- | --- | --- |
| Don't share | `off` | No automatic usage sharing. |
| Anonymous usage counts | `lite` | One daily aggregate, without an installation ID, account identity or content. A current shown-notice record is required. |
| Detailed usage to help improve Station | `full` | Classified usage events with a monthly rotating installation code. Selecting this choice shows What's included; saving acknowledges that displayed revision before enabling detailed sharing. |

Each choice has a short explanation and the same row spacing. Detailed's
**What's included** begins with a short list: app/build and device information,
feature and connection outcomes, a destination-specific monthly code, and the
account/content/path information that is never collected. The full server-owned
field definitions remain available in a nested, initially collapsed
**Technical details** disclosure. Its position does not change the revision
that Save acknowledges.

Settings changes are drafts, not saves on selection. Choosing an option reveals
the standard **Save / Discard** bar. Detailed shows the same inline explanation
as first run and says to select **Save** to confirm. Only that Save action sends
the required acknowledgements and writes the choice; the Settings intro does
not send users back to the page they are already on.

The primary choice applies to Kontour and the configured additional destination.
Saving Detailed acknowledges each configured built-in destination separately
before storing `full` for both. Kontour's acknowledgement is bound to its
build-provided address as well as the displayed definition revision. Without a
Kontour address, its stored choice cannot produce traffic; a newly configured
or changed address requires review again. An additional configured endpoint is introduced as **Also shared with:
&lt;host&gt;**, without its path, credentials or query. The disclosure projects only the additional host for environment-configured addresses too; full addresses stay out of that response. Third-party destinations
are excluded from first run. Their separate controls, existing built-in choices,
connection details and local history live in the collapsed **Advanced** section.
Advanced retains independent choices and the same three option labels. Importing a `full` setting does not acknowledge unseen details. Settings requires an explicit Detailed choice bound to the displayed revision before it creates that acknowledgement; a changed revision requires choosing Detailed again.

**Not now**, close, Escape and backdrop dismissal preserve the existing setting
(the new-install default is `lite`). Merely displaying the dialog, even past
its ten-second send interval, records nothing and does not enable daily counts.
A notice is recorded only after an interaction with the visibly presented
surface: Save choice, Not now, close, Escape or backdrop dismissal. Save first
persists the chosen preference, then records the displayed notice revision;
saving Don't share therefore cannot temporarily enable a count. A failed choice
save records no notice. A failed notice write leaves the saved preference intact,
reports that separate failure and keeps counts paused. Viewing Privacy & sharing
also records nothing; its Save action records a notice only for its visibly
presented sharing section. Hidden or covered surfaces cannot supply that evidence.
DNT still refuses notice writes. CLI/headless starts are unchanged: printing
the notice counts as showing it. A status fetch alone never records presentation. A current
notice prevents another prompt on remount; a changed notice revision prompts
again. Off remains available in Settings. Resetting Station settings preserves
sharing choices.

When Do Not Track is on, the shared callout says: “Do Not Track is on, so nothing
is shared. The choice below applies if you turn it off.” Saving records the
chosen setting for both built-in destinations without creating an acknowledgement.
A Detailed choice without a current acknowledgement remains pending after Do
Not Track is removed; a previously valid acknowledgement retains its existing
meaning. Save failures use the existing page-callout tone system and leave the
choice available to retry or dismiss.

The app-wide disclosure stays closed when both effective publishers are Off
and no product endpoint is configured. After a successful Off/Lite save, a
device refused acknowledgement remembers a local decision for this host and
disclosure revision across reloads. It does not create a server receipt or
authorize Full; a changed revision or a saved Full choice prompts again.
Setting-save failures show the server's refusal message.

A standard paired device may lower or keep tiers. Only the operator or
a device with `access:manage` may raise tiers. Agent-originated requests cannot
change telemetry choices or acknowledge the
disclosure, even with `access:manage`.
`STATION_TELEMETRY_TIER` and the legacy boolean environment aliases supply
defaults, reported as `environment`, and cannot grant Full. Hosts that previously
relied on `STATION_PRODUCT_TELEMETRY_ENABLED=true` (or its legacy alias) plus a
receipt now resolve to Lite and stop Full delivery. Lite uses the completed-day
sender described below. To resume Full events, explicitly choose operator Full in
Settings or run `station telemetry set operator full`, then acknowledge the
current disclosure in Settings. Explicit stored choices take precedence over
environment defaults; DO_NOT_TRACK always wins.
After migration only `telemetryTier` is persisted. Legacy boolean writes are
translated into tier changes under the same authorization rules.

## Disclosure and activation

Telemetry has per-publisher `off`, `lite`, and `full` tiers. Lite is the default;
Off permits no product traffic to that publisher, and Full requires explicit choice
and the current disclosure receipt. `DO_NOT_TRACK` with any value except empty or
`0` forces Off for every publisher. Saved `telemetryTier` choices precede
`STATION_TELEMETRY_TIER`, then the legacy product-enabled aliases.
Distribution/operator policies can lower the default, never raise it to Full;
explicit user choice wins except for DNT and the Full disclosure requirement.

The server sends independently to the `kontour` build-time author address and
`operator` configured address, each under its own resolved tier. Neither address
replaces the other. An empty author build constant is inert, including when a
runtime environment variable of the same name is supplied. Source builds have
no author address. Official release producers can bake the public endpoint only through the
[owner-gated build variable](../guides/release-rings.md#author-telemetry-in-official-builds);
leaving it unset preserves the empty constant. No real receiver is enabled by this change.
The existing Full acknowledgement covers operator only. Author Full requires a
separate receipt bound to Kontour, the current inventory and the displayed
build destination. The shared dialog and Settings save each required acknowledgement before
changing either built-in preference to Full. A refusal prevents the preference
write; an acknowledgement for one destination never authorizes the other.

Every non-desktop server, including `station start`, `service run`, Docker and
web servers with a UI port, prints one combined anonymous-usage notice for the
current revision through the [unfiltered stderr notice path](../../src-server/utils/logger.ts).
It retains a separate shown-notice record for each built-in destination before
sending. The launching CLI prints the combined notice after readiness when its
pre-launch state lacks a current record. The server records its log notice
asynchronously; HTTP readiness does not imply it is already written. Unattended
services retain the notice in their logs. Logged and visibly rendered notices
are distinct presentation paths. `station telemetry status` uses the same display
labels, with `off|lite|full` shown in parentheses; accepted command values remain
unchanged.

Desktop sidecars (`STATION_STDOUT_HANDSHAKE=1`) defer to the single UI choice.
Until it records the shown revision with `POST /api/usage-telemetry/lite-notices`,
daily payloads stay suppressed with reason `notice`. A current record survives
restart and the daily timer starts without another UI call. An updated field
revision requires another notice. The body remains
`{ "publisher": "operator", "inventoryRevision": "<shown revision>" }`.
The status API exposes persisted `liteNotices` per destination. The UI records
only while its choice surface is in the viewport, the document is visible and
no other modal covers it; its own dialog is the presentation. DNT and non-Lite
states still refuse notice records. A failed write leaves counts suppressed.
No separate floating notice or JSON field dump is rendered. Detailed choices
in first run and Settings share the readable What's included component.
Distributions do not supply this copy or its controls.

A saved legacy false migrates to Off for both built-in publishers. Saved true
with a current receipt migrates to operator Full; without it, operator Lite.
Kontour remains Lite when migrating true because an operator disclosure cannot
authorize a different publisher. New inventory fields invalidate old receipts.
The legacy boolean remains an input for older clients, including withdrawal;
`telemetryTier` is the canonical setting. Lite requires clear notice and an
always-visible Off switch; headless builds record a shown notice revision
before sending. A Lite inventory change requires a new notice, while a Full
inventory change requires a new acknowledgement.

Use `station telemetry status` to read effective tiers and reasons (`DNT`,
`policy`, `default`, `user`, `disclosure`, `environment`) from a running Station. Use
`station telemetry set operator off` or `station telemetry set kontour lite`
to save a single publisher choice. Requesting Full without its receipt remains
Lite. These commands support the normal target/credential flags. The status API also
returns the exact Lite field catalog alongside its revision so a notice consumer
can display the server inventory rather than an older bundled copy. Use `station telemetry outbox` or
`station telemetry outbox --publisher operator` to inspect the bounded ledger.
Settings always exposes Kontour and Operator controls, plus any registered publisher. A failed status read is shown explicitly; Full stays disabled unless status reports `fullAvailable: true` for that publisher. Older servers without this field leave Full disabled.
Settings exposes a collapsed **What was sent to {publisher}** section below each publisher’s tier row, showing
the newest 50 records for that publisher and an explicit empty/error state.
Sent entries have a collapsible JSON viewer. Unsent entries expose only their
reason and observation count, with Off/DNT/disclosure/notice/unconfigured
classified as suppressed and transport/overflow/expired as dropped. There is no
payload viewer for either unsent category. Refresh reads the current ledger.
Opening status/outbox views refetches their current data. Tier writes refresh
both views, including after a partial Settings failure; Full acknowledgement
refreshes effective status again, so a cached Lite label does not outlive Off
or a newly admitted Full choice.

The acknowledgement POST must include acknowledgementProtocol:2 and the inventoryRevision the UI displayed. Missing/unsupported acknowledgement versions return 426 with update guidance; a missing revision returns 400 and a stale revision returns 409; an older UI cannot acknowledge metadata it does not display. The service also refuses a mismatched revision before writing. The handshake and disclosure publish this feature version; client/server protocol2 retains core protocol1 admission. An older installed UI only shows its existing generic acknowledgement failure until updated. New metadata stays inactive; no legacy sender fallback runs on this host. For author Full, read `GET /api/usage-telemetry/disclosure?publisher=kontour` and
include `publisher:kontour` and its exact `destination` in the acknowledgement POST.
An absent author build address or changed displayed destination returns 409.
The author receipt is `STATION_HOME/config/usage-telemetry-disclosure-kontour.json`;
an operator receipt cannot authorize it. The default selector remains operator.

A receipt records its acknowledgement timestamp and the SHA-256 revision of this inventory under `STATION_HOME/config/usage-telemetry-disclosure.json`. A changed inventory invalidates an older receipt and stops emission until it is shown and acknowledged again: new data must not leave before the user has seen it.

Full disclosure wording revision 2 participates only in the acknowledgement hash;
batches and probes use the separate data inventory revision. Existing
acknowledgements were reset because the earlier lede overstated anonymity; the
accurate pseudonymous disclosure must be acknowledged again before Full resumes.
Under DNT, the disclosure offers Off, Lite, and Full saves without writing an
acknowledgement. Full saved this way remains pending; after DNT is removed the
dialog appears again and sends nothing until Full is allowed. The acknowledgement
API returns 409 while DNT is active.

See the [decision and full-map concurrency limitation](../decisions/telemetry-tiers.md#consent-repair-after-foundation-review).

When an operator configures `STATION_PRODUCT_TELEMETRY_ENDPOINT`, Station POSTs
batches directly to that full address. It does not append an ingestion path.
`STATION_PRODUCT_TELEMETRY_KEY`, when set, is sent only on Full requests as that endpoint's
`x-api-key` header. `STATION_OTEL_API_KEY` remains exclusive to OTLP exports.
The legacy product aliases are `STATION_TELEMETRY_ENDPOINT` and
`STATION_USAGE_TELEMETRY_KEY`; the legacy OTLP key is
`STATION_TELEMETRY_API_KEY`. A valid nonempty canonical value wins over its
same-destination alias. Blank values are absent; invalid boolean values are
ignored before trying the alias and default. Bootstrap notices name invalid,
legacy or conflicting variables without printing their values. Aliases remain
supported until a separate release decision removes them; neither destination
ever falls back to the other destination's key.

Full telemetry is pseudonymous, not anonymous. Its installation hash rotates
monthly and is never linked to an account by Station. The Full payload carries
SHA-256 of a random UUID concatenated with the publisher ID and UTC `YYYY-MM`. Upgrading from the permanent `sha256(uuid)` scheme immediately changes existing receivers’ `distinct_id`; historical installation series do not continue under the new ID. Station does not send a migration link. The UUID is persisted at
`STATION_HOME/config/usage-telemetry-id`; the raw UUID never leaves the process.

Full `occurred_at` and `observed_at` are rounded down to the UTC minute to reduce cross-publisher correlation. Unknown Full channels are omitted; runtime `beta` maps to `preview`. The broker deduplicates by source and `event_id`, not timestamps; its reporting groups by day. Other shared facts can still correlate pseudonymous Full events.

## Daily aggregates and observation limits

The daily sender reserves at most one attempt per UTC calendar day per publisher
in `STATION_HOME/config/telemetry-daily.json`, before network I/O. It checks on
the service flush interval. Reopening the service or concurrent flushes reuse
that reservation. A failed or suppressed attempt is recorded and is not retried
that day. This deliberately favors avoiding duplicate counts over delivery.
Only the completed previous UTC day's snapshot is eligible: observations on
day 1 are sent on day 2, never during day 1. After a gap, only yesterday can be
sent; older observed days are discarded instead of replaying a backlog. A
backward clock correction resets future reservations so they cannot prevent
current-day sending. Weekly and monthly flags use
UTC Monday weeks and calendar months, with first-run and last-active dates kept
only locally. Those flags are estimates under delivery loss and state resets.
The atomic local state is capped at 16 KiB and stores bounded daily sets, counters,
notice receipts, and one previous-day snapshot. Raw dates never enter a Lite body.

The contract validator checks every outgoing daily field. Current sources are:

| Field | Server observation or conservative value |
| --- | --- |
| version | The running package version when it is valid SemVer within the 64-character bound; otherwise `custom`. Receivers default to a configured release list; an explicit SemVer policy can admit valid versions plus `custom` without expanding the public version domain. Version alone cannot establish an official build: source/fork builds can reuse a release version. |
| channel/platform/arch | `captureBuildProvenance(env)?.channel` (baked `__STATION_SERVER_BUILD__.channel`, then existing runtime metadata), server OS and CPU. At daily serialization, the shared `mapRuntimeChannelToTelemetryChannel` maps runtime `beta` to the Lite schema's `preview` and preserves permitted labels; missing or unrecognized provenance becomes `unknown`. |
| surfaces_today | Reported web/desktop/CLI origin on an authenticated `/events` connection. This is reported metadata, not device attestation. Missing/unknown/mobile origins are omitted because the current mobile header does not distinguish iOS and Android. |
| first_active_this_week/month, install_age_bucket | Local observed activity dates. Age starts when this telemetry state is first created; an existing install without that state starts at `0d`. This is not historical OS/package installation age. |
| engines_used_today | Existing engine-turn terminal observations. |
| paired_devices_bucket | The pairing service's current device store. |
| distribution/public_plugins_enabled | `unknown` / empty set: no authoritative public telemetry catalog or distribution manifest consumer exists. Layout-source profiles are not distribution identities. |
| private_plugins_bucket | Valid installed plugin manifests; unverified-public packages are counted conservatively as private. No names leave the machine. |
| branding_overridden | Resolved branding name/logo/theme/welcome differs from built-in empty/default branding. |
| home_replaced | A currently valid granted workspace Home role. |
| layouts_customized | `unknown`: no reliable persisted customization marker; saved default layout copies are not evidence of customization. |
| setup_abandoned_step | `none`: no server-owned setup-abandonment producer. |
| engine_connect_failures | Empty until a classified engine-connect-failure observation is available; a failed turn is not invented as a connection failure. |
| safe_mode_entered/plugin_disabled_after_crash | Zero: no safe-mode or crash-disable lifecycle producer exists today. |

Lite and feedback requests send no Full API key or secret-binding credential:
a per-install authentication key could otherwise join anonymous days. Receivers
for these bodies need the separate anonymous admission path.

Full adds server-observed plugin install/remove, settings-category changes
(`privacy` for product tier/destination settings and `other` for remaining app configuration), and the authenticated
connection observations above to the existing startup/recovery/turn stream.
Unverified-public plugin IDs become `custom`. Pane-open events belong to the UI;
setup abandonment, safe mode, crash disables and engine connection-failure
producers remain unwired rather than guessed from unrelated events.

Inline tier-lowering reasons and standalone feedback share one persisted budget per publisher per UTC day, reserved after validation and before sending. A failed send still consumes that day’s budget. Invalid feedback does not consume it.

## Local ledger and feedback

`GET /api/usage-telemetry/outbox?publisher=operator&limit=50` and the CLI show the payload,
publisher, tier, timestamp, sent/dropped outcome, and classified reason. The ledger
is `STATION_HOME/config/telemetry-outbox.json`, retained for at most 30 days and
5 MiB of actual serialized bytes, oldest first. Reads also enforce retention. The HTTP API returns the newest 50 records by default; `limit` accepts integers from 1 to 200 and rejects values outside that range with 400. Publisher filtering happens before the limit. Settings requests 50 and uses the same authority scope as its status read.
It is an audit log, not a retry spool. Dropped Full observations are coalesced
in memory, then published at the flush interval, on outbox reads, and at shutdown
as `telemetry_dropped` counts per publisher, reason and UTC day. A process crash
before that publication can lose pending dropped counts. Suppressed traffic
never creates an installation secret. Sent Full payloads retain their exact
batch and event IDs. A Lite/feedback `sent` record means HTTP 2xx, including a
response received after a tier change; only Full's commit receipt proves the
receiver acknowledged event storage.

Agent principals cannot submit user feedback or attest that a Lite notice was
shown. Both writes require the existing `access:manage` authority.

`PUT /config/app` may carry `telemetryFeedbackReason` alongside a `telemetryTier`
change. Reasons are `privacy`, `too-much-data`, `performance`, `not-useful`,
`unexpected`, `other`, or `skip`. Inside the serialized config mutation, each
publisher whose tier actually decreases records a lowering and sends its
optional reason before the new choice is persisted and applied, including Off.
Feedback persistence or transport failure never prevents applying the lower tier.
An unchanged or raised choice sends no reason. A repeated request cannot replay
the reason. DNT suppresses the signal and does not record a feedback window.
Settings offers the fixed reasons and Skip when lowering a publisher's choice;
the comparison uses the saved tier, so editing an unsaved raise back down is not a lowering. The pending tier stays visible in the selector and is named in the reason prompt. The reason is staged until Save. Cancel or Escape closes the Settings prompt, restores the prior draft tier and focus, and sends nothing. Each edited publisher is written independently,
with its optional reason in that same config request, preserving omitted
publishers. Successful writes are marked saved even if a later write fails; the error identifies a partial save and retry includes only unsaved changes. The Full disclosure dialog offers the same optional prompt before
its write-then-acknowledge sequence. Skip sends no feedback, and no prompt is
offered under DNT. Failed writes do not acknowledge. Feedback is action metadata,
not a persisted setting. The optional prompt focuses its heading once when
opened and returns keyboard focus to the Settings tier control after a reason
or Skip is chosen. A failed dialog setting write focuses its error so keyboard users can find the retry actions.

`POST /api/usage-telemetry/feedback` accepts exactly publisher (`kontour` or
`operator`), action and a fixed-enum reason. Non-skip reasons require action
`tier-lowered`, a server-recorded lowering within the last 10 minutes, no prior
reason for that change, and no inline or standalone reason for that publisher that UTC
day. Otherwise it returns 409. It can send the explicitly requested reason
while the resulting tier is Off; DNT always refuses it. Plugin uninstall feedback
is unavailable until a publisher-specific uninstall action records authority.
Skip sends nothing; the standalone endpoint rejects it with 400. IDs, extra fields
and free text are rejected with 400. Direct service rejection returns false;
a recorded rejection contains only a content-free dropped count with reason
`invalid`, never the raw payload. Feedback and shown-notice writes require `access:manage`; agents cannot send them. Ledger
reads require `orchestration:read`, under the authenticated usage-telemetry route
family. Feedback contains no installation ID.

## Delivery status and connection checks

Settings → Telemetry shows the connected Station's current-process queue,
acknowledged observations, failed attempts and discarded observations. These
are process counters, not lifetime accounting or a durable spool. A product
batch leaves the queue only after a matching `station-product-commit/v1`
receipt covers its exact event IDs and counts. Generic 2xx responses, malformed
receipts, refused redirects and bounded-response failures retain the batch for
retry with the same IDs. The latest failed attempt remains visible alongside
historical success. Refreshing or unavailable status hides cached success.

An operator's **Check connection** calls a separate
`station-product-probe/v1` source-key endpoint when the configured address has
the supported `/v1/product/events` shape. The probe verifies source authority
and compatible PostgreSQL schema/query readiness without inserting a source,
observation or commit receipt. It does not create an installation identifier or
acknowledge disclosure. Other address shapes report unsupported instead of
guessing a credential-bearing request path. Revoked keys and incompatible
storage fail. Probe readiness is distinct from an acknowledged usage event.

Status reads require `orchestration:read`; connection checks require
`access:manage`, including paired callers. Status responses contain presence
and counters, not addresses, credentials, source IDs or receipt IDs. Requests
and caches remain bound to the selected Station authority.

OTLP exporter callback acceptance and empty OTLP connection probes have their
own status. They do not establish downstream persistence or querying. Supported
deployment and full acceptance remain [#3458](https://github.com/kontourai/station/issues/3458)
and [#3464](https://github.com/kontourai/station/issues/3464).

The operator can save a full product address and an instance SecretBinding ID
in Settings. A saved address wins over the environment address and does not
inherit the environment key. A saved key reference requires an exact
`instance-telemetry-destination` product grant for that address. Missing,
revoked, person-owned or ungranted bindings fail without environment fallback.
Create the reference under Integrations → Advanced: Secret bindings, then use
Telemetry destination grants to choose an instance reference, a product receiver
or OTel collector, and the exact address. Existing grants can be removed there;
each change requires the reference's current revision and operator authority.
Selecting a reference or saving an address never grants it implicitly. A revoked
or person-owned reference cannot receive an instance destination grant.
Changing a destination or key reference withdraws queued observations bound to
the old destination, aborts/fences its attempts and clears its current health.
The config PUT applies this change from the validated persisted configuration
before awaiting Agent/provider activation. Disabling product telemetry also
withdraws queued observations at that boundary. A pending Agent activation
response does not defer telemetry withdrawal. Unchanged telemetry settings
preserve requests, queues and delivery health. External reconciliation applies
telemetry after its validated config read, before preparing Agents.
The HTTP listener can accept settings before the product service is constructed.
Late construction uses a validated, revisioned config snapshot and rechecks its
revision immediately before assigning the service. Three changed snapshots
refuse initialization; an older Agent boot snapshot cannot restore withdrawn
product sending. Later PUTs reach the assigned service before disclosure loading
finishes. This does not publish a new Agent generation.
External secret backend reads run through a deadline-owned Datum child; raw
keys never persist in AppConfig or appear in status.

Saved collector addresses and key references activate after Station restarts.
The bootstrap observes the saved address before synchronously registering OTel
providers; exporters wait for installation identity and exact OTLP credential
authority. Changing saved collector settings fences the old process's exports
and clears its current health; Settings reports restart required. A saved
collector address never inherits the environment key. Clear standard
`OTEL_EXPORTER_OTLP_HEADERS` and signal-specific header variables when using a
saved collector or key reference: the pinned SDK merges them, so Station
refuses that combination rather than forwarding them to a newly selected
destination. Legacy environment-only collector configuration retains those
standard headers. Product disclosure remains independent.

## What `distinct_id` is, and when it is not stable

`distinct_id` is SHA-256 of the random UUID at
`STATION_HOME/config/usage-telemetry-id` concatenated with the publisher ID and UTC `YYYY-MM`.
Kontour and operator therefore receive distinct IDs even in the same month.
It changes at a UTC month boundary, is never derived from accounts, and is
accessed only after Full admission. The raw UUID never leaves the process.
The persisted identifier helper reads back the destination after creation or
repair; corrupted files receive a fresh UUID by atomic replacement. Concurrent
repairs can temporarily split identity. Monthly rotation and repairs mean this
is neither a permanent installation identity nor a person count. OTLP uses its
separate existing identity and is unaffected by this Full rotation.

## Buffering, delivery and source

[UsageTelemetryService](../../src-server/services/usage-telemetry-service.ts)
accepts only the inventory's event/property vocabulary. Its memory buffer holds
100 events, dropping the oldest on overflow. It flushes batches of 20 at a
10-second interval or when a batch fills. A request has a one-second timeout;
failed batches remain in memory for a later attempt. There is no durable queue. Observation IDs and their producer times/build metadata
are assigned once and preserved on retry, so a receiver can deduplicate a
lost-response retry. The sender alone provides no exactly-once guarantee; the
receiver must commit and deduplicate by source/event identity. Disabling telemetry clears buffered events and aborts an active request;
it cannot retract data the endpoint already accepted. Shutdown attempts a
bounded flush and can drop unsent events.

The v1 batch and event shapes are published on
`@kontourai/station-contracts/product-telemetry`. The Node-only shared
`product-telemetry` helper renders/fingerprints the inventory and validates the
strict receiver boundary: bounded batches, exact fields, classified values,
canonical UTC timestamps and full hashes with explicit provenance. Unknown
versions, stale inventories and legacy batches are rejected. An older payload
has no deduplication/time/build guarantees and must not be assigned current
metadata or included in precise release comparisons. Legacy storage/queries,
if later supported, need their own explicit ingestion profile. No onboarding
funnel is inferred from startup. Startup, recovery and engine turns retain their
existing producers; plugin install/remove, persisted settings changes and
authenticated client connections add the server-owned observations described
above. Pane-open and currently unavailable classified friction producers remain
for their owning lanes.

The producers are
[runtime startup and plugin/config lifecycle](../../src-server/runtime/bootstrap/station-runtime.ts),
[authenticated connection/config routes](../../src-server/runtime/routes/runtime-routes.ts), and
[orchestration](../../src-server/services/orchestration/orchestration-service.ts).
The `station_started` call follows successful final registry-policy publication,
virtual application publication when configured, cancellation checks, and the
runtime's `ready` recording step in `StationRuntime.initialize()`. Failed or
canceled startup emits no completed-startup event. Delivery remains optional and does not delay boot;
the event is not replayed when disclosure is first acknowledged later. A failed
operational-event append is reported separately and is not a durable readiness
receipt merely because the runtime became usable.

The [cold-start regression](../../src-server/runtime/__tests__/runtime-cold-start-custom-agent.test.ts)
enters through `StationRuntime.initialize()` with restored disclosure and
success/failure controls at final policy publication, shutdown during that step
in local and virtual modes, and a failed virtual readiness callback. It observes producer order
and durable readiness; it does not establish live ingestion delivery.

[Publisher service](../../src-server/services/telemetry-publisher-service.ts) owns the
Lite/feedback senders; [local state](../../src-server/services/telemetry-local-state.ts)
owns their atomic persistence and the ledger.
[Publisher tests](../../src-server/services/__tests__/telemetry-publishers.test.ts) use
real HTTP receivers and writer-shaped files, including restart and eviction.
[Service tests](../../src-server/services/__tests__/usage-telemetry-service.test.ts)
and the [disclosure route test](../../src-server/runtime/routes/__tests__/runtime-routes-usage-telemetry-late-binding.test.ts)
cover activation, inventory rejection, buffering and disclosure.
The [UI route-seam tests](../../src-ui/src/components/__tests__/TelemetryConsent.routes.test.tsx)
mount the real components against config and telemetry routes with real local
persistence, and observe feedback transport before Off is persisted. They also
exercise hidden notices, stale revisions, and dropped-payload presentation.
The [gallery](../../tests/screenshots.spec.ts) defines desktop and 390px mobile
usage-sharing choices (including Do Not Track, additional-endpoint and light-theme variants), outbox and feedback scenes. These are controlled local evidence;
they do not establish a packaged native-shell or live-receiver deployment. They use
controlled endpoints; a live ingestion deployment needs its own delivery evidence.

# Event inventory

The contracts/product-telemetry inventory declares event and envelope fields; shared/product-telemetry renders and fingerprints them. The Full revision includes envelope and Full events. Lite has its own revision over every field and bound. Neither revision can substitute for the other.

## Version 1 envelope

### batch fields

| Field | Disclosed meaning |
| --- | --- |
| `schema_version` | Protocol version 1. |
| `inventory_revision` | SHA-256 of the disclosed envelope and event inventory. |
| `distinct_id` | SHA-256 of a separate random installation UUID concatenated with the publisher ID and UTC YYYY-MM; rotates monthly and is not a person identity. |
| `events` | One through twenty inventory observations. |

### observation fields

| Field | Disclosed meaning |
| --- | --- |
| `event_id` | Random UUID assigned once at observation; unchanged on retry. |
| `event` | One name from the classified event inventory. |
| `occurred_at` | Canonical UTC producer wall-clock time when track was called, rounded down to the minute. |
| `observed_at` | Canonical UTC producer wall-clock time at buffer admission, rounded down to the minute. |
| `build` | Allowlisted immutable process build metadata; missing facts stay absent. |
| `properties` | Only the event-specific classified properties below. |

### build fields

| Field | Disclosed meaning |
| --- | --- |
| `version` | SemVer application version, present on every event. |
| `platform` | Operating-system platform from the startup inventory. |
| `arch` | CPU architecture from the startup inventory. |
| `sha` | Optional full 40 or 64 hex Git hash, paired with sha_source. |
| `sha_source` | Optional build-stamp or checkout; checkout does not identify served bundle bytes. |
| `channel` | Optional stable, preview, nightly, dev or source-checkout. |
| `dirty` | Optional boolean supplied by the immutable build stamp. |

Producer wall-clock times do not guarantee synchronized clocks or receiver arrival. Branches, hostnames, instance and boot identifiers are excluded.

## `station_started`

Station completed startup.

| Property | Permitted value |
| --- | --- |
| `version` | SemVer version (MAJOR.MINOR.PATCH, with optional prerelease/build metadata) |
| `platform` | `aix`, `android`, `cygwin`, `darwin`, `freebsd`, `haiku`, `linux`, `netbsd`, `openbsd`, `sunos`, `win32` |
| `arch` | `arm`, `arm64`, `ia32`, `loong64`, `mips`, `mipsel`, `ppc`, `ppc64`, `riscv64`, `s390`, `s390x`, `x64` |

## `session_recovery`

A session recovery reached an existing classified outcome.

| Property | Permitted value |
| --- | --- |
| `failure_kind` | `authentication`, `capacity`, `rate-limit`, `unknown` |
| `decision` | `unsupported`, `reconnect`, `manual`, `retry-now`, `wait-until-reset` |
| `outcome` | `armed`, `resumed`, `succeeded`, `failed`, `canceled`, `manual`, `unsupported`, `compensation-required`, `indeterminate` |

## `engine_turn`

An engine turn reached a terminal outcome.

| Property | Permitted value |
| --- | --- |
| `engine` | `station`, `acp`, `bedrock`, `claude`, `codex`, `muse`, `ollama`, `other` |
| `outcome` | `completed`, `aborted`, `failed` |

## `pane_opened`

A public pane or a custom pane was opened.

| Property | Permitted value |
| --- | --- |
| `pane` | public-registry-id-or-custom |

## `plugin_installed`

A public or custom plugin was installed.

| Property | Permitted value |
| --- | --- |
| `plugin` | public-registry-id-or-custom |

## `plugin_removed`

A public or custom plugin was removed.

| Property | Permitted value |
| --- | --- |
| `plugin` | public-registry-id-or-custom |

## `setting_category_changed`

A setting category changed; no key or value is sent.

| Property | Permitted value |
| --- | --- |
| `category` | `appearance`, `connections`, `agents`, `projects`, `notifications`, `privacy`, `advanced`, `other` |

## `client_connected`

A client connected without a device identifier.

| Property | Permitted value |
| --- | --- |
| `surface` | `desktop`, `web`, `ios`, `android`, `cli` |
| `device_class` | `desktop`, `phone`, `tablet`, `server`, `other` |
| `version` | public-release-version-or-custom |

## `setup_abandoned`

Setup was abandoned at a classified step.

| Property | Permitted value |
| --- | --- |
| `step` | `none`, `welcome`, `connection`, `engine`, `project`, `pairing`, `finish` |

## `engine_connect_failed`

An engine connection failed without error text.

| Property | Permitted value |
| --- | --- |
| `engine` | `station`, `acp`, `bedrock`, `claude`, `codex`, `muse`, `ollama`, `other` |

## `safe_mode_entered`

Station entered safe mode.

| Property | Permitted value |
| --- | --- |
| `reason` | `startup`, `plugin-crash`, `user`, `other` |

## `plugin_disabled_after_crash`

A public or custom plugin was disabled after a crash.

| Property | Permitted value |
| --- | --- |
| `plugin` | public-registry-id-or-custom |

## `station_daily` Lite inventory

- `event`: {"domain":["station_daily"]}
- `event_id`: {"domain":"uuid-v4"}
- `version`: {"domain":"public-release-version-or-custom","maxLength":64}
- `channel`: {"domain":["stable","preview","nightly","dev","source-checkout","unknown"]}
- `platform`: {"domain":["aix","android","cygwin","darwin","freebsd","haiku","linux","netbsd","openbsd","sunos","win32"]}
- `arch`: {"domain":["arm","arm64","ia32","loong64","mips","mipsel","ppc","ppc64","riscv64","s390","s390x","x64"]}
- `surfaces_today`: {"domain":["desktop","web","ios","android","cli"],"arrayMax":5}
- `first_active_this_week`: {"domain":"boolean"}
- `first_active_this_month`: {"domain":"boolean"}
- `install_age_bucket`: {"domain":["0d","1-7d","8-30d","31-90d","91d+"]}
- `paired_devices_bucket`: {"domain":["0","1","2-3","4+"]}
- `engines_used_today`: {"domain":["station","acp","bedrock","claude","codex","muse","ollama","other"],"arrayMax":8}
- `distribution`: {"domain":"public-registry-id-or-none-or-custom-or-unknown","maxLength":128}
- `public_plugins_enabled`: {"domain":"public-registry-id","arrayMax":20,"maxLength":128}
- `private_plugins_bucket`: {"domain":["0","1","2-3","4+"]}
- `branding_overridden`: {"domain":"boolean"}
- `home_replaced`: {"domain":"boolean"}
- `layouts_customized`: {"domain":"boolean-or-unknown"}
- `setup_abandoned_step`: {"domain":["none","welcome","connection","engine","project","pairing","finish"]}
- `engine_connect_failures`: {"domain":"engine-count-buckets","arrayMax":8}
- `safe_mode_entered`: {"domain":"count","max":65535}
- `plugin_disabled_after_crash`: {"domain":"count","max":65535}
