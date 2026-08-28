# Usage telemetry

Station product telemetry is server-side only and sends no prompts, paths, repository names, hostnames, branches, account identities, or other free text. It does not read third-party vendor configuration or credential homes.

## Disclosure and activation

Usage telemetry is enabled by default and has a visible Station Settings toggle. **No ingestion endpoint is configured by default, so Station sends nothing at all:** it creates no telemetry timer, retains no telemetry buffer, and makes no request. If an endpoint is configured, Station still refuses to buffer or send until this Station has shown and recorded acknowledgement of the inventory below. The same disclosure remains available in Settings.

A receipt records its acknowledgement timestamp and the SHA-256 revision of this inventory under `STATION_HOME/config/usage-telemetry-disclosure.json`. A changed inventory invalidates an older receipt and stops emission until it is shown and acknowledged again: new data must not leave before the user has seen it.

When an operator configures `STATION_TELEMETRY_ENDPOINT`, Station POSTs batches directly to that endpoint. `STATION_USAGE_TELEMETRY_KEY`, when set, is sent only as that endpoint's `x-api-key` request header. `STATION_TELEMETRY_API_KEY` remains exclusive to OTLP exports and is never sent to the product endpoint. The payload carries a SHA-256 hash of a random UUID persisted at `STATION_HOME/config/usage-telemetry-id`; the raw UUID never leaves the process.

## What `distinct_id` is, and when it is not stable

`distinct_id` is the SHA-256 hash of a random UUID created once per installation and persisted at `STATION_HOME/config/usage-telemetry-id`. It is not derived from any account, and never from another vendor's configuration or credential files. Station reads that file back after every write, so it only ever hashes a value that is actually persisted.

**Known exception a data consumer must account for.** If that file is ever left corrupted — a crash mid-write, a truncated restore — Station repairs it by writing a fresh UUID atomically. Two Station processes sharing one `STATION_HOME` that repair it at the same moment can each hash a different value before one write wins, and a single process can send one batch under the pre-repair identity and later batches under the winner. The file converges to one UUID and every later run reads that winner, so this is bounded to the repair itself.

Consequences while it happens: unique-installation counts can be overstated, and one installation's events can be split across two identities, fragmenting funnels, retention and per-install sequences. Treat `distinct_id` as a stable installation identity **except** across a repair.

This is a deliberate trade, not an oversight. Serializing the repair means a cross-process lock, and archive#2238 removed exactly that primitive after concluding a hand-rolled filesystem lock without owner identity or stale-lock recovery is not one bug from correct: a crash while holding it strands the lock, and every later repair then fails permanently — telemetry that never sends again. A bounded identity split is preferable to a permanent failure mode for an anonymous analytics identifier.

# Event inventory

This page is rendered from `src-server/services/usage-telemetry-inventory.ts`; its contract test rejects code/inventory drift.

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
