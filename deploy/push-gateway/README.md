# Station push gateway

A Cloudflare Worker at `https://push.kontourai.io` that forwards Station-signed
agent-activity messages to Firebase Cloud Messaging (Android) and to APNs as
iOS Live Activity pushes. Design and threat model:
[docs/design/notification-delivery.md](../../docs/design/notification-delivery.md).

It is deliberately outside the pnpm workspace. Its only dependencies,
`@noble/curves` and `@noble/hashes` (deterministic ES256 for the APNs provider
token), are pinned to the same exact versions as root `devDependencies` of the
repository, so a root `npm run dependencies:ci` installs them for the tests,
`tsc` and Wrangler, which bundles them into the Worker on deploy.

## Routes

Every `POST` route takes the same Station-signed `Authorization: Station <jws>`
header (ES256, the body hash bound into the token, at most 120 s lifetime) and
the same per-address limit before any work. Unknown body keys are refused on
every route. After the body is parsed, each route checks its own rate limits
narrowest first and stops at the first refusal, so a request refused by a
narrow limit never spends a wider, shared budget.

| Route | Body | Answers |
| --- | --- | --- |
| `/v1/fcm/send` | `{ token, packageName, data, collapseKey? }` | 200 `sent`, 410 `unregistered`, 422 `rejected`, 503 `unavailable` |
| `/v1/apns/live-activity`, start | `{ bundleId, environment, event: "start", pushToStartToken, registrationId, sealed, alert, timestamp, staleAt }` (no channel) | 200 `{ result: "sent", channelId, channelAuth }`, 410 `unregistered`, 422 `rejected`, 503 `unavailable` |
| `/v1/apns/live-activity`, update | `{ bundleId, environment, event: "update", channelId, channelAuth, registrationId, sealed, alert, timestamp, staleAt }` | 200 `{ result: "sent" }` (plus a fresh `channelAuth` after secret rotation), 403 `channel-unauthorized`, 410 `channel-gone`, 422, 503 |
| `/v1/apns/live-activity`, end | as update, with `dismissAt` instead of `staleAt` | as update |
| `/v1/apns/channels` | `{ op: "delete", bundleId, environment, channelId, channelAuth }` | 200 `{ result: "deleted" }` (a channel Apple no longer has, `404 BadPath` on a delete, counts as deleted), 403 `channel-unauthorized`, 422, 503 |
| `/v1/apns/alert` | `{ bundleId, environment, deviceToken, registrationId, kind, collapseId, sealed }` | 200 `{ result: "sent" }`, 410 `unregistered`, 422 `rejected`, 503 `unavailable` |

Rate-limit refusals are 429 `{ error: "rate limited" }` and malformed bodies
400 `{ error: <reason> }` on every route.

**Channels belong to one activity and are created only inside its start.** A
start creates a broadcast channel on Apple's management host, sends the
push-to-start naming it (`input-push-channel`), and answers with the channel id
and `channelAuth`. If Apple refuses the start, or it never reaches Apple, the
gateway deletes the channel before answering, so a refused start never keeps
quota. The Station deletes an activity's channel through `/v1/apns/channels`
once the activity has ended and been dismissed.

**`channelAuth`** is `"v1." + base64url(HMAC-SHA256(APNS_CHANNEL_AUTH_SECRET,
"station-apns-channel:v1\n" + bundleId + "\n" + environment + "\n" +
channelId + "\n" + <signing key thumbprint>))`. Update, end and delete require
it and it is checked before any per-channel limit, so someone who has only
learned a channel id can neither use the channel nor spend its budget. A token
made with `APNS_CHANNEL_AUTH_SECRET_PREVIOUS` is still accepted, and the 200
then carries a fresh `channelAuth` for the Station to store.

A Station never sends APNs JSON. The gateway builds the `aps` payload itself:
the content state is `{ v: 1, rid, sk, sealed }`, where `sk` is the verified
signing key's thumbprint (a caller-supplied `sk` is refused), and the only
readable text is the fixed alert `Station` / `Agent activity`, which the
Station can only switch on or off (`alert`). A start always carries the alert,
with a sound only when `alert` is true; an update or an end carries it (with
the sound) only when `alert` is true, so a finished run can end its activity
with an alert. Priority is derived, never supplied: 10 for start, end and an
alerting update, otherwise 5. Pushes expire after 300 s. The final APNs body
is held to 4096 bytes.

A start is a push-to-start to `/3/device/<token>` (topic
`<bundle>.push-type.liveactivity`); updates and ends are broadcasts to
`/4/broadcasts/apps/<bundle>` with `apns-channel-id`. Channels are created and
deleted on `api-manage-broadcast[.sandbox].push.apple.com` (port 2196
production, 2195 sandbox).

