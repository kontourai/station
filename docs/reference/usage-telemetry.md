# Usage telemetry

Station product telemetry is server-side only and sends no prompts, paths, repository names, hostnames, branches, account identities, or other free text. It does not read third-party vendor configuration or credential homes.

## Disclosure and activation

Usage telemetry is enabled by default and has a visible Station Settings toggle.
The saved `telemetryEnabled` setting takes precedence over
`STATION_PRODUCT_TELEMETRY_ENABLED`, its legacy alias
`STATION_TELEMETRY_ENABLED`, then the default. **Without an ingestion endpoint,
this service sends nothing:** it starts no telemetry timer, buffers no events
and makes no ingestion request. The repository configures no default endpoint.
With an endpoint, it still requires a current disclosure acknowledgement before
buffering or sending. The first-run UI and Settings show the event and envelope inventory below;
the stored acknowledgement records acceptance, not proof the user read it.

The acknowledgement POST must include acknowledgementProtocol:2 and the inventoryRevision the UI displayed. Missing/unsupported acknowledgement versions return 426 with update guidance; a missing revision returns 400 and a stale revision returns 409; an older UI cannot acknowledge metadata it does not display. The service also refuses a mismatched revision before writing. The handshake and disclosure publish this feature version; client/server protocol2 retains core protocol1 admission. An older installed UI only shows its existing generic acknowledgement failure until updated. New metadata stays inactive; no legacy sender fallback runs on this host. A receipt records its acknowledgement timestamp and the SHA-256 revision of this inventory under `STATION_HOME/config/usage-telemetry-disclosure.json`. A changed inventory invalidates an older receipt and stops emission until it is shown and acknowledged again: new data must not leave before the user has seen it.

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

The payload carries a SHA-256 hash of a random UUID persisted at
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

`distinct_id` is the SHA-256 hash of a random UUID created once per installation and persisted at `STATION_HOME/config/usage-telemetry-id`. It is not derived from any account, and never from another vendor's configuration or credential files. Station reads that file back after every write, so it only ever hashes a value that is actually persisted.

**Known exception a data consumer must account for.** If that file is ever left corrupted — a crash mid-write, a truncated restore — Station repairs it by writing a fresh UUID atomically. Two Station processes sharing one `STATION_HOME` that repair it at the same moment can each hash a different value before one write wins, and a single process can send one batch under the pre-repair identity and later batches under the winner. The file converges to one UUID and every later run reads that winner, so this is bounded to the repair itself.

Consequences while it happens: unique-installation counts can be overstated, and one installation's events can be split across two identities, fragmenting funnels, retention and per-install sequences. Treat `distinct_id` as a stable installation identity **except** across a repair.

The repair intentionally uses atomic replacement and readback without a
cross-process lock. The earlier lock was removed in #2238 to avoid stale-lock
recovery becoming a prerequisite for anonymous telemetry. Preserve this tradeoff
when changing identity storage; the hash is not an account identity or a unique
person count.

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
funnel is inferred from startup; only the three existing classified events ship.

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

The contracts/product-telemetry inventory declares event and envelope fields; shared/product-telemetry renders and fingerprints them. The revision includes both inventories.

## Version 1 envelope

### batch fields

| Field | Disclosed meaning |
| --- | --- |
| `schema_version` | Protocol version 1. |
| `inventory_revision` | SHA-256 of the disclosed envelope and event inventory. |
| `distinct_id` | SHA-256 of a separate random installation UUID; not a person identity. |
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
