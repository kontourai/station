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
passes the same per-address, global and per-key rate limits before its body is
parsed. Unknown body keys are refused on every route.

| Route | Body | Answers |
| --- | --- | --- |
| `/v1/fcm/send` | `{ token, packageName, data, collapseKey? }` | 200 sent, 410 unregistered, 422 rejected, 503 unavailable |
| `/v1/apns/live-activity` | `{ bundleId, environment, event: start\|update\|end, pushToStartToken (start only), channelId, registrationId, sealed, alert, timestamp, staleAt (start/update) \| dismissAt (end) }` | 200 sent, 410 `unregistered` (push-to-start token dead), 410 `channel-gone` (create a new channel), 422 rejected, 503 unavailable |
| `/v1/apns/channels` | `{ op: create\|delete, bundleId, environment, channelId (delete only) }` | 200 `{ result: "created", channelId }` or `{ result: "deleted" }` (a channel Apple no longer has counts as deleted), 422, 503 |

A Station never sends APNs JSON. The gateway builds the `aps` payload itself:
the content state is `{ v: 1, rid, sk, sealed }`, where `sk` is the verified
signing key's thumbprint (a caller-supplied `sk` is refused), and the only
readable text is the fixed alert `Station` / `Agent activity`, which the
Station can only switch on or off (`alert`). Priority is derived, never
supplied: 10 for start, end and an alerting update, otherwise 5. Pushes expire
after 300 s. The final APNs body is held to 4096 bytes.

A start is a push-to-start to `/3/device/<token>` (topic
`<bundle>.push-type.liveactivity`) naming the activity's broadcast channel
(`input-push-channel`); updates and ends are broadcasts to
`/4/broadcasts/apps/<bundle>` with `apns-channel-id`. Channels are created and
deleted on `api-manage-broadcast[.sandbox].push.apple.com` (port 2196
production, 2195 sandbox).

APNs' own status and reason are never relayed: they would make the gateway an
oracle for whether a token or channel is live. A `403` from Apple (a bad or
expired provider token, a revoked key) is the gateway's own configuration
fault: the caller gets a retryable 503 and the reason goes to the error log.

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
APNs team and key ids (`APNS_TEAM_ID`, `APNS_KEY_ID`), and six rate limits: per
client address before any work, then global, per Station key and per push
token (a device token or, for broadcasts, a channel id, hashed) on signed
requests only, plus `CHANNEL_GLOBAL_LIMITER` (30/min) and
`CHANNEL_PER_KEY_LIMITER` (3/min per Station key) on channel management.

APNs ships dark: until the `APNS_AUTH_KEY` secret is set (and the ids and
bundle list are present), both `/v1/apns` routes answer 503 without doing any
work, and the FCM route is unaffected.

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

To rotate, create a new key in the Apple developer account, put it, change
`APNS_KEY_ID` in `wrangler.jsonc` in the same deploy, then revoke the old key.
The provider-token cache is keyed on the key's fingerprint, so a new key never
reuses the old key's token. Provider tokens are signed deterministically with
`iat` floored to 45-minute windows, so every Worker isolate presents the same
token and APNs never sees more than one new token per window (it answers 429
`TooManyProviderTokenUpdates` otherwise).

## Channel quota abuse

Apple limits how many broadcast channels an app may hold (the exact quota is
not yet verified), and anyone can mint a
Station key, so channel creation is the resource worth defending. Normal use is
one channel per iOS registration, created lazily and deleted when the
registration is dropped. The channel limiters bound the damage: 3 creates or
deletes per minute per key, 30 per minute across the gateway.

If creates start failing (429 or 503 answers on `/v1/apns/channels`):

1. Check the Worker's request metrics in the Cloudflare dashboard. The gateway
   does not log rate-limited requests (invocation logs are off), so a sustained
   burst of 429s on the channels route is the signature of key minting.
2. Lower `CHANNEL_GLOBAL_LIMITER` and deploy. Existing channels keep working,
   and Stations back off and retry their creates.
3. List the app's channels with a provider token
   (`GET https://api-manage-broadcast.push.apple.com:2196/1/apps/<bundle>/all-channels`)
   and delete the ones no registered Station uses; a Station whose channel
   was deleted gets 410 `channel-gone` on its next update and creates a new one.
4. If it recurs, the durable fix is a per-registration proof (e.g. the phone's
   push-to-start token must accompany a create), not a larger quota.

## Logs

Invocation logs are off (they would record the signed `Authorization`
header). Only `console.error` lines are kept, and they carry Google's error
code for a failed token exchange or Apple's reason for a refused provider
token, never keys, tokens or payloads:

```sh
npx --yes wrangler@4 tail station-push-gateway --format pretty
```
