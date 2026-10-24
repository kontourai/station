# Private telemetry companion

**Status: source implementation for #3458; not yet a qualified deployment or
published release.** YAML parsing is not Collector, Compose, database or runtime
acceptance. The delivery ledger in [#3464](https://github.com/kontourai/station/issues/3464)
owns the missing execution evidence.

This optional profile runs the [product receiver](../../packages/telemetry-broker/README.md)
and a separate authenticated OTel Collector, Prometheus, Tempo and Grafana.
[`compose.yaml`](compose.yaml) holds the receiver and PostgreSQL and includes
the diagnostic services from [`compose.diagnostics.yaml`](compose.diagnostics.yaml).
The Grafana dashboard is [`dashboards/station.json`](dashboards/station.json).
Grafana uses the plugins bundled in its pinned image. Plugin preinstallation and
automatic updates are disabled: startup must not replace a bundled datasource
with an unpinned download or unload it while an update fails on the read-only
filesystem.
The [developer profile](#developer-profile) runs the diagnostic half alone.
The trace transform clears typed span-event and span-link slices with `nil`.
An empty OTTL list (`[]`) is not a typed slice in the pinned Collector and
causes runtime rejection even when configuration validation succeeds. Keep
`error_mode: propagate`; do not turn projection failures into accepted exports.

Product observations never enter the diagnostic stores. Neither path supplies
personal usage accounting, person identity or an analytics source grant.
Station's normal install enables none of these services or destinations.

## Artifact and private files

A source-bound **build candidate** can be staged outside the checkout:

```bash
npm run build:telemetry-broker
npm run build:telemetry-companion -- /absolute/new-output-directory
npm run verify:telemetry-companion -- /absolute/new-output-directory/candidate
```

Run these from a clean checkout. The packager validates the receiver's captured
build inputs and bundles against that revision, then snapshots the pinned
deployment files and bundles into a new private directory. It refuses an
existing output directory. The generated Dockerfile consumes the bundled
receiver; the packaged Compose profile requires an explicitly selected image
and cannot build from the caller's checkout. Verification rejects changed
files, extra payloads, links, and special files. Keep the output outside the
checkout so it cannot become an input to a later build.

The packager uses the server-owned byte/inventory verifier in
[`telemetry-companion-artifact.mjs`](../../src-server/services/telemetry-companion-artifact.mjs),
then checks receiver provenance and deployment image pins. These checks retain
the build-only boundary. New `install.sh` public-manifest archive installs retain their
signed parent envelope in the sealed version directory; that retained evidence
is not yet wired to companion lifecycle admission and grants no install permit.

`companion-manifest.json` binds the exact file bytes, image digests and source
revision. Its `build-only` scope is mandatory: this unsigned integrity record
is neither publisher authentication nor a release qualification receipt.
It does not authorize installation, change consent or configure a destination.
The managed in-Station lifecycle and qualified release descriptor remain
pending; these commands do not implement that journey.

The maintained source-checkout runtime exercise takes an exact candidate and a
new private output directory outside the checkout:

```sh
npm run qualify:telemetry-companion -- /absolute/candidate /absolute/new-private-output
```

It requires clean matching source and a local Unix Docker endpoint, captures and
verifies the candidate, builds a labelled image, and uses a unique Compose
project, private generated credentials and unused loopback ports. It checks
host storage readiness, credential refusals, network placement, authenticated
synthetic DELTA metric samples (2+3) queried as cumulative 5 through Grafana's
Prometheus datasource, synthetic product commit/replay and the one-shot product
fence before normal receiver restart. It also stops and restarts the diagnostic
services on their retained volumes, then queries the exact previously observed
metric timestamp without sending any more samples.
Docker/HTTP mutation intents precede effects; uncertain outcomes require manual
inspection rather than retry. Commands and response bodies are bounded, and
cleanup stops only the owned project while retaining private files and volumes.

`report.json` is explicitly `synthetic-component-runtime-only` with
`installationAuthority: false`. This command does not yet exercise trace
query semantics, trace/product restart durability beyond the product fence,
fresh backup/restore, real Station
export, version rollback, publisher reconciliation, personal grants or native
acceptance. It is diagnostic evidence, not a qualified release or install permit.

### Station host prerequisite API

`GET /api/operator/telemetry-companion/prerequisites` is an uncached read for
the operator in person, excluding agent-originated and internal-token callers.
It probes the selected local container host. Paired callers additionally
need `orchestration:read`; that scope does not replace operator authorization. The
route checks current operator authority before probing and before returning its
result. It does not start Docker, pull images, create services or enable export.

`artifactEvidence=1` opts into retained-envelope evidence on an available host
result; the SDK requests it, while legacy requests keep the original shape.
For an installer-owned archive, the server re-verifies the retained envelope
with pinned channel-authorized keys, checks source/version and host artifact
selection, and verifies the local companion file inventory. The pane reports
missing or invalid evidence explicitly. `parent-envelope-verified` is still
build-only with `installationAuthority:false`: no original archive-byte
authentication, runtime qualification or installation permission is inferred.

The probe requires a local Unix socket or Windows named-pipe context, Linux
containers on amd64 or arm64, and Compose 2.24 or later. It pins the selected
endpoint for the daemon query instead of resolving a possibly changed context
again. Each CLI invocation has a five-second deadline and bounded output.
Missing CLI, unavailable daemon, remote context, unsupported host and unavailable
Compose are separate typed results; raw daemon errors and socket paths are not
returned. A successful prerequisite read proves host capability only. Qualified
artifact admission, installation, storage readiness and pane controls remain
separate work.

Portable-server builds can include this candidate with
`build:portable-server -- --with-telemetry-companion` after the receiver build.
The archive workflow selects that option and requires the extracted payload in
its smoke check (`--require-telemetry-companion`). The companion's source must
match the server release SHA. Existing signed server manifests authenticate the
whole archive, including these bytes; no additional signing key is introduced.
That authenticates a build candidate, not a qualified companion deployment.
The lifecycle installer must still require companion-specific runtime evidence
before accepting it for installation.


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
instead accepts strict `station_daily` and fixed-enum `TelemetryFeedback` bodies
through a public source ID
mapped by the operator to one publisher/channel. It never needs an installation
secret. Publisher read keys are separate `stq_` credentials provisioned through
the operator boundary. Do not route lite traffic through the authenticated
full-tier endpoint or treat a public source ID as authenticating a binary.

The broker's **owner analytics are exact** at `/v1/operator/lite/daily` and
`/weekly`, authenticated with the private operator `sto_` key. Keep these routes
private at ingress. Daily counts include exact distinct IPv4/IPv6-/48
contributors; weekly counts sum contributor-days, because daily salts prevent
cross-day deduplication. Publisher `stq_` keys cannot read exact analytics. Feedback
counts are grouped by publisher/action/reason and receiver UTC day or week over
the configured UTC-day window (default 90: today and the prior 89 days),
including partial current periods. Daily contributor
hashes serve only dedupe and are erased after the day closes. Feedback is never
included in public or third-party publisher aggregates in this PR.

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
The receiver additionally joins `product-ingress`; Collector and Grafana join
`diagnostics-ingress`. These separate regular bridges enable the explicit
loopback port publications. PostgreSQL, Prometheus and Tempo do not join an
ingress bridge. The front-end services have outbound network connectivity;
the profile does not claim a network-level egress deny for them. Authentication,
separate credentials and disabled Grafana reporting remain required. Neither
bridge joins the product and diagnostic namespaces together.
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
if changing it, update both static addresses, subnet, dynamic `ip_range` and
trusted CIDR together. The `172.30.242.4/30` dynamic pool excludes static .2/.3.
Never trust the edge ranges or the whole Docker subnet: the trust decision is
about the receiver's immediate socket peer. Keep one receiver process.

The ingress rules allow only `/v1/lite/<source>` (one bounded public slug),
`/v1/public/aggregates`, the current `/public/*` assets (`/public/` and
`/public/dashboard.js`), and `/health/live` on the chosen hostname.
Everything else terminates at `http_status:404`, including `/v1/operator/*`,
`/v1/publishers/*` and all Full-tier product routes. No receiver or database port
is published on a non-loopback host address. Provision sources and inspect
`/v1/operator/lite/daily` locally through 44481 or an owned SSH forward with the
operator credential. The receiver independently enforces the same route boundary
for trusted-proxy socket peers, including valid operator/publisher/Full
credentials; only the listed POST/GET methods pass. Non-proxy peers retain
private-route access. Trust configuration refuses broad ranges (/0, IPv4 wider
than /24, IPv6 wider than /64), non-canonical host bits and whitespace at startup.
A source with channel `unknown` admits a sender without channel metadata.
Provision official sources with `"versionPolicy": "semver"` to accept real
build versions without pre-populating `releaseVersions`; the default `catalog`
policy accepts only listed versions plus `custom`. Both policies accept `custom`.
Under `semver`, public/publisher version cells still come only from the fixed
`releaseVersions` catalog; empty means no version dimension from that source.
The operator exact view shows all admitted versions. Distribution/layout unknown
values retain their existing contract.

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

Before public exposure, add a Cloudflare WAF rate-limit rule matching:

```text
http.host eq "telemetry.example.com" and starts_with(http.request.uri.path, "/v1/lite/")
```

Replace the hostname with the provisioned tunnel hostname. A starting policy is
60 requests per 60 seconds per source IP (`ip.src`, with Cloudflare's data-center
characteristic), blocking for 60 seconds. Count every matching request, including
rejected bodies; do not key by the public source slug. Choose supported periods
and mitigation duration for the account's plan and tune with shared-NAT traffic
in mind. See [Cloudflare's rate-limit parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/).
This per-client edge rule reduces starvation of the receiver's global
`liteAdmission` budget by one client. The daily per-network receiver limit
remains in force; distributed traffic and IPv6 rotation still need capacity
monitoring. Validate the actual rule before exposure; this recipe does not
provision or qualify it.

Cloudflared uses error-level diagnostics and Docker's `none` logging driver in
this template; do not enable debug/request logs or log streaming. Independently
review Cloudflare edge analytics, Logpush, security/error events, host logging
and retention. The receiver's no-IP guarantee does not assert that Cloudflare
never processes or retains an IP. No production calls were made to qualify
this source recipe.

## Developer profile

For local Station development, run only the diagnostic services: the same
pinned Collector, Prometheus, Tempo and Grafana, configuration and dashboard,
without the product receiver or PostgreSQL. [`compose.dev.yaml`](compose.dev.yaml)
overrides [`compose.diagnostics.yaml`](compose.diagnostics.yaml) to publish
Prometheus on loopback and to make the diagnostics network a regular bridge,
because Docker publishes no host port for a container attached only to an
internal network.

Create a private directory outside the checkout with two new random
credentials. There is no default password; Compose refuses to start without
`TELEMETRY_PRIVATE_DIR` and refuses to create a missing credential file. On a
rootful Linux host, give the files the owners listed above.

```sh
umask 077
mkdir -p "$HOME/.station-telemetry-dev"
openssl rand -hex 32 > "$HOME/.station-telemetry-dev/otel-key"
openssl rand -base64 24 > "$HOME/.station-telemetry-dev/grafana-password"
chmod 0400 "$HOME/.station-telemetry-dev"/*

export TELEMETRY_PRIVATE_DIR="$HOME/.station-telemetry-dev"
docker compose -f deployment/telemetry/compose.diagnostics.yaml \
  -f deployment/telemetry/compose.dev.yaml up -d
```

| Service | Address | Access |
| --- | --- | --- |
| Collector (OTLP HTTP) | `http://127.0.0.1:44482` | `x-api-key` from `otel-key` |
| Grafana | `http://127.0.0.1:44484` | `telemetry-admin` with `grafana-password` |
| Prometheus | `http://127.0.0.1:44483` | Loopback only |

Traces are in Grafana's Tempo data source (Explore). Point Station at the
Collector with its key, for example:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:44482
export STATION_OTEL_API_KEY="$(cat "$HOME/.station-telemetry-dev/otel-key")"
```

The default project name is `station-telemetry-dev`; override it with
`COMPOSE_PROJECT_NAME`. Stop the stack with the same two `-f` files and `down`.
This profile is for development only. It is not a qualified deployment, and
the diagnostic semantics below apply unchanged.

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
No OTLP log pipeline is enabled. Local synthetic checks of the packaged profile
at `79e77a7f28b` exercised authenticated DELTA samples queried as cumulative
2 then 5 in Prometheus, and a Tempo trace retaining its allowed operation while
removing injected private fields, events, links and trace state. Historical
samples and the same projected trace survived a stopped-process restart without
resending either payload. The run also checked private dashboard credentials,
credential refusals, loopback bindings and backend network membership. These
checks do not qualify real Station export, cardinality/expiry behavior, all
privacy/error paths, fresh restore, other hosts or release installation.
Grafana provisions `dashboards/station.json`;
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

A local product fixture at `79e77a7f28b` acknowledged two synthetic events,
enforced source-scoped receipt lookup and conflicting-event refusal, and
retained receipts, replay deduplication and revocation across receiver/database
restart. Its complete PostgreSQL logical backup restored into a fresh isolated
project with matching row digests for all 14 application tables. The restored
receiver returned the original receipt, deduplicated replay and refused the
source revoked before the snapshot. Public publication tables were empty in
this fixture; this is not a public-release rollback or diagnostic-store backup
qualification.

Snapshot preservation does not preserve authority changes made later. An
additional control revoked a source after the backup: the original receiver
refused it, but the older restored database still accepted its credential.
Managed restore therefore needs current-authority reconciliation or source
credential invalidation before receiver activation. The product-only one-shot
command below now performs that invalidation. Keep all receivers stopped and
start only the restored PostgreSQL service first; use a compatible artifact
that implements the command:

```sh
docker compose --env-file /absolute/private/telemetry.env \
  -f deployment/telemetry/compose.yaml run --rm --no-deps receiver \
  node dist/main.mjs --fence-product-sources-after-restore
```

This invocation publishes no service ports. Require successful process exit and
the `station-product-restore-fence/v1` receipt with `scope: product-sources-only`.
It validates the existing schema without migrations, revokes all active copied
product-source credentials atomically, closes its pool and exits without an
HTTP listener or maintenance timers. Observations, receipts and existing
revocation timestamps remain intact. Source enrollment is explicit afterward.

The command reports publisher state as `unreconciled`: it does not alter
publisher keys, noise keys or publication records, nor prove that an old public
privacy snapshot is safe. Managed restore orchestration and public-state
reconciliation remain unfinished. Do not treat raw snapshot restoration or this
product-only fence as a complete restore/installation qualification.

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