APNs' own status and reason are never relayed: they would make the gateway an
oracle for whether a token or channel is live. Outcomes follow Apple's reason,
not its bare status: `Unregistered`, `BadDeviceToken` and
`DeviceTokenNotForTopic` on a start mean `unregistered`; `BadChannelId` and
`ChannelNotRegistered` mean `channel-gone` whatever the status (Apple sends
them with 400). On a delete, `404 BadPath` is Apple's answer for a channel it
no longer has, so it counts as deleted; the path is built by this code, and a
wrong one would already fail every create and start. Any other 404 is
`rejected` and logged. A 403 (a bad or expired provider token, a revoked key),
a 429 (Apple throttling the gateway) or `BroadcastFeatureNotEnabled` (the
bundle's app id lacks the broadcast capability) is the gateway's own fault:
the caller gets a retryable 503 and the reason goes to the error log.

**Alerts (#2589).** `/v1/apns/alert` sends a regular alert push to one
device: `/3/device/<deviceToken>`, `apns-push-type: alert`, topic the bundle id
itself, `apns-collapse-id` the caller's `collapseId` (16 to 64 base64url
characters: the Station sends a hash of its id and the notification's, so a
later push for the same notification replaces the shown one), and an
expiration one hour out. `deviceToken` is the app's regular APNs device token,
not a Live Activity token. The visible text is chosen by `kind` from a fixed
vocabulary (`APNS_ALERT_TEXT` in `src/apns-request.ts`): `attention`,
`failed`, `done`, or `hidden` for a surface that hides content. `attention`
and `failed` sound and go out at priority 10; `done` and `hidden` are silent at
priority 5. The body is `{ aps: { alert, sound?, "mutable-content": 1 },
station: { v: 1, rid, sk, sealed } }`: `sk` is stamped like `sk` on a Live
Activity, and `sealed` (at most 3000 characters) is the notification sealed
to the phone, for a Notification Service Extension to open (not built yet, so
the fixed text is what shows). It is limited like a Live Activity update (per
device token, per key, global) and spends no channel budget. `Unregistered`,
`BadDeviceToken` and `DeviceTokenNotForTopic` mean `unregistered`. Not yet
tried against Apple.

### Verified against the APNs sandbox (2026-09-24)

Probed with the real key on a push- and broadcast-enabled test bundle:

- Channel create: `POST …:2195/1/apps/<bundle>/channels` with
  `{"message-storage-policy":1,"push-type":"LiveActivity"}` answers 201 with an
  empty body and the id in the `apns-channel-id` header (24 characters of
  standard base64, `/`, `+` and `=` included). Read (`GET`, same path and
  header) answers 200 with the channel's policy; list is `GET
  /1/apps/<bundle>/all-channels` → `{"channels":[…]}`.
- Delete: `DELETE`, same path and header → 204; an unknown or already-deleted
  channel → 404 `BadPath`.
- Broadcast: `POST /4/broadcasts/apps/<bundle>` with `apns-channel-id`,
  `apns-push-type: liveactivity`, `apns-priority` and `apns-expiration`, no
  `apns-topic` → 200. Without `apns-expiration` → 400 `BadExpirationDate`.
  An `end` carrying the alert at priority 10 → 200.
- Broadcast to a deleted channel → 400 `ChannelNotRegistered`; to an id that
  never existed → 400 `BadChannelId`.
- Push-to-start to a bogus token → 400 `BadDeviceToken`.
- Channel create for a bundle without the broadcast capability → 400
  `BroadcastFeatureNotEnabled`.

Not yet observed live: a successful push-to-start reaching a device, a
production-environment call, and Apple's channel quota.

## Check

The tests run in Station's own vitest corpus, so the merge queue runs them.
From the repository root:

```sh
npm run test:focused -- deploy/push-gateway/test/*.test.ts
npx tsc -p deploy/push-gateway/tsconfig.json
```

## Deploy

The Workers Free plan is expected to be enough (see the CPU caveat below).
Two kinds of choice are involved, and they are kept apart here.

**Plan-shaped choices** (made to fit Workers Free; on Workers Paid, with
1,000 subrequests per invocation, they could be relaxed):

- The sweep runs every three minutes (`*/3 * * * *`, one of Free's five cron
  triggers) and spends at most 45 subrequests per run, at most 40 of them
  deletes, because Free allows 50 subrequests per invocation and every Apple
  call and every ledger call is one. The once-per-run purge and each scope's
  listing and triage come out of the same budget, so 40 is an upper bound.
  With two swept scopes that is about 800 deletes an hour, which outpaces the
  global create ceiling (600 an hour) even if no Station ever deletes.
- A request makes at most six subrequests (a start: the daily count, create,
  record and push, then either the accepted-start count or, on refusal, the
  compensating delete and its record removal).
- Durable Object allowances on Free: 100,000 requests, 100,000 row writes and
  5 million row reads a day. An accepted start costs three ledger requests
  (the daily count, the record, the accepted-start count). Row writes are
  higher than the three rows touched, because each index entry updated is
  billed as a written row: roughly five to seven per start including its
  eventual purge (estimated, not measured against billing). At the global
  create ceiling (10 a minute) that is about 45,000 requests and 72,000 to
  100,000 row writes a day, which is at Free's write allowance, so sustained
  abuse at the ceiling is where Free runs out first. Normal use (a few starts
  per device a day) is far below. Reads are dominated by the sweep, which
  reads each swept scope's live records once per run (every statement uses an
  index: `SEARCH`, never `SCAN`, in `EXPLAIN QUERY PLAN`).
- **Unverified:** Free allows about 10 ms of CPU per request. The first APNs
  provider-token signature in a Worker isolate is pure-JavaScript ES256
  (later ones are cached for 45 minutes), and a large channel list costs CPU
  in the sweep. If a real deploy exceeds the CPU limit, the fix is Workers
  Paid, not a redesign.

**Correctness choices** (would be the same on any plan) are described under
"Channel ledger and sweep" below: the ledger is a Durable Object because it
is a strongly consistent single writer, not because of Free's limits.

```sh
cd deploy/push-gateway
npx --yes wrangler@4 deploy
curl -s https://push.kontourai.io/health          # {"ok":true}
```

The Worker runs on the Cloudflare account that owns the `kontourai.io` zone,
served only on the custom domain (`workers_dev` and preview URLs are off).
Configuration lives in `wrangler.jsonc`: allowed audiences, allowed Android
packages (`ALLOWED_PACKAGES`), allowed iOS bundles (`ALLOWED_IOS_BUNDLES`), the
APNs team and key ids (`APNS_TEAM_ID`, `APNS_KEY_ID`), and the rate limits.

| Limit | Keyed on | Applies to |
| --- | --- | --- |
| `PER_IP_LIMITER` | client address (IPv6: its /64) | every route, before any work |
| `PER_TOKEN_LIMITER` | hash of the FCM token or broadcast channel | FCM sends, updates, ends |
| `PER_KEY_LIMITER` | Station key thumbprint | FCM sends, updates, ends |
| `GLOBAL_LIMITER` | one bucket | FCM sends, updates, ends |
| `CHANNEL_PER_IP_LIMITER` | client address (IPv6: its /64) | starts (each creates a channel) |
| `CHANNEL_PER_DEVICE_LIMITER` | hash of the push-to-start token | starts |
| daily device guard (ledger) | hash of the push-to-start token, per UTC day | starts: 6 accepted a day |
| `CHANNEL_PER_KEY_LIMITER` | Station key thumbprint | starts |
| `CHANNEL_GLOBAL_LIMITER` | one bucket, 10/min | starts |
| `CHANNEL_DELETE_LIMITER` | Station key thumbprint | channel deletes |

Rows are listed in the order each route checks them. The per-key and global
limiters are the abuse bounds. The daily device guard is not: its key is a
hash of a token the Station supplies, so a hostile caller simply varies it.
It protects the phone from an honest Station that has gone wrong, starting
activity after activity all day. It lives in the channel ledger (rate-limit
bindings only offer 10 s and 60 s periods); reading it spends nothing, and the
count rises only when Apple accepts a start, so refusals and the Station's
retries never lock a phone out. The check and the count are separate ledger
requests, so two starts for one device at the same moment can both pass and
overshoot by one; the per-minute device limiter makes that rare. An IPv6
subscriber usually holds a whole /64, so IPv6 addresses are limited per /64
prefix; IPv4 addresses as they are.

APNs ships dark: until both the `APNS_AUTH_KEY` and `APNS_CHANNEL_AUTH_SECRET`
secrets are set (and the ids, bundle list, channel limiters and the
`CHANNEL_LEDGER` Durable Object binding are present), every `/v1/apns` route
answers 503 without doing any work, the channel sweep does nothing, and the FCM
route is unaffected. The Durable Object is declared in `wrangler.jsonc`
(`durable_objects` and a `new_sqlite_classes` migration) and created by the
deploy; nothing to create by hand.

The cron trigger (`*/3 * * * *`) is always deployed; the sweep it runs is a
no-op while APNs is dark.

### Channel ledger and sweep

**Why a Durable Object.** Correctness: the sweep deletes channels the ledger
does not record, so a record must be visible the instant it is written, and
the daily device count must increment atomically. A Durable Object is a
single, strongly consistent writer and gives both. Workers KV is eventually
consistent (a write can take a minute to be seen elsewhere), which opens a
window where the sweep misses a fresh record and deletes a live channel, and
it has no atomic counters. D1 was considered; it is also strongly consistent
but adds a database to provision and migrate for three small tables that one
object holds. The trade-offs, accepted: every create and delete takes an
extra hop to the object's location; one object is a single point of
contention for the whole gateway (fine at the 10-a-minute create ceiling; if
that ever binds, shard the ledger by scope, one object per environment and
bundle, since nothing crosses scopes); and while the object is unreachable
starts are refused with 503.

Apple lets an app hold a finite number of broadcast channels per environment
and never expires them, so a channel nobody deletes is quota lost for good.
Every channel the gateway creates is recorded in the `ChannelLedger` Durable
Object (`src/channel-ledger.ts`: one SQLite-backed object for the whole
gateway, addressed by a fixed name) the moment Apple creates it, with its environment, bundle, creation
time and a hash of the Station key. A record counts for 12 hours (an activity
lasts at most eight and stays dismissible for four more); older rows are
purged by the sweep once per run. A start whose channel cannot be recorded does not go ahead and gives
the channel back, and a start is refused (503) while the ledger is
unreachable. A successful delete, explicit or compensating, removes the
record. The compensating delete after a refused start runs through
`ctx.waitUntil`, so a caller that disconnects cannot cancel it.

Every three minutes the sweep lists the channels of each scope named in
`SWEEP_SCOPES` (`GET /1/apps/<bundle>/all-channels`) and deletes the ones the
ledger does not record. Durable Object storage is strongly consistent, so a
recorded channel is always seen as recorded; the only gap is the moment
between Apple creating a channel and the gateway recording it. Apple's list
carries no creation time, so the ledger notes when it first saw each
unrecorded channel, and the sweep deletes one only after it has stayed
unrecorded for ten minutes. A scope whose ledger or channel list cannot be
read is skipped (an unreadable ledger must never look empty) without stopping
the other scopes. A run makes at most 45 subrequests, of which at most 40
deletes, and logs its counts (`apns channel sweep: {...}`). Apple's list is not
known to page; if it answers with any key besides `channels`, or a length that
is a round hundred of at least 1,000, the sweep logs `may be paged`.

Every leak (a Station that never deletes, a failed compensating delete, a
crash between create and record) is reclaimed within about 12 hours and a few
sweeps. That assumes the sweep keeps up: at the full create load the global
limit allows (600 an hour) the sweep's 800 deletes an hour drain a backlog by
only about 200 an hour, so a large backlog (after an outage, or when a scope
is first swept) takes correspondingly longer.

**Sweep scopes.** The sweep deletes every channel in a swept scope that this
deployment's ledger does not record, so each swept environment and bundle
must have exactly one ledger: never create channels in a swept scope from
anywhere else (`wrangler dev`, a staging deploy, a manual test with the real
key), or they will be deleted. `SWEEP_SCOPES` defaults to production for the
three shipping bundles (`io.kontourai.station`, `.beta`, `.nightly`); the
sandbox environment and `io.kontourai.station.dev.instance` are never swept,
so do development and testing there. An entry naming another environment or a
bundle outside `ALLOWED_IOS_BUNDLES` is ignored and logged, and an empty value
sweeps nothing. Channels leaked in unswept scopes are not reclaimed.

## Credentials

The only secret is `FCM_SERVICE_ACCOUNT`: a JSON key for the Google service
account `station-push-gateway@kontour-station.iam.gserviceaccount.com`, whose
only role is Firebase Cloud Messaging API Admin. The kontourai.io organization
blocks service-account keys; project `kontour-station` alone carries an
exception (`iam.managed.disableServiceAccountKeyCreation` not enforced).

Rotate by piping a new key straight into the secret, so it never touches disk,
then deleting the old key:

```sh
gcloud iam service-accounts keys create /dev/stdout \
  --iam-account=station-push-gateway@kontour-station.iam.gserviceaccount.com \
  --project kontour-station 2>/dev/null \
  | npx --yes wrangler@4 secret put FCM_SERVICE_ACCOUNT
gcloud iam service-accounts keys list \
  --iam-account=station-push-gateway@kontour-station.iam.gserviceaccount.com --managed-by=user
gcloud iam service-accounts keys delete <old-key-id> \
  --iam-account=station-push-gateway@kontour-station.iam.gserviceaccount.com
```

Use `set -o pipefail` when scripting this: a failed `wrangler secret put`
otherwise leaves a created key that nothing holds.

The APNs secret is `APNS_AUTH_KEY`: the `.p8` file of the team-scoped
(sandbox and production) Apple key named by `APNS_KEY_ID`. It never enters
the repository. Load it straight from the downloaded file, then delete the
file:

```sh
npx --yes wrangler@4 secret put APNS_AUTH_KEY < AuthKey_<key id>.p8
```

`APNS_CHANNEL_AUTH_SECRET` is a random secret of at least 32 characters that
signs `channelAuth`:

```sh
openssl rand -base64 48 | tr -d '\n' | npx --yes wrangler@4 secret put APNS_CHANNEL_AUTH_SECRET
```

To rotate it, put the current value into `APNS_CHANNEL_AUTH_SECRET_PREVIOUS`,
put a new `APNS_CHANNEL_AUTH_SECRET`, and delete the previous secret once the
longest Live Activity has had time to refresh its token (eight hours plus the
dismissal window). Every accepted old token is answered with a new one.

To rotate the APNs key, create a new key in the Apple developer account, put it, change
`APNS_KEY_ID` in `wrangler.jsonc` in the same deploy, then revoke the old key.
The provider-token cache is keyed on the key's fingerprint, so a new key never
reuses the old key's token. Provider tokens are signed deterministically with
`iat` floored to 45-minute windows, so every Worker isolate presents the same
token and APNs never sees more than one new token per window (it answers 429
`TooManyProviderTokenUpdates` otherwise).

## Channel quota abuse

Apple limits how many broadcast channels an app may hold per environment
(about 10,000; not yet verified live), channels do not expire, and anyone can
mint a Station key, so channel creation is the resource worth defending. It
happens only inside a start, which must name a real push-to-start token; the
start limits bound the rate (per address and per device per minute; the
abuse bounds are per key and global), and
the ledger sweep bounds the lifetime. At `CHANNEL_GLOBAL_LIMITER`'s 10 per
minute, even a caller who never deletes can hold at most 7,200 channels (12
hours of ledger) in an environment, under the quota.

**Scaling.** When legitimate starts approach 10 per minute, ask Apple for a
larger channel quota and raise the global limit to stay under quota ÷ 720,
check the new peak against the Durable Object daily allowances above (or move
to the Paid plan), and keep the sweep's delete rate (40 a run, every three
minutes) above the create rate. Do not raise the limit alone.

If starts begin failing with 503 (the channel create is refused) or quota
looks low:

1. Check the Worker's request metrics in the Cloudflare dashboard. The gateway
   does not log rate-limited requests (invocation logs are off), so a
   sustained burst of 429s on `/v1/apns/live-activity` is the signature of key
   minting.
2. Lower `CHANNEL_GLOBAL_LIMITER` (and `CHANNEL_PER_IP_LIMITER`) and deploy.
   Running activities keep working; Stations back off and retry their starts.
3. List the app's channels with a provider token
   (`GET https://api-manage-broadcast.push.apple.com:2196/1/apps/<bundle>/all-channels`)
   and delete stale ones. A Station whose channel was deleted gets 410
   `channel-gone` on its next update and starts a fresh activity.
4. If it recurs, lower `CHANNEL_PER_KEY_LIMITER` and `CHANNEL_GLOBAL_LIMITER`
   rather than asking for a larger quota. (The daily device guard does not
   help here: a hostile caller varies the device token.)

**After a bad secret deploy.** If `APNS_AUTH_KEY` is wrong or revoked, every
Apple call answers 403: starts, pushes and deletes all fail with 503 and the
reason is logged (`apns 403 (gateway fault)`). Channels created before the
break, and any whose delete failed, are orphaned but still ledgered. Put the
correct key and deploy; the next sweeps reclaim every orphan once its ledger
record expires, with no manual clean-up. If `APNS_CHANNEL_AUTH_SECRET` was
changed by mistake, every update, end and delete answers 403
`channel-unauthorized`; Stations then drop their activities and start fresh,
and the sweep reclaims the abandoned channels the same way. Restore the old
value as `APNS_CHANNEL_AUTH_SECRET_PREVIOUS` to avoid that churn.

## Logs

Invocation logs are off (they would record the signed `Authorization`
header). Only `console.error` lines are kept, and they carry Google's error
code for a failed token exchange and Apple's reason for a refused provider
token, throttling, an unrecognised 404, or a channel left behind after a
refused start, never keys, tokens or payloads:

```sh
npx --yes wrangler@4 tail station-push-gateway --format pretty
```
