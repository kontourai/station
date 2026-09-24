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
| `PER_IP_LIMITER` | client address | every route, before any work |
| `PER_TOKEN_LIMITER` | hash of the FCM token or broadcast channel | FCM sends, updates, ends |
| `PER_KEY_LIMITER` | Station key thumbprint | FCM sends, updates, ends |
| `GLOBAL_LIMITER` | one bucket | FCM sends, updates, ends |
| `CHANNEL_PER_IP_LIMITER` | client address | starts (each creates a channel) |
| `CHANNEL_PER_DEVICE_LIMITER` | hash of the push-to-start token | starts |
| `CHANNEL_PER_KEY_LIMITER` | Station key thumbprint | starts |
| `CHANNEL_GLOBAL_LIMITER` | one bucket | starts |
| `CHANNEL_DELETE_LIMITER` | Station key thumbprint | channel deletes |

Rows are listed in the order each route checks them. Workers rate-limit
bindings only offer 10 s and 60 s periods, so every ceiling is per minute; a
per-day device ceiling would need storage the gateway does not have.

APNs ships dark: until both the `APNS_AUTH_KEY` and `APNS_CHANNEL_AUTH_SECRET`
secrets are set (and the ids, bundle list and channel limiters are present),
both `/v1/apns` routes answer 503 without doing any work, and the FCM route is
unaffected.

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
happens only inside a start, which must name a real push-to-start token, and
the start limits (per address, per device, per key, global) bound the rate. A
refused start gives its channel back at once.

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
4. If it recurs, the durable fix is a longer-horizon per-device ceiling (a
   Durable Object or similar), not a larger quota.

## Logs

Invocation logs are off (they would record the signed `Authorization`
header). Only `console.error` lines are kept, and they carry Google's error
code for a failed token exchange and Apple's reason for a refused provider
token, throttling, an unrecognised 404, or a channel left behind after a
refused start, never keys, tokens or payloads:

```sh
npx --yes wrangler@4 tail station-push-gateway --format pretty
```
