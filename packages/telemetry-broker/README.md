# Station product telemetry receiver

This optional companion accepts Station's disclosed product observations and
stores them in PostgreSQL. It is separate from the OTel Collector and from
personal usage accounting. See [Monitoring & Telemetry](../../docs/guides/monitoring.md).

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

The HTTP boundary permits at most 8 active requests and a global token bucket
of 60 requests with 1 token restored per second. Rate exhaustion returns 429
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
