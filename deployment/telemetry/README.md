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

That source-key provisioning applies to the **opt-in full event stream**.
The [lite receiver](../../packages/telemetry-broker/README.md#lite-observations)
instead accepts strict `station_daily` observations through a public source ID
mapped by the operator to one publisher/channel. It never needs an installation
secret. Publisher read keys are separate `stq_` credentials provisioned through
the operator boundary. Do not route lite traffic through the authenticated
full-tier endpoint or treat a public source ID as authenticating a binary.

The broker's **owner analytics are exact** at `/v1/operator/lite/daily` and
`/weekly`, authenticated with the private operator `sto_` key. Keep these routes
private at ingress. Daily counts include exact distinct IPv4/IPv6-/48
contributors; weekly counts sum contributor-days, because daily salts prevent
cross-day deduplication. Publisher `stq_` keys cannot read exact analytics.

`/public/` and `/v1/public/aggregates` expose Kontour's **weekly noisy estimates**.
Publisher keys receive only their own publisher's weekly publication. The ten
profile/adoption fields use a fixed public domain of enum values and
operator-configured public release versions/registry IDs. Every value, including
true zero, is released with noise; no k threshold or remainder suppression
remains. Catalogs must be independent of private traffic. Per-count ε=1/280,
sensitivity 40 per added ping gives ε≤1/7 per ping. Published counts sum distinct
daily contributor keys per value (network-days); NAT undercounts installations.
With at most 40 coordinates per network/day, week sensitivity is 280 and ε≤1.
Arbitrary traffic can exceed that premise; the API computes the conservative
D/40 network-week bound from its stored public domain. Expected absolute noise
is about 280 weekly network-days; sparse cells
have poor utility. Follow bounded 200-cell cursor pages; the dashboard does this
before selecting a week/dimension locally. See the
[receiver privacy/utility contract](../../packages/telemetry-broker/README.md#public-aggregates).

Schema 6 atomically persists each publisher/week's marker and frozen noisy cells.
Never re-finalize a published week. Back up and restore the complete schema,
including `lite_noise_key`, `lite_publications` and `lite_published`, together;
never clear/regenerate historical publication receipts. Older binaries refuse
schema 6. Run migrations and qualification against an isolated restored copy
before upgrading a persistent receiver.

The private Compose profile does not publish these endpoints on the Internet.
A public deployment must independently qualify TLS, ingress access/error logging
without client IP/user-agent retention, proxy/NAT rate limits, database capacity,
restart and backup/restore. IPv4 or IPv6 /64s select daily rate-limit keys;
IPv4 or IPv6 /48s select daily contributor HMACs. Forwarded headers are ignored
unless the connector socket CIDR is explicitly trusted as described below.
Run one receiver process; restarts change the salt and inflate same-day distinct
counts. A failed publisher/day dimension retains only that publisher/day's
associations while completed publishers' erasure progresses. Public reads never
take the ingest lock; cache hits perform no database work. Clock-disagreement
responses are not cached. Failed credential refresh beyond 60 seconds returns
503, not unauthorized. Raw retention and hash deletion are periodic, and
downtime delays them. No production endpoint or data flow is enabled by this
source change.

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

## Single-host Cloudflare Tunnel

The separate [`compose.tunnel.yaml`](compose.tunnel.yaml) recipe runs only
receiver, PostgreSQL 16 and cloudflared. It reuses the receiver/database service
settings above, including persistent PostgreSQL storage and the numeric-loopback
operator port 44481. It is a deployment template, not evidence of a live tunnel,
backup/restore acceptance or production logging configuration.

Provision a dedicated locally managed tunnel and hostname using
[Cloudflare's configuration-file workflow](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/).
Select a reviewed `cloudflare/cloudflared@sha256:<digest>` as
`TELEMETRY_CLOUDFLARED_IMAGE` in the same private environment file. Add the
existing tunnel's credentials as `tunnel-credentials.json`, readable only by
container UID 65532 (0400). Do not use a tunnel token in command arguments.
Copy/edit [`cloudflared.example.yaml`](cloudflared.example.yaml), replace its
placeholder UUID and hostname, and update the Compose config bind to that
private edited file. The example is inert until deliberately provisioned.

Cloudflared has an outbound edge network and a dedicated internal connector
network. Only cloudflared and the receiver join the latter. Its static connector
address `172.30.242.2/32` is the sole trusted proxy; the receiver also remains on
the private database network. Check that `172.30.242.0/29` is free on the host;
if changing it, update both static addresses, subnet and trusted CIDR together.
Never trust the edge ranges or the whole Docker subnet: the trust decision is
about the receiver's immediate socket peer. Keep one receiver process.

The ingress rules allow only `/v1/lite/<source>` (one bounded public slug),
`/v1/public/aggregates`, the current `/public/*` assets (`/public/` and
`/public/dashboard.js`), and `/health/live` on the chosen hostname.
Everything else terminates at `http_status:404`, including `/v1/operator/*`,
`/v1/publishers/*` and all Full-tier product routes. No receiver or database port
is published on a non-loopback host address. Provision sources and inspect
`/v1/operator/lite/daily` locally through 44481 or an owned SSH forward with the
operator credential. A source with channel `unknown` admits a real sender whose
build lacks channel metadata; empty catalogs admit version `custom` and the
contract's unknown distribution/layout values.

Validate the rendered stack and ingress without starting the tunnel (commands
that follow `run --rm` execute only the local config/rule parser):

```sh
docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.tunnel.yaml config

docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.tunnel.yaml run --rm --no-deps cloudflared \
  tunnel --config /etc/cloudflared/config.yaml ingress validate

docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.tunnel.yaml run --rm --no-deps cloudflared \
  tunnel --config /etc/cloudflared/config.yaml ingress rule https://telemetry.example.com/v1/operator/storage
```

The last command must choose the final 404 rule. Repeat with a publisher route
and a Full-tier route; allowed paths must choose their explicit rules. After
separate host, logging and backup acceptance, the operator can build/start only
this Compose project using the same `build receiver` and `up -d` commands above
with `compose.tunnel.yaml`. These instructions authorize no deployment.

The receiver trusts only `CF-Connecting-IP`, as documented in
[Cloudflare's header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
Disable Pseudo IPv4's overwrite mode and review Worker/subrequest behavior for
this hostname so the selected header represents the intended visitor address.
Without `STATION_TELEMETRY_BROKER_TRUSTED_PROXY`, all tunneled clients share the
connector key for both admission and contributors. With it, an invalid single-IP
header falls back to that same peer key and increments the private
`/v1/operator/diagnostics` counter; no header value is logged or stored.

Cloudflared uses error-level diagnostics and Docker's `none` logging driver in
this template; do not enable debug/request logs or log streaming. Independently
review Cloudflare edge analytics, Logpush, security/error events, host logging
and retention. The receiver's no-IP guarantee does not assert that Cloudflare
never processes or retains an IP. No production calls were made to qualify
this source recipe.

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

## Passive push-ledger queries (read only)

The manual [passive report](../../packages/telemetry-broker/README.md#passive-distribution-report)
uses public npm/GitHub download metadata. The queries below are **documentation
only**: they have not been run against production. Use an owner-authorized
read-only SQLite snapshot or the provider's read-only SQL inspector for the
`ChannelLedger` Durable Object. Do not add a remote query route to the gateway
or run its sweep/triage as an analytics operation.

The authority is [`deploy/push-gateway/src/channel-ledger.ts`](../../deploy/push-gateway/src/channel-ledger.ts).
`channels` records current broadcast channels, including a hashed Station
signing-key thumbprint and bundle. Count only aggregates; do not select hashes,
tokens, channel IDs or device hashes into a report:

```sql
-- Current retained channels only; the normal purge removes channels after 12h.
SELECT environment, bundle_id,
       COUNT(DISTINCT station_key_hash) AS distinct_station_signing_keys,
       COUNT(*) AS retained_channels
FROM channels
GROUP BY environment, bundle_id;

-- Accepted device-start counters for the retained UTC days, across ALL bundles.
SELECT date(day * 86400, 'unixepoch') AS utc_day,
       COUNT(DISTINCT device_hash) AS devices_with_accepted_starts,
       SUM(count) AS accepted_starts
FROM starts
GROUP BY day
ORDER BY day;
```

These measure different populations. A signing key is not a person or a
permanent installation, channels can be deleted before purge, and a device hash
is caller-supplied token material reduced to a hash. `starts` counts accepted
APNs starts, not every app launch. Its retention is bounded by the ledger's
normal purge, so a snapshot is not a historical daily series.

**Daily device starts by bundle cannot be queried from the current ledger.**
`starts` has only `(device_hash, day, count)`; it has no bundle, environment,
Station-key or channel join key. Joining it to `channels` would fabricate an
attribution. Grouping channel creation times by bundle would measure created
channels, including starts APNs may refuse, rather than accepted device starts.
A future bundle-aware counter requires a separately scoped gateway data-model,
retention and privacy change. This receiver lane does not change or query that
production service. Apply a separately reviewed suppression policy before
publishing any ledger-derived aggregates; these SQL results are private operator
data, not part of the broker's public release family.
