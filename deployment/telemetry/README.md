# Private telemetry companion

**Status: source implementation for #3458; not yet a qualified deployment or
published release.** YAML parsing is not Collector, Compose, database or runtime
acceptance. The delivery ledger in [#3464](https://github.com/kontourai/station/issues/3464)
owns the missing execution evidence.

This optional profile runs the [product receiver](../../packages/telemetry-broker/README.md)
and a separate authenticated OTel Collector, Prometheus, Tempo and Grafana.
Product observations never enter the diagnostic stores. Neither path supplies
personal usage accounting, person identity or an analytics source grant.
Station's normal install enables none of these services or destinations.

## Artifact and private files

The root Dockerfile's explicit `telemetry-runtime` target bundles the receiver
with its JavaScript dependencies and an existing Station release provenance
manifest. The default target remains the normal Station runtime. Source images
must be built from a clean, qualified revision with the matching release SHA,
ref and canonical timestamp. A supplied SHA or image label does not prove that
the source was clean or qualified. Publication and a digest-bound companion
release descriptor remain pending.

The receiver build also writes `dist/artifact-manifest.json`, binding both
bundles to the exact bytes supplied to esbuild, root dependency declarations,
build configuration and recorded source provenance. Qualification checks the
manifest, canonical input inventory/count/digest, required inputs and exact
source revision. Bounded regular-file reads refuse symlinks and FIFOs. It
validates a private bundle snapshot before importing it or creating its
database, runs its child entrypoints from that snapshot and reports those
exact hashes. Unproven child settlement fails qualification and retains the
snapshot and private credential fixture for the owning recovery lane. A dirty
checkout refuses qualification.
Container provenance is explicitly a supplied release declaration, not proof
that the image was built from clean or qualified source. The sidecar is
unsigned build metadata, not publisher authentication, installed-graph proof
or a canonical release receipt. Build/consumer and seven rejected/restored
manifest controls have executed on the recorded local source and artifacts;
they do not qualify this container profile or later revisions.

Prepare a dedicated absolute private directory outside the checkout. Never put
credentials in a Compose file, Docker build argument, repository, command line
or screenshot. On a rootful Linux Docker host, the files below must be real
regular files, readable only by their named container user. Create them
deliberately through your private provisioning mechanism; do not loosen their
permissions to fix a failed start.

| File | Contents | Owner / mode |
| --- | --- | --- |
| `postgres-password` | A new dedicated database password | UID 1000 / 0400; the PostgreSQL bootstrap reads it as root before dropping privileges |
| `database-url` | Matching `postgresql://station_telemetry:<URL-encoded-password>@postgres:5432/station_telemetry` | UID 1000 / 0400 |
| `product-operator-key` | `sto_` followed by 32 random bytes encoded as base64url | UID 1000 / 0400 |
| `otel-key` | A separate randomly generated Collector key | UID 1000 / 0400 |
| `grafana-password` | A separate randomly generated dashboard password | UID 472 / 0400 |

Rootless/user-remapped Docker needs a separately checked UID mapping. The
receiver refuses a database URL or operator-key file with another owner,
public permissions, a symlink or a non-regular file. Database files are bounded
to 4096 bytes; operator keys to 256. Selecting both the old database URL
environment value and its new `_FILE` input refuses startup. No fallback
credential is selected. Compose refuses to create a missing credential mount.
The PostgreSQL image still materializes its database password in its own
bootstrap process environment; the Docker host/daemon is trusted infrastructure.

Each Station gets a distinct product source key provisioned through the
receiver's existing operator route; only its SHA-256 digest is stored. Source
keys are not operator keys, OTel keys, Grafana passwords, provider credentials
or personal source grants. Provisioning and subsequent receipt acceptance need
their own evidence; a live health response is not storage readiness.

## Render, validate, then run

Use a unique, persistent `COMPOSE_PROJECT_NAME`. Keep it stable across upgrades
to retain its named stores, and never reuse another owner's project or volume.
Set only non-secret values in your private environment file:

```dotenv
COMPOSE_PROJECT_NAME=station-telemetry-private
TELEMETRY_PRIVATE_DIR=/absolute/private/station-telemetry
TELEMETRY_RECEIVER_IMAGE=station-telemetry:qualified-source
STATION_RELEASE_SHA=<exact-clean-qualified-40-character-commit>
STATION_RELEASE_REF=v0.0.0-preview.1
STATION_RELEASE_CREATED_AT=<canonical-ISO-timestamp-for-that-source>
```

The placeholders above are not runnable release evidence. From the repository
root, render the exact profile before acquiring resources:

```sh
docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.yaml config
```

Before a build, pull or start, reconcile current source/installer/runtime
custody and fresh CPU, memory, swap, disk and IO pressure on the actual host.
The service limits total 2.5 GiB; deployment needs additional host and existing
service headroom. Refusal releases unused priority and does not trigger a retry
loop. Preserve existing private dogfood, QA, Station and native services.

Validate the pinned Collector configuration through its actual binary and the
Tempo, Prometheus and Grafana configuration through their actual consumers.
Then build the explicit receiver target and start this project only:

```sh
docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.yaml build receiver
docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.yaml up -d
```

These are pending qualification commands, not recorded successes. All published
ports bind numeric loopback: product 44481, authenticated OTLP HTTP 44482 and
authenticated Grafana 44484. PostgreSQL, Prometheus and Tempo publish no host
port. Dedicated internal product/diagnostic networks separate their stores.
Use an explicitly owned SSH forward or separately qualified private TLS ingress
to reach the profile from another computer; do not change a binding to `0.0.0.0`
as a connectivity workaround. Existing user ports 3141 and 3000 remain outside
the host profile.

Configure Station's product POST URL with its provisioned source key, and the
collector base URL with the separate OTel key. Use the saved instance destination
and exact SecretBinding grants where available, or the documented independent
environment settings. Product disclosure remains necessary. A connection check
is not an emitted event, persisted metric, trace query or personal enrollment.

## Diagnostic semantics and retention

The Collector authenticates `x-api-key` from its private file. Its resource
projection retains only service name, pseudonymous OTel installation identity
and OS type. Metric dimensions are preserved: removing them before DELTA
accumulation can merge independent streams incorrectly. This means producer
metric labels remain private operator data and require privacy/cardinality
qualification; this is not a public sanitized export profile.

The pinned `deltatocumulative` processor bounds state to 10,000 streams and
five minutes of inactivity. It accumulates in memory; Collector restart or
expiry loses that accumulation. Counter resets, rates and histograms must be
verified against real Station export and restart behavior. The profile must
not present missing samples, dropped streams or exporter refusal as zero.

Trace processing projects the declared operational attributes, replaces span
names, removes status text/events/links, and propagates transformation failures.
No OTLP log pipeline is enabled. Exact pinned-binary validation and injected
private-content refusal remain pending. Grafana reuses the existing dashboard;
a panel or trace ID does not prove delivery or accurate aggregation.

Product storage retains its existing 90-day policy, row/storage caps, schema
checks and synchronous PostgreSQL commit contract. Prometheus retains at most
30 days with a 2-GB retained-block target; WAL/head growth needs separate disk
headroom. Tempo's configured block retention is seven days, not a hard disk
cap. Named volumes and bounded container logs do not constitute a backup.

## Backup, restore and upgrade acceptance

Before upgrades, capture the exact image digests, source manifest and compatible
schema/disclosure protocols. Take a PostgreSQL logical backup under the owning
database authority and snapshot the diagnostic stores through their supported
owners. Restore into a fresh isolated project and private files, never over the
existing owner. Prove acknowledged events, exact deduplication, revocation,
migration state and queries survive receiver/database restart and restored
storage. Retain failed-control stores and records.

Do not remove volumes with `down -v`, edit migration records or strip new grant
fields to make an older binary start. An incompatible upgrade/rollback must
refuse without modifying retained data. Secret-binding documents containing new
telemetry grants need a compatible pre-upgrade backup for older strict readers.
This profile does not yet provide a qualified upgrade/rollback or release
descriptor; those acceptance items remain open in #3458 and #3464.
