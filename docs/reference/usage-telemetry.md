# Usage telemetry

Station product telemetry is server-side only and sends no prompts, paths, repository names, hostnames, branches, account identities, or other free text. It does not read third-party vendor configuration or credential homes.

Settings → Telemetry offers separate Kontour and Operator Off/Lite/Full
choices. Off is always available. Effective state and its reason are shown
separately from the saved choice: DO_NOT_TRACK forces Off, and a saved Full
choice waits at Lite until the current disclosure is acknowledged. **Turn
off usage telemetry** saves operator Off before acknowledging. Resetting
Station settings preserves these choices. Kontour Full is unavailable until
its own disclosure exists.

DO_NOT_TRACK itself leaves saved choices unchanged. Under DNT the disclosure
offers visible Off, Lite, and Full radio choices and a **Save operator choice
as** action for the selected tier. Saving replaces the operator tier without
acknowledging; DNT keeps telemetry Off. Save closes the dialog and remembers the
current revision for this host across reloads while DNT remains active. Removing
DNT re-prompts only a saved Full choice awaiting confirmation; Off and Lite need
no acknowledgement.

A standard paired device may lower tiers; only the operator or a device with
`access:manage` may raise them. Agents cannot change telemetry choices or
acknowledge the disclosure, even with `access:manage`.
`STATION_TELEMETRY_TIER` and the legacy boolean environment aliases supply
defaults, reported as `environment`, and cannot grant Full. Hosts that previously
relied on `STATION_PRODUCT_TELEMETRY_ENABLED=true` (or its legacy alias) plus a
receipt now resolve to Lite and stop Full delivery. There is no Lite sender in
this foundation. To resume Full events, explicitly choose operator Full in
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

