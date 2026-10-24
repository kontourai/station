# Station product telemetry receiver

This optional companion accepts Station's disclosed product observations and
stores them in PostgreSQL. Product ingestion is separate from the OTel Collector
and canonical personal usage accounting. An isolated private usage storage
namespace is described below; Core retains person and source authorization. See [Monitoring & Telemetry](../../docs/guides/monitoring.md).

**Status: source implementation; not yet a qualified deployment.** Lite receiver
diagnostics, the existing bundled qualifier, hosted checks and deployment
acceptance are separate evidence. Nothing here deploys a receiver, enables an
author endpoint, or authorizes collecting telemetry from an installation.

The qualified storage profile is PostgreSQL 16 with `fsync` and
`full_page_writes` enabled. Each transaction sets `synchronous_commit=on`.
Transactions use a local `pg_catalog` search path while accessing explicitly
qualified application tables. Schema validation therefore does not depend on
the login role's default search path, including the deployment role named
`station_telemetry`. The caller's session setting is restored after the transaction.
For product ingestion, HTTP 202 means PostgreSQL acknowledged the transaction's commit; a disconnected
or timed-out commit returns a failure. Retrying the same source/event UUID with
the same observation does not insert another event. Reusing an ID with different
content returns 409. This deduplication lasts only while the event is retained.

## Private usage storage

**Source implementation only.** Core sync orchestration, invalidation application,
current receipt/query materialization, enrollment UI and real deployment/native
qualification remain unfinished. This store accepts strict canonical summary
pages; it does not calculate billing or claim current source authority.

Private data lives in `station_private_usage`, outside all product/Lite queries.
The operator service can POST `/v1/operator/private-usage-vaults` with exactly
`{credentialHash}` to register an empty bucket. It receives `created` and the
private store's `receiverEpoch`, never the key. Operator/product credentials
cannot read or write private pages. Only the matching opaque
`Authorization: Bearer stai_<32-byte-base64url-key>` binds a source and accesses
that bucket. Core must keep this purpose-specific key in the verified person's
analytics custody; this is storage capability ownership, not a second person
registry or a replacement for source grants.

POST `/v1/private-usage/pages` takes `PrivateUsageCommit`: an operation UUID,
expected receiver epoch/checkpoint, immutable source binding, captured export
query/page and source mutation revision. The page decoder rejects content fields,
foreign source/scope/snapshot and invalid provenance/money. PostgreSQL commits
observations, checkpoint and operation receipt together. Latest matching operation
replay returns its historical receipt without advancing twice. Different content
under one operation or observation identity conflicts. Unprovisioned keys, changed
source epochs, stale checkpoints, incomplete checkpoint evidence and missing
schema refuse. A new empty store gets a new epoch and rejects prepared writes
for its previous incarnation. That epoch is copied by backups and **does not
fence restored or regrown backups**; private restore reconciliation remains open.

GET `/v1/private-usage/checkpoint?from=YYYY-MM-DD&to=YYYY-MM-DD` returns the store
epoch and committed checkpoint, or null before that window's first commit.
GET `/v1/private-usage/commits/<operationId>` recovers a lost reply. A receipt is a
historical commit result, not current storage/source health. GET
`/v1/private-usage/observations?after=0&highWater=<optional-fixed-head>` pages at
most 100 stored observations with their captured source revisions. It explicitly
reports `sourceAuthority:"not-verified-by-storage"` and retained-only coverage.
Core must validate the current person/source and index state before presenting
live Insights. Independent keys have independent observation namespaces, even
when canonical event/receipt IDs collide.

Storage is bounded to 1,000 buckets, 10,000 operation receipts per bucket, the
configured observation/database limits, 2 MiB bodies and bounded admission.
Retained copies use the approved 1–90 days from first storage; replay does not
renew age. Live-mirror rows are unreadable after the source binding expires.
Expired rows are filtered on reads and physically pruned before listening and
during the existing 30-second maintenance cycle. Offline storage is pruned when
restarted. Checkpoint/receipt metadata may remain for reconciliation. DELETE
`/v1/private-usage/vault` erases that key's facts/checkpoints/receipts and retains a
revoked bucket tombstone; operator provisioning cannot reactivate it.

