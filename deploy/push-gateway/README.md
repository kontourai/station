# Station push gateway

A Cloudflare Worker configured for `https://push.kontourai.io` that forwards Station-signed
agent-activity messages and sealed Station notifications to Firebase Cloud
Messaging (Android), plus iOS Live Activities and alert pushes to APNs.
The checked-in configuration describes deployment intent; it does not prove
which revision or secrets the hosted Worker currently runs. Design and threat model:
[docs/design/notification-delivery.md](../../docs/design/notification-delivery.md).

It is deliberately outside the pnpm workspace. Its only dependencies,
`@noble/curves` and `@noble/hashes` (deterministic ES256 for the APNs provider
token), are pinned to the same exact versions as root `devDependencies` of the
repository, so a root `npm run dependencies:ci` installs them for the tests,
`tsc` and Wrangler, which bundles them into the Worker on deploy.

## Routes

Every `POST` route takes the same Station-signed `Authorization: Station <jws>`
header (ES256, body hash and audience bound into the token, at most 120 s
declared lifetime with 60 s clock tolerance). Configured POST routes apply the
same per-address limit before reading up to 8 KiB of body or checking signatures.
Unknown body keys are refused on
every route. After the body is parsed, each route checks its own rate limits
narrowest first and stops at the first refusal, so a request refused by a
narrow limit never spends a wider, shared budget.

| Route | Body | Answers |
| --- | --- | --- |
| `/v1/fcm/send` | `{ token, packageName, data, collapseKey?, priority? }` — `data.station_kind` is `agent_activity` or `station_notification`; `priority` (`high` default, or `normal`) only for a notification | 200 `sent`, 410 `unregistered`, 422 `rejected`, 503 `unavailable` |
| `/v1/apns/live-activity`, start | `{ bundleId, environment, event: "start", pushToStartToken, registrationId, sealed, alert, timestamp, staleAt }` (no channel) | 200 `{ result: "sent", channelId, channelAuth }`, 410 `unregistered`, 422 `rejected`, 503 `unavailable` |
| `/v1/apns/live-activity`, update | `{ bundleId, environment, event: "update", channelId, channelAuth, registrationId, sealed, alert, timestamp, staleAt }` | 200 `{ result: "sent" }` (plus a fresh `channelAuth` after secret rotation), 403 `channel-unauthorized`, 410 `channel-gone`, 422, 503 |
| `/v1/apns/live-activity`, end | as update, with `dismissAt` instead of `staleAt` | as update |
| `/v1/apns/channels` | `{ op: "delete", bundleId, environment, channelId, channelAuth }` | 200 `{ result: "deleted" }` (a channel Apple no longer has, `404 BadPath` on a delete, counts as deleted), 403 `channel-unauthorized`, 422, 503 |
| `/v1/apns/alert` | `{ bundleId, environment, deviceToken, registrationId, kind, collapseId, sealed }` | 200 `{ result: "sent" }`, 410 `unregistered`, 422 `rejected`, 503 `unavailable` |

**Compatibility.** Deploy a compatible gateway before a Station that sends
`station_notification`: an older gateway answers such a message 400
(`unsupported station_kind`) and the Station logs it as refused. Refusing
unknown top-level keys is part of the current contract; verify older deployed
senders against that contract before a rollout.

Rate-limit refusals are 429 `{ error: "rate limited" }`; malformed bodies are
400 `{ error: <reason> }`. Authentication failures return 401, oversized bodies
413, unconfigured delivery 503, unknown paths 404 and unsupported methods 405.
`GET /health` returns `{ "ok": true }` without checking credentials, Apple,
Google or the ledger. A provider's `sent` result means it accepted the request,
not that a phone displayed or the user read it.

**Channels belong to one activity and are created only inside its start.** A
start creates a broadcast channel on Apple's management host, sends the
push-to-start naming it (`input-push-channel`), and answers with the channel id
and `channelAuth`. A failed start schedules a compensating delete through
`ctx.waitUntil`; the response can precede cleanup, and failed cleanup leaves
quota occupied until a later sweep. A timeout may also mean Apple accepted the
start without the gateway observing its response. The Station deletes an activity's channel through `/v1/apns/channels`
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