**Foundation status:** there is no Lite sender, author sender, outbox ledger,
plugin publisher registration, or new feature-event producer in this change.
The existing service sends only the acknowledged operator Full stream. It starts
no timer, buffers no observations and sends no ingestion request without that
admission and an endpoint. Source builds have an empty author endpoint. Official
release producers can bake the public endpoint only through the
[owner-gated build variable](../guides/release-rings.md#author-telemetry-in-official-builds);
leaving it unset preserves the empty constant. This build wiring does not add
an author sender. The
[program decision](../decisions/telemetry-tiers.md) separates these contracts
from later sending, UI, receiver, release and owner-gated deployment work.

A saved legacy false migrates to Off for both built-in publishers. Saved true
with a current receipt migrates to operator Full; without it, operator Lite.
Kontour remains Lite when migrating true because an operator disclosure cannot
authorize a different publisher. New inventory fields invalidate old receipts.
The legacy boolean remains an input for older clients, including withdrawal;
`telemetryTier` is the canonical setting. Lite will require clear notice and an
always-visible Off switch; headless builds must record a shown notice revision
before sending. A Lite inventory change requires a new notice, while a Full
inventory change requires a new acknowledgement.

Use `station telemetry status` to read effective tiers and reasons (`DNT`,
`policy`, `default`, `user`, `disclosure`, `environment`) from a running Station. Use
`station telemetry set operator off` or `station telemetry set kontour lite`
to save a single publisher choice. Requesting Full without its receipt remains
Lite. These commands support the normal target/credential flags. The status API also
returns the exact Lite field catalog alongside its revision so a notice consumer
can display the server inventory rather than an older bundled copy. The outbox
command is reserved for the later transparency lane.

`station telemetry producers` is unrelated to these tiers: it manages the
tokens external programs use to add rows to this Station's local monitoring
history. See [Telemetry ingest](api.md#telemetry-ingest).

The acknowledgement POST must include acknowledgementProtocol:2 and the inventoryRevision the UI displayed. Missing/unsupported acknowledgement versions return 426 with update guidance; a missing revision returns 400 and a stale revision returns 409; an older UI cannot acknowledge metadata it does not display. The service also refuses a mismatched revision before writing. The handshake and disclosure publish this feature version; client/server protocol2 retains core protocol1 admission. An older installed UI only shows its existing generic acknowledgement failure until updated. New metadata stays inactive; no legacy sender fallback runs on this host. A receipt records its acknowledgement timestamp and the SHA-256 revision of this inventory under `STATION_HOME/config/usage-telemetry-disclosure.json`. A changed inventory invalidates an older receipt and stops emission until it is shown and acknowledged again: new data must not leave before the user has seen it.

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
`STATION_PRODUCT_TELEMETRY_KEY`, when set, is sent only as that endpoint's
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
SHA-256 of a random UUID concatenated with UTC `YYYY-MM`. The UUID is persisted at
`STATION_HOME/config/usage-telemetry-id`; the raw UUID never leaves the process.

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
`STATION_HOME/config/usage-telemetry-id` concatenated with UTC `YYYY-MM`.
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
funnel is inferred from startup; only the three existing classified event producers are wired; additional event definitions below are contracts for later lanes.

The producers are
[runtime startup](../../src-server/runtime/bootstrap/station-runtime.ts) and
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

[Service tests](../../src-server/services/__tests__/usage-telemetry-service.test.ts)
and the [disclosure route test](../../src-server/runtime/routes/__tests__/runtime-routes-usage-telemetry-late-binding.test.ts)
cover activation, inventory rejection, buffering and disclosure. They use
controlled endpoints; a live ingestion deployment needs its own delivery evidence.

# Event inventory

The contracts/product-telemetry inventory declares event and envelope fields; shared/product-telemetry renders and fingerprints them. The Full revision includes envelope and Full events. Lite has its own revision over every field and bound. Neither revision can substitute for the other.

## Version 1 envelope

### batch fields

| Field | Disclosed meaning |
| --- | --- |
| `schema_version` | Protocol version 1. |
| `inventory_revision` | SHA-256 of the disclosed envelope and event inventory. |
| `distinct_id` | SHA-256 of a separate random installation UUID concatenated with the UTC YYYY-MM; rotates monthly and is not a person identity. |
| `events` | One through twenty inventory observations. |

### observation fields

| Field | Disclosed meaning |
| --- | --- |
| `event_id` | Random UUID assigned once at observation; unchanged on retry. |
| `event` | One name from the classified event inventory. |
| `occurred_at` | Canonical UTC producer wall-clock time when track was called. |
| `observed_at` | Canonical UTC producer wall-clock time at buffer admission. |
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
- `channel`: {"domain":["stable","preview","nightly","dev","source-checkout"]}
- `platform`: {"domain":["aix","android","cygwin","darwin","freebsd","haiku","linux","netbsd","openbsd","sunos","win32"]}
- `arch`: {"domain":["arm","arm64","ia32","loong64","mips","mipsel","ppc","ppc64","riscv64","s390","s390x","x64"]}
- `surfaces_today`: {"domain":["desktop","web","ios","android","cli"],"arrayMax":5}
- `first_active_this_week`: {"domain":"boolean"}
- `first_active_this_month`: {"domain":"boolean"}
- `install_age_bucket`: {"domain":["0d","1-7d","8-30d","31-90d","91d+"]}
- `paired_devices_bucket`: {"domain":["0","1","2-3","4+"]}
- `engines_used_today`: {"domain":["station","acp","bedrock","claude","codex","muse","ollama","other"],"arrayMax":8}
- `distribution`: {"domain":"public-registry-id-or-none-or-custom","maxLength":128}
- `public_plugins_enabled`: {"domain":"public-registry-id","arrayMax":20,"maxLength":128}
- `private_plugins_bucket`: {"domain":["0","1","2-3","4+"]}
- `branding_overridden`: {"domain":"boolean"}
- `home_replaced`: {"domain":"boolean"}
- `layouts_customized`: {"domain":"boolean"}
- `setup_abandoned_step`: {"domain":["none","welcome","connection","engine","project","pairing","finish"]}
- `engine_connect_failures`: {"domain":"engine-count-buckets","arrayMax":8}
- `safe_mode_entered`: {"domain":"count","max":65535}
- `plugin_disabled_after_crash`: {"domain":"count","max":65535}
