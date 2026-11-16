# Inbound webhooks

An inbound webhook lets another program start a Station turn with a signed
HTTP request: a CI job, a script or an internal service can ask a named Agent
to work on a message. Each caller gets its own named token and secret, and each
token may start only the Agents and Projects it is granted.

There is no Settings page, API or CLI for creating webhooks. An operator writes
one private JSON file in the Station home. Station re-reads that file on every
request, so changes and revocations apply immediately without a restart.

A [managed policy](managed-policy.md#capability-switches) with
`limits.webhookAutomations: false` refuses every request with `403` and code
`managed-policy-capability-disabled`, before Station reads this file. The file
is kept and stays editable, but nothing in it re-enables webhooks.

Station keeps the route and hands each request to a `webhook` source of
[Telltale](https://github.com/kontourai/telltale) (`@kontourai/telltale`),
which verifies it: the rate limits, the token, the timestamp, the signature
and the replay ledger. Telltale stamps the request as untrusted, because it
came in from outside; the signature proves who sent it, not who wrote its
message. Station then decides what the token may start.

Code: [the route](../../src-server/routes/webhooks/inbound-webhooks.ts), the
[authorization and stores](../../src-server/services/webhooks/) that
Telltale verifies with, and the
[configuration contract](../../packages/contracts/src/inbound-webhook.ts).
Automations that react to events from GitHub and other services are a separate
[proposal](../design/automations.md) and are not built.

## Configure a token

Write `<STATION_HOME>/security/inbound-webhooks.json`, readable only by your
user (`chmod 600`):

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "tokens": [
    {
      "id": "ci-nightly",
      "name": "Nightly CI",
      "secret": "<at least 32 random characters>",
      "starts": [
        { "agentId": "release-checker", "projectSlug": "station" }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Must be exactly `true`, or every request is refused with `disabled`. |
| `tokens[].id` | The value the caller sends in `x-station-webhook-token`: 1 to 128 letters, digits, `_` or `-`. It must not contain any token's secret. |
| `tokens[].name` | A label for you. |
| `tokens[].secret` | The HMAC secret, at least 32 characters. It is stored in this file and never returned by any API. |
| `tokens[].revokedAt` | Present means the token is revoked. |
| `tokens[].starts[]` | What the token may start. `agentId` must match the request's `agent` exactly. `projectSlug` must match the request's `project`; a grant without `projectSlug` allows only requests that name no Project. An absent or empty list allows nothing. |

If the file is invalid, any secret is shorter than 32 characters, or a token
id breaks the format above or contains a secret, Station refuses every webhook
request with `policy_unavailable` and logs a warning naming the problem (an id
problem names the token by its position in the list, never by its id).

## Send a request

```
POST /api/webhooks/inbound
Content-Type: application/json
x-station-webhook-token: <token id>
x-station-webhook-timestamp: <Unix time in seconds, 10 digits>
x-station-webhook-nonce: <16 to 128 letters, digits, _ or ->
x-station-webhook-signature: sha256=<hex HMAC-SHA256>

{"agent": "release-checker", "project": "station", "message": "Check tonight's build."}
```

The signature is HMAC-SHA256 with the token's secret over the timestamp, a
newline, the nonce, a newline and the exact request body bytes. For example:

```bash
body='{"agent":"release-checker","project":"station","message":"Check tonight'"'"'s build."}'
ts=$(date +%s)
nonce=$(openssl rand -hex 16)
sig=$(printf '%s\n%s\n%s' "$ts" "$nonce" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -sS -X POST "$STATION/api/webhooks/inbound" \
  -H 'content-type: application/json' \
  -H "x-station-webhook-token: ci-nightly" \
  -H "x-station-webhook-timestamp: $ts" \
  -H "x-station-webhook-nonce: $nonce" \
  -H "x-station-webhook-signature: sha256=$sig" \
  --data-binary "$body"
```

The body is a JSON object with `agent`, `message` and an optional `project`;
other fields are ignored.
The message is sent to the Agent as written; there is no templating, except
that a webhook token's secret appearing in it is replaced with `[redacted]`. The turn
runs on this Station, in the Project's workspace when `project` is given.

The request does not use a paired-device credential; the signed token is the
credential. The caller still needs a network route to the Station's API or UI
address. Station does not provide public ingress for webhooks, and the
[remote-access threat model](../security/remote-access-threat-model.md)
rejects public tunnels, so callers are normally on the same machine, network or
tailnet.

## What the turn is

A webhook turn starts a new, ephemeral session. It is recorded as the local
operator's but marked unattributed, it is left out of the session list, and it
raises no card alerts. Nobody is present to answer an approval request from
the webhook.

The **Default approval mode** setting applies to the new session, but a
webhook start carries no full-access grant, so Station requests its
workspace confinement for the session rather than host access. What
**Full access** then means depends on the engine:

- **Codex** runs without approval prompts inside that confinement.
- **Claude Code** runs without prompts only when the confinement is both set
  up and observed. Station can refuse the confinement before launch, for
  example because the workspace is too broad or no confined credential is
  available; the start then falls back to automatic approval and records why.
  Even when the confinement is set up, the session switches to running without
  prompts only after Station has observed the engine process inside the
  sandbox.
- **Other engines** without an approval setting ignore it.

The setting's own help text describes unattended sessions as running with no
sandbox; for webhook starts that does not match the code.

A successful request returns `202` with
`{ "success": true, "data": { "conversationId", "providerTurnId", "ephemeral": true } }`.
Station does not call the sender back when the turn ends.

## Responses

A refusal's body is `{ "success": false, "code", "retryable" }`. A request
is checked in four stages, and the first refusal wins. Telltale runs the
first three; Station runs the last, before Telltale records the request in
the replay ledger.

1. **Before the body is read:** the rate limits, then the configuration file,
   the `enabled` switch, the token, its revocation, the timestamp and nonce
   format and the timestamp's freshness.
2. **The body:** it is read, up to 256 KiB and within 10 seconds.
3. **The signature, then the replay ledger.** The body is parsed as JSON
   only after the signature matches. The ledger reserves the token,
   timestamp and nonce.
4. **What it may start:** the body must be the expected JSON object, and the
   token's grants must allow its Agent and Project. A refusal here releases
   the reservation; otherwise the request is recorded as used.

So a request with no signature and a malformed body is refused with
`403 invalid_signature`. A request refused in stage 4 has not used its nonce:
once its token's grants are fixed, the same signed request (a redelivery, for
example) is accepted while it is fresh. A request that gets
`turn_start_failed` has used its nonce: send it again with a new nonce and
signature.

| Status | Code | Cause |
| --- | --- | --- |
| 202 | | The turn started (body above) |
| 403 | `policy_unavailable` | The configuration file is invalid (checked before the token), or the replay ledger cannot be read or written or is full (checked after the signature) |
| 403 | `disabled` | `enabled` is not `true`; checked before the token, so any token ID gets this |
| 401 | `unknown_token` | The token header is missing, malformed or names no token |
| 403 | `revoked_token` | The token has `revokedAt` |
| 400 | `malformed_request` | Stage 1: the timestamp or nonce header is missing, the timestamp is not 10 digits, or the nonce is malformed. Stage 2: the body is over 256 KiB or did not arrive within 10 seconds. Stage 4: the body is not the expected JSON object, or has a message over 200,000 characters |
| 403 | `stale_timestamp` | The timestamp is more than 5 minutes from the server's clock |
| 403 | `invalid_signature` | Stage 3: the signature header is missing, malformed or does not match |
| 403 | `replay` | The token, timestamp and nonce were already used |
| 403 | `forbidden_start` | Stage 4: the token's grants do not allow that Agent and Project |
| 429 | `rate_limited` | Too many attempts (`retryable: true`) |
| 503 | `turn_start_failed` | The request was valid but the turn could not start (`retryable: true`, with a new nonce) |
| 503 | `not_listening` | The webhook intake could not start (`retryable: true`) |
| 403 | `managed-policy-approval-ceiling` | The Agent's engine could only run above the machine's [managed approval ceiling](managed-policy.md#approval-mode-ceiling); `error` names the reason and the support link (`retryable: false`) |

- **Timestamps:** a timestamp more than 5 minutes from the server's clock is
  `stale_timestamp`.
- **Replays:** each token, timestamp and nonce combination is accepted once.
  It is recorded once the signature matches, in
  `<STATION_HOME>/security/inbound-webhook-replays.json`, so a replay is
  refused across restarts. It is kept until the request's timestamp is
  stale, so a replay at exactly 5 minutes is still refused as `replay`. A
  corrupt or unwritable ledger, or one holding 10,000 unexpired entries,
  refuses every request with `policy_unavailable`.
- **Rate limits:** each token ID may make 60 attempts a minute; over that,
  Station answers `429` with `Retry-After`. Separately, after 300 failed
  attempts in a minute from any callers (requests still being checked count
  toward the 300), Station refuses every webhook request,
  including correctly signed ones, for the rest of that minute and sends no
  `Retry-After`. This trades availability for cost during a flood; a caller
  should retry later.

## Audit and monitoring

`<STATION_HOME>/security/inbound-webhook-audit.json` keeps the last 256
outcomes with the time, reason, token ID and the conversation an accepted
request started. It never stores the body, nonce or secret. A flood is
summarized as one entry. Refusals are also logged with the reason: Telltale's
as `webhook request refused`, and Station's stage 4 refusals as
`Inbound webhook refused`. The counter
`station.webhooks.inbound_requests` records each outcome; see the
[metric reference](../reference/metrics.md).

## Limits

- Requests always run on this Station; a webhook cannot target a saved remote
  Environment.
- Behaviour on a hosted (multi-tenant) Station has not been reviewed.
- The route's tests are in
  `src-server/routes/webhooks/__tests__/inbound-webhooks.test.ts`, and the
  replay ledger's in
  `src-server/services/webhooks/__tests__/inbound-webhook-store.test.ts`.