APNs' raw status and reason are not relayed. The normalized outcomes still
distinguish a rejected device token or missing channel. Outcomes follow Apple's reason,
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
`failed`, `done`, and for a surface that hides content `hidden-urgent` or
`hidden` (the same neutral text; urgency stays separate, so hiding content
never quiets an urgent alert). `attention`, `failed` and `hidden-urgent` sound
and go out at priority 10; `done` and `hidden` are silent at priority 5. The body is `{ aps: { alert, sound?, "mutable-content": 1 },
station: { v: 1, rid, sk, sealed } }`: `sk` is stamped like `sk` on a Live
Activity, and `sealed` (at most 3000 characters) is the notification sealed
to the phone. The
[Notification Service Extension](../../src-desktop/ios/StationNotificationService/NotificationService.swift)
now delegates opening and validation to
[SealedAlertDelivery](../../src-desktop/plugins/agent-activity/ios/Sources/StationNotificationServiceCore/SealedAlertDelivery.swift).
It replaces text only after validation; failure or expiry preserves the fixed
fallback text. This source wiring is not physical delivery proof.
Nothing in the gateway binds a device token to a Station key,
so a stranger who learns a token can send it fixed-text alerts with a key of
their own: the route is therefore limited first by its own
`ALERT_PER_TOKEN_LIMITER` (6 a minute per device token, whichever key signs;
without the binding the route answers 503), then like a Live Activity update
(per device token, per key, global). That ceiling is shared by every signer,
the owner's Station included, so a stranger who knows a token can starve its
alerts for the minute (the Station drops refused alerts to its inbox); a
per-signer ceiling would instead let fresh, free keys buy fresh budgets. It spends no channel budget. `Unregistered`,
`BadDeviceToken` and `DeviceTokenNotForTopic` mean `unregistered`. No current
live Apple alert result is established by the deterministic tests below.

### Recorded APNs sandbox observations (2026-09-24)

The earlier implementation recorded these observations on a push- and
broadcast-enabled test bundle. They are retained protocol history, not a fresh
deployment or device receipt:

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

The source was designed around a small Worker deployment. Its enforced bounds
are independent of the account's current plan:

- The configured cron runs every three minutes. A sweep spends at most 45
  counted Apple/ledger calls and at most 40 deletes. Purge and each scope's
  listing/triage share that budget, so 40 is an upper bound, not promised output.
- A start makes up to six Apple/ledger calls across request and compensating
  cleanup. Accepted starts normally read the daily count, create and record a
  channel, send the push and increment the count.
- One SQLite Durable Object owns the channel ledger and daily increments. The
  single object is a contention point; the check-and-increment daily admission
  is still split across requests.
- Provider signing, channel-list size and SQL work consume resources beyond
  these call counts. The source and unit tests do not establish deployed CPU
  time, billing, provider quotas or plan sufficiency.

The former Free-plan request/write/read estimates were planning arithmetic,
not measured billing evidence. Before choosing or changing a plan, the deployment
owner should verify current allowances and measure actual load. Sharding by
bundle/environment would require a coordinated change to ledger ownership and
sweep scope; it is not a configuration switch implemented here.

```sh
cd deploy/push-gateway
npx --yes wrangler@4 deploy
curl -s https://push.kontourai.io/health          # {"ok":true}
```

The configuration serves only the custom domain (`workers_dev` and preview
URLs are off); deployment requires the appropriate account and zone authority.
Configuration lives in `wrangler.jsonc`: allowed audiences, allowed Android
packages (`ALLOWED_PACKAGES`), allowed iOS bundles (`ALLOWED_IOS_BUNDLES`), the
APNs team and key ids (`APNS_TEAM_ID`, `APNS_KEY_ID`), and the rate limits.