Focused tests use PostgreSQL semantics through PGlite and mounted HTTP handlers.
They cover rollback between row insertion and checkpoint, lost-reply recovery,
stale writers, namespace isolation, conflicting data, retention, erasure and
missing evidence. They do not prove TCP/fsync, process/host crash recovery,
current source authentication, restored-backup fencing or release qualification.
The existing product-only restore command does not reconcile private usage.

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
| `STATION_TELEMETRY_BROKER_TRUSTED_PROXY` | Optional comma-separated IPv4/IPv6 CIDRs (at most 128); unset trusts no proxy. Empty entries, bare IPs, zone IDs and invalid masks refuse startup |
| `STATION_TELEMETRY_BROKER_CLIENT_IP_HEADER` | Only `cf-connecting-ip` is allowed (also the default); any other value refuses startup, even without trusted CIDRs |

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

After restoring a compatible database, keep receivers stopped and run
`node packages/telemetry-broker/dist/main.mjs --fence-product-sources-after-restore`
with the same private credential configuration. This one-shot operator command
validates existing schema without migrations, revokes active product-source
credentials, closes its pool and exits without serving HTTP or starting
maintenance. It emits `station-product-restore-fence/v1` with product-only scope
and an explicit unreconciled publisher state. No-argument serving is unchanged;
unknown command arguments refuse startup. Observations and publisher privacy
state are not modified. See the [restore boundary](../../deployment/telemetry/README.md#backup-restore-and-upgrade-acceptance)
for snapshot rollback risks, enrollment and remaining qualification limits.

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
| `GET /v1/operator/diagnostics` | Operator Bearer key; process-lifetime `invalidClientIpHeaders` counter, no request values |
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
The Full stream requires the publisher Full choice and acknowledgement of the current
inventory. This address accepts the Full envelope; Lite pings and feedback use
separate public source addresses described in [Lite observations](#lite-observations).
These settings do not configure OTel or authorize personal receipt sync.

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
for at most 60 seconds, reset at UTC midnight, including concurrent reads without
storage work. Rate exhaustion returns 429
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

The runner includes built-entrypoint trusted-proxy startup refusals and scans
all database rows plus captured logs for a trusted `CF-Connecting-IP` sentinel.
It does not certify Station execution, persistent deployment, backup
restore or native shells. Those remain separate from focused HTTP tests and
live-store qualification.

### Built Station sender diagnostic

`node packages/telemetry-broker/qualify-sender.mjs` is a separate macOS diagnostic
against tmpfs PostgreSQL 16, not part of receiver-only qualification. Set
`STATION_TELEMETRY_QUALIFICATION_DATABASE_URL`, build the receiver from a clean
commit, and preserve that `dist` directory before testing a scratch sender merge.
`STATION_TELEMETRY_RECEIVER_DIST` can select that frozen directory;
`STATION_TELEMETRY_SENDER_SERVER` selects the built Station server (default
`dist-server/command-station.js`). Missing prerequisites fail.

If #3791 is not on main, use an uncommitted `git merge --no-commit --no-ff
origin/feat/telemetry-lite-ping` in the isolated lane; resolve documentation
conflicts for the diagnostic only. Temporarily replace the root package version
with a non-SemVer fixture such as `receiver-interop-custom`, run
`npm run build:server`, restore that version, then abort the scratch merge.
Do not commit the merge or claim its dirty metadata fixture as release evidence.
The sender build needs the managed dependencies already installed in that lane.

The runner boots a real built Station twice in an isolated home and instance.
It stops the first process before moving its generated accumulator to yesterday
and marking that prior build's channel unavailable (`unknown`). The next real
sender serializes it; invalid build version maps to `custom`, while distribution
and layouts retain `unknown`. A loopback relay captures exact request/response
bodies and supplies a trusted CF header. The receiver is a real built Unix
entrypoint with its own database. The runner checks 202 acceptance for both daily pings and tier-lowered/privacy
feedback, operator feedback counts, finalized ping marginals and contributor-hash
erasure.

Station runs under `sandbox-exec` with outbound networking limited to loopback.
Because macOS refuses setuid `/bin/ps` there, the fixture uses a private,
unprivileged ad-hoc-signed copy for the real process-birth lock probe. The runner
retains owned failed homes/databases for diagnosis and removes successful ones.
The outer tmpfs PostgreSQL container remains the caller's cleanup responsibility.
This establishes built sender/receiver interoperability for daily pings and feedback;
Cloudflare, container images, persistent deployment and native shells remain
separate acceptance work.

## Lite observations

`POST /v1/lite/:source` accepts one `StationDailyPing` or `TelemetryFeedback` from
`packages/contracts/src/product-telemetry.ts`, validated by the shared
`parseStationDailyPing`. It requires no installation credential. Unknown fields,
unknown nested fields, excessive or duplicate array entries, unlisted registry
IDs or catalog-policy versions, invalid enum/count values, and a channel different from the
source's configured channel are refused with 400. Bodies, including streaming
bodies, are capped at 16 KiB. Responses never echo a rejected value. A committed
202 response is always `{ "accepted": true }`, including a retained
source/event UUID replay with identical content. A changed payload under the
same UUID returns 409. Object order, array-set order and UUID letter case do
not create separate retries. Dedupe ends when raw rows expire.

Feedback uses the shared `TelemetryFeedback` contract and strict
`parseTelemetryFeedback` parser. Its only fields are `publisher`, `action`
(`tier-lowered` or `plugin-uninstalled`) and a fixed reason enum (`privacy`,
`too-much-data`, `performance`, `not-useful`, `unexpected`, `other`).
`skip` dismisses the sender's reason prompt locally and is rejected on the wire.
There is no free text, installation/event ID or sender timestamp. The publisher
must equal the URL source's configured publisher. Daily pings retain their
existing channel/catalog validation; every other shape returns 400.

Migration 7 adds permanent `lite_feedback` rows containing source, publisher,
action, reason, receiver UTC day and a daily contributor-key hash used only for
dedupe. The first feedback per publisher/action/day/key wins, even across source
aliases or changed reasons. Both new rows and committed retries return the
same 202 `{ "accepted": true }` body, without disclosing dedupe state. Feedback uses the same body/admission limits,
trusted-proxy client key, transaction durability and shared Lite row/storage
ceiling as daily pings. `lite_capacity.pings` now counts both retained Lite row
types. The existing closed-day erasure pass clears feedback hashes in bounded
batches even if ping-hash erasure fails. Retention keeps exactly the configured
number of UTC days including today (default 90: today and the prior 89 days). No IP or User-Agent is persisted.
Daily salts and receiver restarts limit contributor identity; these counts do
not measure unique people or installations.

Feedback is available only in the operator views described below. It is excluded
from public aggregates, the public dashboard and third-party publisher APIs in
this PR; no feedback publication/noise mechanism is defined here.

The operator provisions a **public per-publisher/per-channel identifier**, not
a secret embedded in a binary. Example operator-authenticated request body for
`POST /v1/operator/lite/sources`:

```json
{
  "id": "kontour-stable-v1",
  "publisher": "kontour",
  "channel": "stable",
  "registryIds": [],
  "releaseVersions": ["1.2.3"],
  "versionPolicy": "semver"
}
```

The original five fields are required; `versionPolicy` is optional and defaults
to `catalog`. Migration 8 preserves this default for existing sources.
`catalog` accepts only listed `releaseVersions` plus `custom`. `semver` accepts
any valid SemVer up to 64 characters plus `custom`, using the sender's shared
validator, including prerelease/build metadata. Use it for official senders whose
versions are not pre-provisioned. Invalid SemVer still returns 400.
The operator exact view retains every admitted version. Public and publisher
publications use only the independently configured `releaseVersions` for a
`semver` source; they never derive support from observed versions or add a
`custom` version cell for that source. An empty SemVer catalog omits the version
dimension unless another source for the same publisher configures it.
 `publisher` uses the foundation's
`TelemetryPublisherId`: `kontour`, `operator` or `publisher:<public publisher id>`.
Publisher IDs are bounded to 128 characters and retain scoped IDs such as
`publisher:@scope/plugin`. Source IDs are bounded public slugs. The catalogs each
hold at most 1,000 entries. The operator must verify these are **public registry
IDs and public release versions**, rather than accepting arbitrary client
strings. Under the default `catalog` policy, empty catalogs admit only contract
sentinels (`custom` version,
`none`/`custom`/`unknown` distribution, no public plugins). Sources may select
channel `unknown` for a sender without channel metadata; channel equality still
applies. `layouts_customized` also admits `unknown`, never a guessed boolean. To change a catalog, provision
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
in-memory entries. IPv4 rate-limit keys use the address; IPv6 rate-limit keys
use the /64 prefix. Distinct-contributor keys use IPv4 addresses or the coarser
IPv6 /48 prefix, so rotating the 256 /64s in one /56 still supplies one
contributor key. IPv4-mapped IPv6 aliases use the same IPv4 key. The least
recently used entry is evicted at capacity, so new clients remain admissible;
eviction can reset an old client's attempt budget, but never changes its daily
contributor hash. Keys use HMAC-SHA256 with a random process-only salt, replaced
on the next UTC-day request. The salt is never stored. Raw IPs and user agents
never enter SQL, logs, errors, marginals or receipts. By default forwarded-IP
headers are ignored: without `STATION_TELEMETRY_BROKER_TRUSTED_PROXY`, **all
clients behind cloudflared share the connector's key**. NAT also merges contributors.

For a Cloudflare Tunnel, trust only the connector's socket CIDR (ideally a /32
or /128), and keep direct access to the receiver private. Startup rejects /0,
IPv4 ranges wider than /24, IPv6 ranges wider than /64, host bits set in a
network, and surrounding whitespace (including after a comma).
From any trusted-proxy socket, the receiver itself returns 404 except for
`POST /v1/lite/:source`, `GET /v1/public/aggregates`, `GET /public/*` and
`GET /health/live`. This applies even with valid credentials or no client-IP
header. Operator, publisher and Full routes remain accessible only through
non-proxy peers such as loopback or the private tailnet. A trusted peer's
`CF-Connecting-IP` must contain exactly one IPv4 or IPv6 address. Lists, ports,
brackets, zone IDs and garbage fall back to the socket peer and increment the
operator diagnostic counter. A missing header also uses the peer. Untrusted
peers cannot select keys with any header and do not increment that counter.
IPv4-mapped IPv6 peers match IPv4 trusted CIDRs. The selected transient address
feeds both existing HMAC groupings; no raw address is retained or echoed.
`X-Forwarded-For` is always ignored. See the [single-host tunnel
recipe](../../deployment/telemetry/README.md#single-host-cloudflare-tunnel).

Run one receiver process. Restart changes the salt and can count the same
network again that day, inflating distinct contributor counts; multiple
processes have independent salts and limits. This is not a unique-person count
or a Sybil defense. Network grouping provides no authenticity; published support
is fixed and has no contributor threshold to pad. The trusted connector must
supply Cloudflare's header faithfully; do not trust an entire container/host
network or permit other workloads to impersonate it. Disable or sanitize
infrastructure access/error logging. This package does not qualify Cloudflare,
connector or host logging. OHTTP and DAP/Prio remain deferred.

### Storage and activity estimates

Migration 2 introduces lite sources, publisher keys and raw pings. Migration 3
drops the legacy joint-cell table and adds logged `lite_marginals`,
`lite_clients` and `lite_capacity`. Existing joint cells are discarded because
they cannot prove distinct contributors; old raw rows remain subject to
retention but are not reconstructed into publishable marginals. Full-tier rows
are unchanged. Older binaries refuse migration 3. Back up the entire schema and
validate upgrades against a restored private copy. Migration 4 adds a
`publishable` flag to marginals and nullable `client_hash`/`contributions`
columns to raw pings. It discards all pre-migration marginals and contributor
rows: /64-era counts and erased associations cannot prove /48 counts or safe
complements. Existing raw rows, capacity counts and UUID dedupe survive, but
legacy rows do not become publishable. Older binaries refuse migration 4.

Each first insertion stores the daily contributor hash and bounded contribution
arrays, plus a pending job per dimension. Numeric counters use `0`, `1`, `2-5`,
`6-20`, `21+` before finalization; fields already expressed as buckets retain
their buckets. There are no retained joint cells. The maintained capacity counter
avoids a per-ingest raw-table count; raw deletion decrements it in the same
transaction. Admission retains the one-million-lite-ping, 10,000-source/publisher-key
and approximate 1 GiB limits.

Retention and finalization run at startup and in independent hourly jobs.
Finalization commits per dimension, then separately erases contributor hashes and
contribution arrays for each completed publisher/day in batches. The operator
view is exact; published weekly marginals always include the full public domain
with noise. Reads serve stored publications and finalized days only; they never
run or wait for finalization. Raw pings expire after 90 days, including UUID dedupe. Downtime
or a failed sweep delays finalization and erasure; these are periodic operations,
not database TTL guarantees. See [Public aggregates](#public-aggregates) for
migrations 5–6, privacy calibration, bounded jobs and key handling.

Receipt-day pings approximate active installations. Daily first-active-week and
first-active-month counts can be summed over a **complete calendar week or
month** to estimate WAU/MAU. They are not rolling seven/thirty-day unique
counts, and are not exact: retries across period boundaries, late delivery, lost
pings, state resets, multiple publishers and dishonest clients affect them. The
receiver uses UTC arrival day because the strict foundation ping has no producer
date. It does not add an undisclosed date field. The receiver's Node clock
selects the daily salt and PostgreSQL assigns arrival timestamps. Keep their
clocks aligned: a request waiting across midnight or a clock disagreement rolls
back with `503 storage_busy` rather than accepting the wrong day's hash. Retry
after the receiver and database agree on the UTC day. Public responses expose
`databaseDay` from PostgreSQL and are not cached when it disagrees with
the receiver's UTC day. Calendar-period boundaries must agree with sender-local
first-active calculations before interpreting these estimates.

All allowed profile dimensions have histograms: version/channel/platform/arch,
surface and engine sets, age and paired-device buckets, distribution, public
plugins/private-plugin bucket, three customization flags, setup-abandonment,
per-engine failure buckets, and both friction counters. Friction histograms
count **pings at that counter/bucket**, not the sum of failures. Multi-valued
surface/plugin/engine histograms can sum above the number of pings.

### Owner analytics: exact operator view

Kontour's owner analytics are exact. `GET /v1/operator/lite/daily` and
`GET /v1/operator/lite/weekly` require the private operator Bearer `sto_` key.
Publisher keys and anonymous callers receive 401. Responses are `no-store` and
query strings are rejected. Daily covers the last 30 closed UTC arrival days;
weekly covers four closed ISO weeks, Monday through Sunday in UTC. Both read
all publishers and all dimensions from finalized `lite_marginals`, with exact
integer strings for `pings` and `contributors`. They refuse more than 10,000
rows with 422 rather than truncate. No exact route is linked from the dashboard.

Both operator responses additionally include `feedback` rows with `period`,
`publisher`, `action`, `reason` and exact integer-string `count`. Feedback covers
the configured retained UTC-day window (default 90 days: today plus the prior
89 days), including the current partial day/week;
`feedbackWindow` names this separate window. Weekly counts sum the deduplicated
daily rows. Feedback remains queryable after daily contributor hashes are erased,
and disappears when retention deletes its rows. The same 10,000-row refusal
applies independently to feedback.

Daily `contributors` counts distinct daily IPv4/IPv6-/48 network hashes per
value, not people or installations. Weekly `contributors` is the **sum of daily
distinct contributors (contributor-days)**. Daily salts deliberately prevent
cross-day linkage, so exact distinct weekly contributors cannot be reconstructed
from `lite_marginals`. The response names that unit explicitly. Shared networks,
restarts and dishonest clients affect these metrics.

### Public aggregates

`GET /v1/public/aggregates` publishes Kontour's **weekly noisy marginal totals**
for the last four closed ISO weeks (UTC receiver arrival). Authenticated
`GET /v1/publishers/:publisher/aggregates` returns only that publisher's identical
weekly publication. Published fields are channel, version, platform, arch,
surfaces_today, engines_used_today, first_active_this_week,
first_active_this_month, distribution, and public_plugins_enabled. These answer
profile/adoption questions. Counters, friction, setup, age, private-plugin and
customization fields remain available only to the exact operator view.

The public domain is fixed independently of traffic: every enum value, both
boolean values, empty-set `none`, operator-configured `releaseVersions` and
`registryIds`, plus `custom` for catalog-policy version/distribution and `none`
for distribution. SemVer-policy versions contribute only their configured
catalog entries; an empty catalog contributes no public version cells.
All values always receive noise, including true zero. **There is no true-count
k pre-filter.** Nine attacker networks plus a victim cannot change the release
shape. Each publisher gets its own configured catalogs; no other publisher's
versions or registry IDs appear. Catalogs are public configuration and must not
be populated from private observed values. New sources can add at most 1,000
unique versions and 1,000 registry IDs per publisher; domains already exceeding
this bound before migration remain intact. A published week's domain is frozen;
configuration additions first affect weeks not yet published. Revoking a source
does not retract its historical public catalog or publications.

Published counts are **network-days**: for each value, sum the distinct daily
IPv4/IPv6-/48 contributor counts (`clients`) over the seven UTC arrival days.
Repeated pings from one daily key contribute at most one per value/day and seven
per value/week, including eight sender-local daily pings that land in one UTC
week. Installs sharing a network count once per value/day, so NAT causes an
undercount of installations. Operator views retain both exact pings and clients.

Adding/removing one ping changes at most seven scalar coordinates + five
surfaces + eight engines + twenty public plugins = **L1 sensitivity 40**.
Empty sets contribute one sentinel within those bounds. Per-count
**ε=1/(7×40)=1/280** gives **ε≤1/7 per added ping**. If a network contributes at
most 40 distinct coordinates per UTC day, its network-week L1 sensitivity is
**7×40=280**, and **ε≤280/280=1**. The per-value cap alone does not enforce that
40-coordinate premise: pings with different values can cover more coordinates.
For arbitrary network traffic, a conservative bound is **7D/280 = D/40**, where
D is the largest fixed published domain in the response's four-week window.
`maximumPublicCoordinatesPerWeek` and `maximumNetworkWeekEpsilon` compute this
bound from stored publication cells. There is no unconditional install-week
ε≤1 claim or installation identity. Replacement adjacency doubles these
add/remove bounds; multiple weeks and publishers compose.

Every published count uses the pure ε-DP two-sided geometric mechanism, rounded
and clamped nonnegative. Fixed support removes the prior threshold presence
oracle. The implementation approximates ideal randomness with HMAC-SHA-256 and
finite 52-bit uniforms; the mathematical pure-DP statement describes the ideal
mechanism, with cryptographic/finite-precision qualifications for this code.
Unclamped mean absolute error is `2a/(1-a²) ≈ 280` network-days, `a=exp(-1/280)`;
95% of absolute noise is at most 839 network-days. Clamping reduces absolute error near
zero but biases estimates upward. Utility assumes each daily contributing network includes the value:

| Daily networks | Weekly network-days | Mean absolute noise | Relative MAE | 95% absolute noise / weekly total |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 700 | ≈280 | 40% | 839 / 120% |
| 1,000 | 7,000 | ≈280 | 4% | 839 / 12% |
| 10,000 | 70,000 | ≈280 | 0.4% | 839 / 1.2% |

Sparse values have much worse relative utility. Set histograms overlap and must
not be summed to a total; dimensions cannot be joined. First-active flags count
network-days carrying the flag; they are not distinct weekly/monthly installations.
Prior exact or thresholded snapshots cannot be made private retroactively.

Each response has at most **200 cells** (`week`, `dimension`, `value`, `estimate`)
and `nextCursor`. Follow `?cursor=<nextCursor>` until null. Cursors are bounded,
HMAC-authenticated keyset positions scoped to the publisher, not filters.
Unknown/duplicate query parameters, malformed or forged cursors return 400.
Unverified cursors cannot occupy or evict a cached public page. There is no 10,000-row published cap. The dashboard
follows every page and selects its week/dimension locally. It uses text nodes,
same-origin requests, and a CSP with no third-party scripts or analytics.

### Finalization, migration and retention

Migration 6 transactionally adds `lite_publications` (one marker per publisher,
ISO week) and `lite_published` (frozen domain cells and estimates). Migration is
idempotent; older binaries refuse schema 6. The first finalizer after a week
closes atomically claims its marker, snapshots public configuration, sums daily
`clients` per value, and stores every noisy cell. Existing markers are never updated;
re-finalization cannot change published estimates even if exact marginals change.
Noise seeds include mechanism version, publisher, week, dimension and value,
**never the count**. Releasing a changed count with the same seed would expose
an exact difference, so publications must be immutable. Public and publisher
reads, cache refills and repository reopen reuse stored estimates.

Migration 5's 32-byte noise key remains in `lite_noise_key` with `PUBLIC` access
revoked. Restrict service/database-owner and backup access. Back up the complete
schema, including the key, publication markers and cells; never independently
restore/clear the markers or regenerate historical publications. No rotation or
republication API exists. Key compromise reveals the noise. Lost published
estimates cannot safely be replaced with an independent release.

Ingest journals one job per (day,publisher,dimension). Each closed-day dimension
commits its exact counts and job removal in its own transaction. A failed
publisher/day is skipped for that pass while other publishers/days continue.
Separate 500-row transactions erase contributor hashes and contribution arrays
only for publisher/days with no pending dimensions. A stuck dimension retains
its own associations but does not block other publishers' erasure. The original
failure is recorded as a content-free code in the exact operator response's
`finalizationDiagnostics`, with period, publisher and daily/weekly stage. The
latest pass retains at most 100 failures in this process and reports the omitted
count; restart clears diagnostics, while pending database jobs survive. Failed
publisher/week publication transactions are also skipped for that pass. Full/90-day raw retention runs independently;
if it expires inputs before finalization recovers, exact aggregates are incomplete.

Startup and hourly finalization publish only weeks whose end is at or before
the pass's captured UTC-day cutoff, after closing the prior-day arrival fence.
A Sunday pass that finishes on Monday cannot publish the newly closed week;
the next pass waits for Sunday's arrivals and finalizes them first. Reads never
invoke finalization or acquire the ingest admission lock. Public pages share a
bounded 128-page cache refreshed at least every 60 seconds and at UTC midnight,
so later background publications become visible. Hits perform no database work;
at most eight transient misses share pending reads independently of cached pages.
Failures or receiver/database day disagreement are not cached. Publication markers persist beyond the four-week
read window. UTC arrival week can differ from sender-local first-active periods;
keep receiver/database clocks aligned as described above.

### Publisher access and credential availability

An independent publisher credential is `stq_` plus 32 random base64url bytes.
Provision with operator Bearer `sto_` at `POST /v1/operator/lite/publishers`, body
`{ "publisher": "publisher:example", "credentialHash": "<lowercase SHA-256>" }`.
Repeating rotates it; `DELETE /v1/operator/lite/publishers/:publisher` revokes it.
Publisher credentials never ingest or read exact owner analytics.

In-memory digest snapshots classify known Full and publisher keys before database
work. Unknown keys consume separate pre-auth admission; known keys get their own
post-auth budgets. Storage operations recheck authority, preserving immediate
revocation. Snapshots refresh at startup, after mutations, and every 30 seconds.
After a failed refresh leaves the snapshot **60 seconds stale**, authentication
returns **503 credentials_stale**, including for valid keys; it never misreports
401. Fresh unknown/revoked keys return 401. Malformed percent-encoded publisher
paths return 400. Out-of-process changes refresh within the TTL; per-request
storage checks still reject revocations immediately. Credential budgets use a
bounded 10,000-entry LRU; eviction/restart resets a budget.

### Verification

The existing qualifier includes `qualify-lite.mjs`: real local HTTP and
PostgreSQL checks for strict rejection, bounded streaming bodies, replay/conflict,
fixed weekly domains, exact operator authorization, immutable publication, publisher isolation/revocation,
retention, schema refusal, and captured stdout/stderr plus database rows for IPs,
user agents and rejected content. A smaller diagnostic (not a manifest-bound
qualification receipt) is available after building:

```sh
STATION_TELEMETRY_QUALIFICATION_DATABASE_URL=<private-local-qa-url> \
  node packages/telemetry-broker/qualify-lite.mjs
npm run test:focused -- packages/telemetry-broker/src/__tests__/broker.test.ts \
  packages/telemetry-broker/src/__tests__/lite-weekly.test.ts \
  packages/telemetry-broker/src/__tests__/lite-rate-limit.test.ts \
  packages/telemetry-broker/src/__tests__/passive-signals.test.ts
```

The diagnostic creates a uniquely named database, removes it only on success,
and retains failures for diagnosis. Focused broker tests use in-memory PostgreSQL (PGlite) and synthetic socket
bindings to exercise SQL finalization, padding-shape invariance, frozen weekly
noise, exact IPv4/IPv6-/48 contributor counts, operator authorization, migration
rollback and publisher isolation without an external database. PGlite is
a development dependency, absent from the receiver bundle. The focused limiter test uses real HTTP
with a storage refusal fixture and a controlled UTC clock; it does not claim
database ingestion. Passive API tests use a local HTTP fixture, not production.
The real-PostgreSQL harness also floods eight concurrent random bad keys during
twenty valid ingests and loads 100,000 synthetic pings in one closed day. It
blocks a final dimension to prove durable partial progress, independent retention,
resumption and complete contributor-hash erasure, and prints timings and noise
error without a hardware-dependent timing assertion. Neither path qualifies a deployed receiver, public ingestion authenticity,
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
