# Station product telemetry receiver

This optional companion accepts Station's disclosed product observations and
stores them in PostgreSQL. It is separate from the OTel Collector and from
personal usage accounting. See [Monitoring & Telemetry](../../docs/guides/monitoring.md).

**Status: source implementation; not yet a qualified deployment.** Lite receiver
diagnostics, the existing bundled qualifier, hosted checks and deployment
acceptance are separate evidence. Nothing here deploys a receiver, enables an
author endpoint, or authorizes collecting telemetry from an installation.

The qualified storage profile is PostgreSQL 16 with `fsync` and
`full_page_writes` enabled. Each transaction sets `synchronous_commit=on`.
HTTP 202 means PostgreSQL acknowledged the transaction's commit; a disconnected
or timed-out commit returns a failure. Retrying the same source/event UUID with
the same observation does not insert another event. Reusing an ID with different
content returns 409. This deduplication lasts only while the event is retained.

## Run privately

Build with Node 24 and the repository's managed dependencies:

```bash
npm run dependencies:ci
npm run build:telemetry-broker
```

The build writes both bundles and `dist/artifact-manifest.json`. It captures
hashes of the bytes supplied to esbuild, binds the sorted input inventory's
count/digest and required root/build/entrypoint files, and refuses an
input/provenance change during the build. Reads require regular files with
nonblocking/no-follow opens: manifest 1 MiB, inputs 16 MiB, bundles 64 MiB each.
The qualifier captures both validated bundles into one private execution
snapshot, validates that copy before import or database setup, and runs every
entrypoint child from it. Receipt hashes describe that snapshot, which is
removed after all launched children settle. If settlement is unproven,
qualification fails and retains the frozen snapshot and private credential
fixture for its owning recovery lane. Seven copy-only corruption/refusal and
restoration controls include removed input records and a FIFO bundle. Rebuild
after a source commit; an older build cannot qualify a new head. The build and
these rejected/restored manifest controls have executed against the recorded
source and artifacts. They do not qualify later revisions. The unsigned sidecar is
build-only metadata, not a source/publisher
attestation, installed dependency-graph proof or deployment/release acceptance.

Configure these environment variables for the built entrypoint:

| Variable | Meaning |
| --- | --- |
| `STATION_TELEMETRY_BROKER_DATABASE_URL` | Private PostgreSQL connection URL; use a dedicated database and select this or the file input |
| `STATION_TELEMETRY_BROKER_DATABASE_URL_FILE` | Owned/private Unix regular file containing the URL, bounded to 4096 bytes; selecting both inputs refuses startup |
| `STATION_TELEMETRY_BROKER_OPERATOR_KEY_FILE` | Owned Unix regular file, private permissions, containing one `sto_` credential |
| `STATION_TELEMETRY_BROKER_HOST` | Listen address, default `127.0.0.1` |
| `STATION_TELEMETRY_BROKER_PORT` | Nonprivileged port, default `43891` |

Run `node packages/telemetry-broker/dist/main.mjs`. The bundled artifact includes
its JavaScript dependencies. The Unix secret-file profile rejects symlinks,
FIFOs, other owners, public permissions and files exceeding 256 bytes; it is
not a qualified Windows deployment profile. Keep database URLs and credentials
in private files or the service's secret store, out of shell history and logs.
Restrict reachability to the private dogfood network and terminate TLS before
exposing a non-loopback HTTP listener.

An operator key is `sto_` plus 32 random bytes encoded as base64url. Each source
gets a separate `stp_` key in the same format. Only its SHA-256 digest is stored.
The product operator key manages this receiver; it grants no Station access or
personal identity. Product source keys cannot call operator routes, and operator
keys cannot submit source events. Rotating the operator key requires restarting
the receiver; rotating a source means provisioning a fresh source and revoking
the old one.

The [private companion profile](../../deployment/telemetry/README.md) composes
an explicit standalone image target and separate pinned diagnostic stores.
Its source exists; image/configuration/runtime and upgrade/restore qualification
remain pending. A normal Station install does not start that profile.

## API