| Limit | Keyed on | Applies to |
| --- | --- | --- |
| `PER_IP_LIMITER` | client address (IPv6: its /64, with mapped IPv4/NAT64 handling) | configured POST routes before body/signature work |
| `PER_TOKEN_LIMITER` | hash of the FCM token, APNs device token or broadcast channel | FCM sends, alerts, updates, ends |
| `PER_KEY_LIMITER` | Station key thumbprint | FCM sends, alerts, updates, ends |
| `GLOBAL_LIMITER` | `global` key in the rate-limit binding | FCM sends, alerts, updates, ends |
| `ALERT_PER_TOKEN_LIMITER` | hash of the APNs device token | alerts: 6/min, before the shared token/key/global limits |
| `CHANNEL_PER_IP_LIMITER` | client address (IPv6: its /64) | starts (each creates a channel) |
| `CHANNEL_PER_DEVICE_LIMITER` | hash of the push-to-start token | starts |
| daily device guard (ledger) | hash of the push-to-start token, per UTC day | starts: 6 accepted a day |
| `CHANNEL_PER_KEY_LIMITER` | Station key thumbprint | starts |
| `CHANNEL_GLOBAL_LIMITER` | one bucket, 10/min | starts |
| `CHANNEL_DELETE_LIMITER` | Station key thumbprint | channel deletes |

Each route checks its applicable narrow limits before shared limits, as shown
in [gateway.ts](src/gateway.ts). Wrangler's rate-limit bindings are per-location
and eventually consistent; even a bucket named `global` is not a globally
serialized quota ledger. Their numbers are abuse controls, not hard worldwide
admission guarantees. The daily device guard is not an abuse bound: its key is a
hash of a token the Station supplies, so a hostile caller simply varies it.
It protects the phone from an honest Station that has gone wrong, starting
activity after activity all day. It lives in the channel ledger (rate-limit
bindings only offer 10 s and 60 s periods); reading it spends nothing, and the
count is attempted only when Apple accepts a start. Count persistence is best
effort. The check and increment are separate ledger requests, so concurrent
starts can pass the same earlier count and exceed six; a failed count can also
undercount. An IPv6
subscriber usually holds a whole /64, so IPv6 addresses are limited per /64
prefix; IPv4 addresses as they are.

APNs ships dark: until both the `APNS_AUTH_KEY` and `APNS_CHANNEL_AUTH_SECRET`
secrets are set (and the ids, bundle list, channel limiters and the
`CHANNEL_LEDGER` Durable Object binding are present), every `/v1/apns` route
answers 503 without doing any work, the channel sweep does nothing, and the FCM
route is unaffected. The Durable Object is declared in `wrangler.jsonc`
(`durable_objects` and a `new_sqlite_classes` migration) and created by the
deploy; nothing to create by hand.

The checked-in cron trigger is `*/3 * * * *`; the sweep it runs is a
no-op while APNs is dark.

### Channel ledger and sweep

**Why a Durable Object.** The sweep must read committed channel records before
deciding what to delete. [ChannelLedger](src/channel-ledger.ts) uses one
SQLite-backed object, addressed by the fixed name `channel-ledger`, to own
those records and atomic daily count increments. This avoids relying on an
eventually consistent record lookup. It adds a hop and a contention point;
unreachable ledger reads refuse starts with 503.

After Apple creates a channel, the gateway records its environment, bundle,
creation time and a hash of the Station key before sending the start. A record
counts for 12 hours, the implementation's activity-plus-dismissal retention
window; older rows are purged by the sweep once per run. A start whose channel
cannot be recorded does not go ahead and schedules compensating deletion.
A start is refused (503) while the ledger is
unreachable. A successful delete, explicit or compensating, removes the
record on a best-effort basis. The compensating delete after a refused start runs through
`ctx.waitUntil`, so a caller that disconnects cannot cancel it.

