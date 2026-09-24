# Station push gateway

A Cloudflare Worker at `https://push.kontourai.io` that forwards Station-signed
agent-activity messages to Firebase Cloud Messaging. Design and threat model:
[docs/design/notification-delivery.md](../../docs/design/notification-delivery.md).

It is deliberately outside the pnpm workspace: no dependencies, TypeScript run
directly by Node's type stripping for tests and bundled by Wrangler for deploys.

## Check

```sh
cd deploy/push-gateway
node --test test/*.test.ts                       # unit and handler tests
npx tsc -p deploy/push-gateway/tsconfig.json     # from the repository root
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
packages, and four rate limits (per client address before any work, then
global, per Station key and per push token on signed requests only).

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

## Logs

Invocation logs are off (they would record the signed `Authorization`
header). Only `console.error` lines are kept, and they carry Google's error
code for a failed token exchange, never keys, tokens or payloads:

```sh
npx --yes wrangler@4 tail station-push-gateway --format pretty
```
