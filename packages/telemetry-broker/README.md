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

Configure these environment variables for the built entrypoint:

| Variable | Meaning |
| --- | --- |
| `STATION_TELEMETRY_BROKER_DATABASE_URL` | Private PostgreSQL connection URL; use a dedicated database |
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

## API

| Route | Credential and outcome |
| --- | --- |
| `GET /health/live` | Public process liveness and inventory revision; does not prove storage readiness |
| `GET /v1/operator/storage` | Operator Bearer key; checks durability, migration, logged tables, columns, defaults, keys, constraints and index |
| `POST /v1/operator/sources` | Operator Bearer key; JSON `{id, label, credentialHash}` provisions a UUID source and a lowercase SHA-256 key digest |
| `DELETE /v1/operator/sources/:id` | Operator Bearer key; commits revocation, fenced against concurrent ingestion |
| `GET /v1/operator/trends?from=...&to=...` | Operator Bearer key; UTC ISO bounds, at most 365 days and 1,000 aggregate rows |
| `POST /v1/product/events` | Source `x-api-key`; strict v1 disclosed batch; 202 returns a committed receipt |
| `GET /v1/product/receipts/:id` | Source `x-api-key`; only that source's receipt, otherwise 404 |

Set Station's `STATION_TELEMETRY_ENDPOINT` to the full
`/v1/product/events` URL and `STATION_USAGE_TELEMETRY_KEY` to its source key.
Station still requires telemetry enablement and acknowledgement of the current
inventory. These settings do not configure OTel or authorize personal receipt
sync.

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
database, tests HTTP commit/deduplication, revocation, saturation, ten malformed
schema cases across all eight repository entrypoints, and a stalled PostgreSQL
transport followed by connection recovery. Missing prerequisites fail the
command. Successful runs remove only their owned database; failed runs retain
it and report its name for diagnosis.

The runner does not certify Station execution, persistent deployment, backup
restore or native shells. Those remain separate from focused HTTP tests and
live-store qualification.
