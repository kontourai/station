# Usage telemetry

Station product telemetry is server-side only and sends no prompts, paths, repository names, hostnames, branches, account identities, or other free text. It does not read third-party vendor configuration or credential homes.

## Disclosure and activation

Usage telemetry is enabled by default and has a visible Station Settings toggle.
The saved `telemetryEnabled` setting takes precedence over
`STATION_TELEMETRY_ENABLED`, then the default. **Without an ingestion endpoint,
this service sends nothing:** it starts no telemetry timer, buffers no events
and makes no ingestion request. The repository configures no default endpoint.
With an endpoint, it still requires a current disclosure acknowledgement before
buffering or sending. The first-run UI and Settings show the event and envelope inventory below;
the stored acknowledgement records acceptance, not proof the user read it.

The acknowledgement POST must include the inventoryRevision the UI displayed. Missing revisions return 400 and stale revisions return 409; an older UI cannot acknowledge metadata it does not display. The service also refuses a mismatched revision before writing. A receipt records its acknowledgement timestamp and the SHA-256 revision of this inventory under `STATION_HOME/config/usage-telemetry-disclosure.json`. A changed inventory invalidates an older receipt and stops emission until it is shown and acknowledged again: new data must not leave before the user has seen it.

When an operator configures `STATION_TELEMETRY_ENDPOINT`, Station POSTs batches directly to that endpoint. `STATION_USAGE_TELEMETRY_KEY`, when set, is sent only as that endpoint's `x-api-key` request header. `STATION_TELEMETRY_API_KEY` remains exclusive to OTLP exports and is never sent to the product endpoint. The payload carries a SHA-256 hash of a random UUID persisted at `STATION_HOME/config/usage-telemetry-id`; the raw UUID never leaves the process.

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