Every three minutes the sweep lists the channels of each scope named in
`SWEEP_SCOPES` (`GET /1/apps/<bundle>/all-channels`) and deletes the ones the
ledger does not record as live. The durable record read and the Apple create
are separate operations, so a gap exists between creation and recording. The
channel-list contract consumed here has no creation time, so the ledger notes when it first saw each
unrecorded channel, and the sweep deletes one only after it has stayed
unrecorded for ten minutes. A scope whose ledger or channel list cannot be
read is skipped (an unreadable ledger must never look empty) without stopping
the other scopes. A run makes at most 45 subrequests, of which at most 40
deletes, and logs its counts (`apns channel sweep: {...}`). Apple's list is not
known to page; if it answers with any key besides `channels`, or a length that
is a round hundred of at least 1,000, the sweep logs `may be paged`.

This is eventual cleanup, not a maximum leak lifetime. Recorded channels become
eligible after 12 hours, then unrecorded channels require a ten-minute observed
grace. Provider/ledger outages, incomplete listings and delete failures delay
reclamation. Scopes are traversed in configured order with one shared budget;
a sustained backlog in an early scope can defer later scopes repeatedly. The
current code has no rotating scope cursor or per-scope reserved budget.

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

FCM requires `FCM_SERVICE_ACCOUNT`, a service-account JSON key. The historical
deployment uses `station-push-gateway@kontour-station.iam.gserviceaccount.com`;
the code parses the account supplied by the secret rather than fixing that
identity. Its live IAM roles and any organization-policy exception must be
checked by the deployment owner. APNs requires the separate secrets below.

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
`iat` floored to 45-minute windows. Isolates with the same credentials and
window derive identical tokens; rotated credentials intentionally produce a
different token. This reduces redundant token updates without proving that
Apple will accept a particular deployment's requests.

## Channel quota abuse

The gateway treats Apple's channel quota as finite and plans for channels that
need explicit deletion. Anyone can mint a Station key, so channel creation is
the resource worth defending. It happens only inside a start, which must name
a syntactically valid push-to-start token; Apple decides whether it is real. The
start limits bound the rate (per address and per device per minute; the
abuse bounds are per key and global), and
the ledger sweep attempts later reclamation. The old estimate of 7,200 channels
from 10/minute over 12 hours is not a hard bound: rate limits are per-location,
cleanup can lag, and the actual Apple quota requires separate confirmation.

**Scaling.** When legitimate starts approach 10 per minute, ask Apple for a
confirmed channel quota, measure admission across Worker locations and check
ledger/CPU capacity. Keep successful reclamation ahead of actual channel growth
and account for scope starvation. Do not raise the limit using the 12-hour
estimate alone.

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
correct key and deploy; later sweeps can reclaim orphans after expiry and grace,
subject to their scope, availability and budget limits. If `APNS_CHANNEL_AUTH_SECRET` was
changed by mistake, every update, end and delete answers 403
`channel-unauthorized`; Stations then drop their activities and start fresh,
and the sweep reclaims the abandoned channels the same way. Restore the old
value as `APNS_CHANNEL_AUTH_SECRET_PREVIOUS` to avoid that churn.

## Logs

The configuration disables invocation logs to avoid collecting signed request
headers. Code diagnostics use `console.error` for token exchange/configuration
errors, provider reasons, failed compensation and sweep counts. It does not
intentionally log request bodies or credentials; provider error text is still
external input. Actual hosted log collection depends on the deployed settings.

```sh
npx --yes wrangler@4 tail station-push-gateway --format pretty
```

## Source owners and evidence

[worker.ts](src/worker.ts) composes configuration and cron;
[gateway.ts](src/gateway.ts) owns request ordering and normalized outcomes;
[station-auth.ts](src/station-auth.ts) verifies signed envelopes.
[FCM](src/fcm.ts) and [APNs](src/apns.ts) own provider calls, timeouts and
response classification. [ChannelLedger](src/channel-ledger.ts) and the
[sweep](src/apns-sweep.ts) own retention and reclamation.

The [tests](test/) exercise signed requests, mocked provider responses,
real local SQLite ledger behavior and cleanup failures. They do not deploy
Workers, contact Apple/Google or prove device display. Keep deployment,
provider acceptance and physical notification receipts separate.