The routes below retain the opt-in full-tier protocol. The identifier-free
`station_daily` route and its independent public source configuration are
described under [Lite observations](#lite-observations).

| Route | Credential and outcome |
| --- | --- |
| `GET /health/live` | Public process liveness and inventory revision; does not prove storage readiness |
| `GET /v1/operator/storage` | Operator Bearer key; checks durability, migration, logged tables, columns, defaults, keys, constraints and index |
| `POST /v1/operator/sources` | Operator Bearer key; JSON `{id, label, credentialHash}` provisions a UUID source and a lowercase SHA-256 key digest |
| `DELETE /v1/operator/sources/:id` | Operator Bearer key; commits revocation, fenced against concurrent ingestion |
| `GET /v1/operator/trends?from=...&to=...` | Operator Bearer key; UTC ISO bounds, at most 365 days and 1,000 aggregate rows |
| `POST /v1/product/events` | Source `x-api-key`; strict v1 disclosed batch; 202 returns a committed receipt |
| `POST /v1/product/probes` | Source `x-api-key`; content-free v1 probe checks source authority and compatible storage without inserting a source, observation or receipt |
| `GET /v1/product/receipts/:id` | Source `x-api-key`; only that source's receipt, otherwise 404 |

Set Station's `STATION_PRODUCT_TELEMETRY_ENDPOINT` to the full
`/v1/product/events` URL and `STATION_PRODUCT_TELEMETRY_KEY` to its source key.
The legacy aliases `STATION_TELEMETRY_ENDPOINT` and
`STATION_USAGE_TELEMETRY_KEY` remain supported until a separate release decision;
valid nonempty canonical values win. Neither resolves an OTLP key.
Station still requires telemetry enablement and acknowledgement of the current
inventory. These settings do not configure OTel or authorize personal receipt
sync.

An explicit Settings connection check sends
`{protocol: "station-product-probe/v1", inventoryRevision: "<current revision>"}`
to the sibling `/v1/product/probes` route. Its response identifies
`storage: "postgres-schema-v1"` with a source UUID and check timestamp. A revoked
source, incompatible schema or non-durable storage refuses the request. Probe
readiness establishes no delivered observation and does not grant consent.

Trends count **received product observations** by producer wall-clock day,
event, release and reported engine/outcome. They explicitly return
`deliveryCoverage: "unknown"`; lost or disabled producers are not measured zero
and installation hashes are not people. Queries and retention reject incompatible
storage just like ingestion. Schema compatibility is checked inside transactions
while holding DDL locks through the operation.

## Bounds and operation

Authenticated routes, anonymous lite ingest, and public page reads have separate
8-active-request budgets and token buckets of 60 requests, restoring one per second.
Public aggregate cache misses have their own budget; successful fills are reused
for the rest of the UTC day, including concurrent reads, without storage work. Rate exhaustion returns 429
with `Retry-After`; concurrency exhaustion returns 503. Process liveness remains
available. Bodies are capped at 128 KiB. The standalone server permits 64
connections and sets 5-second socket/request/header timeouts.

Storage permits 4 active transactions; excess work returns `storage_busy`.
Connections have a 1.5-second acquisition timeout, server statements 3 seconds,
client queries 3.5 seconds, and whole transactions 5 seconds. Uncertain
connections are discarded; no timeout is acceptance. A failed retention pass
is reported to stderr without request bodies or credentials.

Admission checks limit the database to approximately 1 GiB, 1 million events,
2 million commit receipts and 10,000 sources. This is an admission threshold,
not a filesystem quota: the admitted batch, indexes and WAL can add bytes.
Events expire after 90 days; commit receipts after 7 days. Retention runs at
startup and hourly. Revoked source records remain retained and count toward the
source cap. PostgreSQL row deletion does not reliably reduce allocated database
size, so a database hitting the physical threshold can remain full after
retention. Treat 507 `storage_limit` as an operator capacity incident: expand
the qualified capacity profile or restore into a fresh database during a
maintenance window; never promise automatic space recovery or disable durability.

Back up with PostgreSQL `pg_dump`, including the entire `station_telemetry`
schema. Protect backups as product telemetry. Restore into a fresh database,
then check operator storage readiness and repeat a known retained source/event
submission: it must report `inserted: 0` and preserve source revocation.
Keep source-key files separately protected; the dump contains only key digests.
Never edit migration markers to make an incompatible upgrade appear ready.
Validate candidate upgrades against a restored private copy before switching
the running service. Persistent deployment, collector traces/metrics, installed
Station execution and release qualification require their own receipts.

## Live qualification

`npm run qualify:telemetry-broker` requires
`STATION_TELEMETRY_QUALIFICATION_DATABASE_URL` with permission to create a
separate database. Build the broker first. The runner creates a unique owned
database and exercises the real bundled Unix entrypoint with five startup
refusals and private-file/legacy-environment positive controls. It binds the
entrypoint and repository bundle digests separately and requires owned process
cleanup. These controls have executed against the recorded source and frozen
artifacts; they are not image, Compose, private-host, backup/restore or release evidence.
In that same database, the runner tests HTTP commit/deduplication, revocation,
saturation, ten malformed
schema cases across all nine repository entrypoints and the HTTP probe, and a stalled PostgreSQL
transport followed by connection recovery. Missing prerequisites fail the
command. It also checks that a probe inserts no source, observation or commit,
and that foreign and revoked keys cannot probe. Successful runs remove only their owned database; failed runs retain
it and report its name for diagnosis.

The runner does not certify Station execution, persistent deployment, backup
restore or native shells. Those remain separate from focused HTTP tests and
live-store qualification.

## Lite observations

`POST /v1/lite/:source` accepts exactly one `StationDailyPing` from
`packages/contracts/src/product-telemetry.ts`, validated by the shared
`parseStationDailyPing`. It requires no installation credential. Unknown fields,
unknown nested fields, excessive or duplicate array entries, unknown catalog
IDs/versions, invalid enum/count values, and a channel different from the
source's configured channel are refused with 400. Bodies, including streaming
bodies, are capped at 16 KiB. Responses never echo a rejected value. A committed
202 response is `{ "inserted": 1 }`, or `{ "inserted": 0 }` for a retained
source/event UUID replay with identical content. A changed payload under the
same UUID returns 409. Object order, array-set order and UUID letter case do
not create separate retries. Dedupe ends when raw rows expire.

The operator provisions a **public per-publisher/per-channel identifier**, not
a secret embedded in a binary. Example operator-authenticated request body for
`POST /v1/operator/lite/sources`:

```json
{
  "id": "kontour-stable-v1",
  "publisher": "kontour",
  "channel": "stable",
  "registryIds": [],
  "releaseVersions": ["1.2.3"]
}
```

The five fields are required. `publisher` uses the foundation's
`TelemetryPublisherId`: `kontour`, `operator` or `publisher:<public publisher id>`.
Publisher IDs are bounded to 128 characters and retain scoped IDs such as
`publisher:@scope/plugin`. Source IDs are bounded public slugs. The catalogs each
hold at most 1,000 entries. The operator must verify these are **public registry
IDs and public release versions**, rather than accepting arbitrary client
strings. Empty catalogs admit only contract sentinels (`custom` version,
`none`/`custom` distribution, no public plugins). To change a catalog, provision
a new source and revoke the old one with
`DELETE /v1/operator/lite/sources/:source`; existing IDs cannot be repurposed.
Only enabled sources ingest. The trusted mapping, never the request body,
chooses the publisher. Keep official sources distinct from operator/fork sinks.

Public IDs provide routing and revocation, **not authenticity**. Anyone can
replay the protocol or manufacture fresh UUIDs. Counts are untrusted estimates;
there is no unique-person or unique-device proof, and no Sybil resistance.
Tier choice and notice belong to the sender; this route does not infer consent
or promote a publisher to `full`.

Lite admission allows 60 attempts per daily network key, with at most 10,000
in-memory entries. IPv4 keys use the address; IPv6 keys use the /64 prefix.
IPv4-mapped IPv6 aliases use the same IPv4 key. The least recently used entry
is evicted at capacity, so new clients remain admissible; eviction can reset
an old client's attempt budget, but never changes its daily contributor hash.
Keys use HMAC-SHA256 with a random process-only salt, replaced on the next
UTC-day request. The salt is never stored. Raw IPs and user agents never enter
SQL, logs, errors, marginals or receipts. Forwarded-IP headers are ignored.
Behind a proxy all clients share one key; NAT also merges contributors.

Run one receiver process. Restart changes the salt and can count the same
network again that day; multiple processes have independent salts and limits.
This is not a unique-person count or a Sybil defense. A botnet of at least ten
distinct IPv6 /64s (or IPv4 addresses) can pad any marginal past k. A proxy-aware
deployment needs a separately reviewed trusted ingress boundary, with access
logging disabled/sanitized there. This package does not qualify infrastructure
logging. OHTTP and DAP/Prio remain deferred.

### Storage and activity estimates

Migration 2 introduces lite sources, publisher keys and raw pings. Migration 3
drops the legacy joint-cell table and adds logged `lite_marginals`,
`lite_clients` and `lite_capacity`. Existing joint cells are discarded because
they cannot prove distinct contributors; old raw rows remain subject to retention
but are not reconstructed into publishable marginals. Full-tier rows are
unchanged. Older binaries refuse migration 3. Back up the entire schema and
validate upgrades against a restored private copy.

Each first insertion atomically updates one row per (UTC arrival day, publisher,
dimension, value). It increments pings and increments the contributor count only
when that daily client hash has not already contributed to that value. The
separate contributor table contains day-scoped HMACs, never raw addresses or a
cross-day join key. Numeric counts use `0`, `1`, `2-5`, `6-20`, `21+` before
rollup; contract fields already expressed as buckets retain those buckets.
There are no retained joint cells. The maintained capacity counter replaces a
per-ingest raw-table count; raw deletion decrements it in the same transaction.
Admission retains the one-million-lite-ping, 10,000-source/publisher-key and
approximate 1 GiB limits.

Retention runs at startup and hourly. Under the ingest admission lock it
finalizes closed days and drops their contributor hashes; only finalized
marginals are published and retained indefinitely. Raw pings expire after 90
days, including UUID dedupe. Downtime or a failed sweep delays finalization and
erasure; these are periodic operations, not database TTL guarantees.

Receipt-day pings approximate active installations. Daily first-active-week
and first-active-month counts can be summed over a **complete calendar week or
month** to estimate WAU/MAU. They are not rolling seven/thirty-day unique counts,
and are not exact: retries across period boundaries, late delivery, lost pings,
state resets, multiple publishers and dishonest clients affect them. The receiver
uses UTC arrival day because the strict foundation ping has no producer date.
It does not add an undisclosed date field. Calendar-period boundaries must agree
with sender-local first-active calculations before interpreting these estimates.

All allowed profile dimensions have histograms: version/channel/platform/arch,
surface and engine sets, age and paired-device buckets, distribution, public
plugins/private-plugin bucket, three customization flags, setup-abandonment,
per-engine failure buckets, and both friction counters. Friction histograms
count **pings at that counter/bucket**, not the sum of failures. Multi-valued
surface/plugin/engine histograms can sum above the number of pings.

### Public aggregates

`GET /v1/public/aggregates` publishes Kontour's per-dimension marginals over the
last 30 closed UTC arrival days. Each (day, dimension, value) must have at least
**ten distinct daily client hashes**. The metric is still received pings;
k measures contributing network keys, not pings or verified installations.
One victim ping plus nine attacker pings from one IP supplies at most two keys
and stays suppressed. A common platform value can publish even when every
observation differs in other fields. Publisher reads use exactly the same rule.

No joint cells, raw grand total, suppressed remainder, arbitrary range,
dimension filter or cohort query is exposed. Query strings are rejected.
First-active flags appear only as independent suppressed marginals. Different
dimensions can represent different subsets: do not join them or infer a hidden
population total. Marginal k suppression does not prevent reconstruction using
outside knowledge, correlated dimensions, malicious submissions or multiple
release policies. Missing values/days mean suppressed or unavailable data,
never zero use.

The successful public response is cached per UTC day in process memory; reads
after the first do not query storage or take the ingest advisory lock. A day
finalized after that cache fills appears at the next UTC-day refresh. Failures
are not cached. Responses include `nosniff` and a cache lifetime ending at UTC
midnight. Publisher credentials are checked on every read, so revocation is
immediate. `/public/` serves a static dashboard with text-node rendering and a
CSP permitting no third-party scripts, analytics or network requests.

### Publisher access

An independent publisher read credential is `stq_` plus 32 random base64url
bytes. Generate and keep it privately, like the operator key. An operator
Bearer `sto_` request to `POST /v1/operator/lite/publishers` supplies exactly
`{ "publisher": "publisher:example", "credentialHash": "<lowercase SHA-256>" }`.
Only the digest is stored. Repeating that operation rotates the publisher's
key; `DELETE /v1/operator/lite/publishers/:publisher` revokes it. These routes
use the existing operator authorization boundary.

`GET /v1/publishers/:publisher/aggregates` requires that publisher's Bearer
`stq_` credential and returns only its own k-suppressed marginals for the last
30 closed days. Operator/source keys and a different publisher's key are refused.
Publisher credentials never ingest. Both query endpoints cap work at 10,000
marginal values and refuse over-limit queries rather than truncating them.

### Verification

The existing qualifier includes `qualify-lite.mjs`: real local HTTP and
PostgreSQL checks for strict rejection, bounded streaming bodies, replay/conflict,
marginal suppression, publisher isolation/revocation,
retention, schema refusal, and captured stdout/stderr plus database rows for IPs,
user agents and rejected content. A smaller diagnostic (not a manifest-bound
qualification receipt) is available after building:

```sh
STATION_TELEMETRY_QUALIFICATION_DATABASE_URL=<private-local-qa-url> \
  node packages/telemetry-broker/qualify-lite.mjs
npm run test:focused -- packages/telemetry-broker/src/__tests__/broker.test.ts \
  packages/telemetry-broker/src/__tests__/lite-rate-limit.test.ts \
  packages/telemetry-broker/src/__tests__/passive-signals.test.ts
```

The diagnostic creates a uniquely named database, removes it only on success,
and retains failures for diagnosis. Focused broker tests use in-memory PostgreSQL (PGlite) and synthetic socket
bindings to exercise SQL accumulation, k suppression, single-network padding,
count buckets and publisher isolation without an external database. PGlite is
a development dependency, absent from the receiver bundle. The focused limiter test uses real HTTP
with a storage refusal fixture and a controlled UTC clock; it does not claim
database ingestion. Passive API tests use a local HTTP fixture, not production.
Neither path qualifies a deployed receiver, public ingestion authenticity,
reverse-proxy logging, power-loss durability, backup/restore or a release.

## Passive distribution report

Run manually: `node packages/telemetry-broker/passive-signals.mjs`.
It reads only the public [npm download-count API](https://github.com/npm/registry/blob/main/docs/download-counts.md)
for `@kontourai/station-cli` (last available day, seven days, thirty days), and
[GitHub release/asset metadata](https://docs.github.com/en/rest/releases/assets#list-release-assets)
for `kontourai/station`. Both release and asset lists are paginated; each list
is capped at 100 pages, responses at 8 MiB and requests at 15 seconds. A refused
request, malformed count or incomplete page traversal fails without printing
a partial summary. No token, write, scheduler or automatic startup hook is used.
It does not download release binaries or call a broker or push gateway.

The output keeps npm windows separate (they overlap) and reports GitHub
asset lifetime counts, not daily downloads. Bots, CI, upgrades, reinstalls and
caches prevent these from measuring people or active installations. Production
execution is a separate manual operator action. Read-only push-ledger queries
and their limitations are in the [deployment guide](../../deployment/telemetry/README.md#passive-push-ledger-queries-read-only).
