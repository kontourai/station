# Station Lite telemetry Worker

A Cloudflare Worker configured for `https://telemetry.kontourai.io` that
receives Station's Lite usage telemetry: one identifier-free `station_daily`
ping per installation per UTC day, plus fixed-enum `TelemetryFeedback`. It
needs no home server or database. All state lives in one SQLite-backed Durable
Object. It also serves the public weekly aggregates page and a private owner
dashboard.

**Status: source only.** Nothing here is deployed, and no Cloudflare resource,
secret or sender endpoint is created by merging it. The checked-in
configuration describes deployment intent, not what a hosted Worker runs.

Like the [push gateway](../push-gateway/README.md), this Worker sits outside
the pnpm workspace and has no dependencies of its own. It imports the shared
contract parsers (`@kontourai/station-contracts`, `@kontourai/station-shared`)
and the Lite receiver rules from
[`packages/telemetry-broker/src/lite-core.ts`](../../packages/telemetry-broker/src/lite-core.ts).
A root `npm run dependencies:ci` makes these importable for tests and `tsc`, and
Wrangler bundles them on deploy.

## One contract, two receivers

The [Node receiver](../../packages/telemetry-broker/README.md#lite-observations)
(PostgreSQL) and this Worker share `lite-core.ts`. That module covers:

- validation through the shared `parseStationDailyPing` and
  `parseTelemetryFeedback`, and the source channel and publisher checks;
- ping normalization and marginal values, both driven by `STATION_DAILY_FIELDS`;
- daily network keys and the per-network attempt budget;
- source provisioning rules;
- the fixed public domain, noise and publication cells;
- signed publication cursors;
- the exact operator and public response shapes, and error codes to HTTP status.

Each receiver keeps only its storage adapter, its transactions and its clock.
A field added to `STATION_DAILY_FIELDS` therefore reaches both receivers'
operator marginals and this Worker's dashboard without receiver edits.
Public release stays limited to the hand-reviewed `PUBLIC_FIELDS` list.

## Routes

Public routes:

| Route | Answers |
| --- | --- |
| `POST /v1/lite/<source>` | 202 `{ "accepted": true }` for a new ping, a retained replay and any feedback; 400 `invalid_daily_ping`; 401 `source_unauthorized`; 409 `event_conflict` for a changed payload under a retained event UUID; 413 `body_too_large` over 16 KiB; 429 `receiver_rate_limit` (edge limit, `Retry-After: 60`) or `lite_rate_limit` (60 attempts per network per UTC day, `Retry-After: 86400`); 507 `storage_limit` |
| `GET /v1/public/aggregates[?cursor=]` | Kontour's noisy weekly marginals, at most 200 cells per page. Unknown or repeated parameters and forged cursors return 400 `invalid_cursor` |
| `GET /public/`, `/public/dashboard.js` | The public weekly aggregates page |
| `GET /insights`, `/insights/insights.js` | The owner dashboard page. Static: it holds no data until the operator key is entered |
| `GET /health/live` | `{ "state": "alive", "scope": "worker" }`, without touching storage |

Operator routes require `Authorization: Bearer <OPERATOR_KEY>`. A missing or
wrong key returns 401 `operator_unauthorized`. While the secret is unset, these
routes return 503 `operator_unconfigured`; ingestion still works.

| Route | Answers |
| --- | --- |
| `POST /v1/operator/lite/sources` | 201 `{ "created": true }`; 400 `invalid_source`; 409 `source_conflict` |
| `DELETE /v1/operator/lite/sources/<source>` | `{ "revoked": true \| false }` |
| `GET /v1/operator/lite/daily`, `/weekly` | The exact operator view, same shape as the Node receiver's. Query strings are refused |
| `GET /v1/operator/lite/insights` | Exact pings per day for every dimension and value, from the first of the month three months back through today. Today, and any closed day not yet finalized, is counted live and listed in `provisionalDays` |
| `GET /v1/operator/storage` | Database bytes, retained rows, and their ceilings |
| `GET /v1/operator/diagnostics` | `invalidClientIpHeaders` since this object instance started |

Everything else returns 404. That includes the Full-tier product, private-usage
and incident routes, which this Worker does not implement, and the publisher API
(`/v1/publishers/*`, `/v1/operator/lite/publishers`). No third-party publisher
exists yet; adding that API would reuse `lite-core.ts`.

## State and lifecycle

[`src/receiver.ts`](src/receiver.ts) defines the `LiteReceiver` Durable Object.
It is a single writer, so it gives the same guarantees the Node receiver gets
from running one process. Each request runs its SQL inside one
`transactionSync`, so a refused write leaves nothing behind.

- **Client address.** The Worker reads `CF-Connecting-IP`. Anything that is not
  one bare address keys as `unavailable` and is counted in diagnostics. Attempt
  budgets key by IPv4 address or IPv6 /64. Distinct-contributor keys use the
  IPv4 address or the IPv6 /48. The address is never stored, logged or echoed.
- **Daily salt.** A random salt for the current UTC day is stored in object
  storage (`lite_salts`), so an evicted and reconstructed object keys a
  network the same way all day. Keeping it in memory instead would re-key
  networks after every eviction and inflate contributor counts. The day's
  first arrival deletes every other day's salt, and the alarm deletes closed
  days' salts even without traffic.
- **What erasure covers.** After a day closes, its salt and contributor hashes
  are erased from live storage: no route, export or operator can read or
  recompute them. They are not erased from the platform's storage history.
  Durable Object point-in-time recovery can restore the whole object, SQL
  data included, to any moment in the past 30 days, which would bring back a
  deleted salt and the hashes erased since. Restoring this object is
  forbidden by policy (see the restore warning below), so that history is
  reachable only by deliberately breaking the policy, by someone with access
  to the Cloudflare account, and only for those 30 days.
- **Closed days stay closed.** A day closes once a later day has begun or
  maintenance has passed it. An arrival for a closed day (the clock stepped
  back) is refused with 503 `storage_busy`, as the Node receiver refuses a
  day mismatch, and no second salt is created for it.
- **Finalization and erasure.** An alarm runs once per UTC hour. For each closed
  publisher/day it computes exact marginals and erases that day's contributor
  hashes and contribution arrays in one transaction. Finalization happens once
  per publisher/day: a pending row that appears for a finalized day has its
  key erased but never changes the day's marginals, and the pass records
  `day_already_finalized`. It then clears feedback
  hashes for closed days. A failed publisher/day is skipped, retried on the
  next pass and recorded as a content-free code in the exact view's
  `finalizationDiagnostics`.
- **Weekly publication.** Each of the last four closed ISO weeks is published
  once per publisher, after all of its days are finalized. Every cell of the
  fixed domain gets noise, including true zeros. The marker and the cells
  commit together and are never rewritten.
- **Retention.** Raw pings and feedback keep 90 UTC days including today
  (`LITE_RETENTION_DAYS`). Retention also ends replay deduplication. Finalized
  marginals and publications are kept.
- **Ceilings.** `LITE_MAX_ROWS` (1,000,000 retained pings plus feedback) and
  `LITE_MAX_BYTES` (1 GiB of database) refuse ingestion and provisioning with
  507.

Differences from the Node receiver:

- The attempt budget lives in object memory and resets if the object is
  evicted. The Node receiver's budget resets on restart.
- Raw-ping retention is counted in UTC days instead of a rolling 90 × 24 hours.
- Finalization diagnostics persist from the latest pass instead of living in
  process memory.
- There is no restore fence. **Never restore this object with Durable Object
  point-in-time recovery.** It would roll back publication markers, and a week
  published twice under the same noise seeds exposes the exact difference. It
  would also bring back erased salts and contributor hashes (see *What erasure
  covers*).
- Public aggregate pages are cached in Cloudflare's cache for at most 60
  seconds and never past UTC midnight.

## Rate limits

`wrangler.jsonc` binds three Workers rate limiters. They replace the edge WAF
rule the [tunnel recipe](../../deployment/telemetry/README.md#single-host-cloudflare-tunnel)
recommends. They are per location and eventually consistent, so treat them as
cost ceilings, not accounting:

| Binding | Applies to | Key | Limit |
| --- | --- | --- | --- |
| `LITE_PER_IP_LIMITER` | every `POST /v1/lite/*`, including refused and oversized bodies | IPv4 address or IPv6 /64 | 60 per 60 s |
| `LITE_GLOBAL_LIMITER` | `POST /v1/lite/*` that passed the per-network limit | one shared key | 1,200 per 60 s |
| `READ_PER_IP_LIMITER` | public aggregate cache misses and every operator request, checked before the key | IPv4 address or IPv6 /64 | 60 per 60 s |

The limiters' `namespace_id`s (4201–4203) must not collide with other Workers
on the same account; the push gateway uses 4101–4110.

## Cost on the Workers Free plan (estimate)

Each accepted ping is one Worker request and one Durable Object request. It
writes the ping row and its index entry and increments the capacity counter.
Erasure and retention later write it twice more. That is roughly six rows
written per ping over its life. Workers Free allows 100,000 Durable Object rows
written per day, which suggests roughly 15,000 accepted pings per day. **This is
arithmetic, not measured billing.** Before relying on a plan, check Cloudflare's
current allowances and the account's usage graphs. Dashboard loads read about
one row per stored marginal in their window plus today's pings.

## Deploy (owner)

Prerequisites: the `kontourai.io` zone on the Cloudflare account that deploys,
and an authenticated `wrangler` (`npx --yes wrangler@4 login`).

```sh
cd deploy/telemetry-worker
npx --yes wrangler@4 deploy --dry-run --outdir /tmp/telemetry-worker  # bundle check only
npx --yes wrangler@4 deploy
# Generate the private operator key and keep it in the owner's password manager.
printf 'sto_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
npx --yes wrangler@4 secret put OPERATOR_KEY      # paste the key at the prompt
curl -s https://telemetry.kontourai.io/health/live
```

The first deploy creates the Durable Object class (migration `v1`), the custom
domain and its DNS record. The configuration serves only the custom domain;
`workers_dev` and preview URLs are off.

**Domain ownership.** `telemetry.kontourai.io` is declared here as a
`custom_domain` route, the way the push gateway declares `push.kontourai.io`.
As planned for the push gateway, the domain will later be adopted by
infrastructure-as-code and removed from `wrangler.jsonc`.

Provision one source for Station. It lists every release ring's channel;
each ping carries its own channel, and a channel the source does not list is
refused with 400. The publisher comes only from this mapping:

```sh
curl -s -X POST https://telemetry.kontourai.io/v1/operator/lite/sources \
  -H "Authorization: Bearer $OPERATOR_KEY" -H 'content-type: application/json' \
  -d '{"id":"station","publisher":"kontour","channels":["nightly","preview","stable"],"registryIds":[],"releaseVersions":[],"versionPolicy":"semver"}'
curl -s -H "Authorization: Bearer $OPERATOR_KEY" https://telemetry.kontourai.io/v1/operator/storage
```

A source's catalogs and channels cannot be edited. To change them, provision a
new source ID and revoke the old one with
`DELETE /v1/operator/lite/sources/<source>`.

An empty `releaseVersions` with `semver` admits every valid version but
publishes no public version cells. To publish version estimates, list the
public release versions, which are frozen per published week. Every ring's
senders post to `https://telemetry.kontourai.io/v1/lite/station`, the one URL baked into official
builds through `STATION_AUTHOR_TELEMETRY_ENDPOINT` (see
[author telemetry in official builds](../../docs/guides/release-rings.md#author-telemetry-in-official-builds)).
Setting that variable is a separate owner-gated activation.

## View the dashboards

- `https://telemetry.kontourai.io/insights` asks once for the operator key and
  keeps it in this browser's `localStorage` for that origin. **Forget key**
  removes it, and a refused key is removed automatically. The page shows:
  - daily active installs, with today's partial day dashed;
  - weekly and monthly actives, from the `first_active_this_week` and
    `first_active_this_month` flags;
  - new installs per day (`install_age_bucket` `0d`) and their cumulative count;
  - favorite harness, platform, architecture, channel, version adoption and
    surfaces used;
  - a panel for every per-engine bucket dimension. A token-throughput panel
    appears once pings carry that field.

  Counts are pings, about one per active installation per day. They are not
  unique people.
- `https://telemetry.kontourai.io/public/` charts the last four published weeks:
  weekly active networks and per-dimension bars, each bar its own noisy
  estimate. It never adds cells together, and it names a top harness or
  platform only when that value clears the noise. Values are network-days with
  privacy noise, not people.

Both pages load only same-origin script under a `script-src 'self'` policy and
write data through `textContent`.

## Check

```sh
npm run test:focused -- deploy/telemetry-worker/test/ingest.test.ts \
  deploy/telemetry-worker/test/lifecycle.test.ts deploy/telemetry-worker/test/pages.test.ts
node scripts/tsc-slot.mjs -p deploy/telemetry-worker/tsconfig.json --noEmit
npx tsx deploy/telemetry-worker/test/preview-server.ts 48792   # seeded local preview
```

The tests run the real `LiteReceiver` class and SQL over Node's SQLite, reached
through the same namespace binding and fetch protocol the Worker uses.
`restart()` replaces the object over the same database to model eviction. The
page tests run the served scripts in jsdom against the Worker's own answers.
The preview server seeds synthetic pings through the receiver's own ingest and
maintenance and serves both pages locally. `--with-tokens` adds a simulated
token dimension to preview that panel.

**Limits of this evidence.** A local `wrangler dev --local` run exercised
ingest, replay, conflict, refusals, operator auth, the insights and exact views,
storage, the public route, the pages and the per-IP limiter under the Workers
runtime. The alarm path ran only under Node's SQLite. Nothing here establishes
deployed behavior, custom-domain routing, Cloudflare's logging and retention,
limiter accuracy, or plan sufficiency.
