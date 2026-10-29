# Discord gateway

The Discord gateway lets named Discord users continue an existing Station
conversation by posting in a Discord channel. Station connects to Discord as a
bot, checks each message against a local allowlist, sends the text to the
conversation the channel is bound to, and posts the reply back to the channel.

It is off by default. There is no Settings page, CLI command or environment
variable for it yet: an operator writes one private JSON file in the Station
home and restarts Station.

The runtime starts the gateway in
[station-runtime.ts](../../src-server/runtime/bootstrap/station-runtime.ts). The
service, authorization and stores live in
[src-server/services/discord/](../../src-server/services/discord/), and the
configuration contract is
[packages/contracts/src/discord.ts](../../packages/contracts/src/discord.ts).

The messaging core in
[services/chat-apps](../../src-server/services/chat-apps/) owns durable links,
bindings, refusal and delivery receipts, and the per-app kill switch. Migration
[025-chat-apps.ts](../../src-server/domain/migrations/025-chat-apps.ts) creates
append-only tables in the existing `<home>/data/orchestration.sqlite` store.
This extraction is source preparation: its tests, typechecks and runtime
behavior have not been validated in this lane (`NOT_RUN (capacity)`).

## What it does and does not do

- It handles ordinary messages in allowlisted server (guild) channels. It does
  not handle direct messages.
- Each allowed channel is bound to exactly one existing Station conversation.
  The gateway does not create conversations, choose an Agent or pick a
  Project: the bound conversation's own Agent, workspace and Project apply.
- Only text is read. Attachments on a Discord message are ignored, and replies
  are text only.
- One turn runs per bound conversation at a time. A message that arrives while
  a turn is running is refused, not queued.
- A Discord message continues the bound conversation, so it runs with that
  conversation's existing approval posture and confinement. The gateway grants
  no extra access: it carries no full-access grant and records no approval
  decision. The gateway has no way to answer a tool approval request from
  Discord; a turn that asks for approval waits in Station.

## Set it up

1. Create a Discord application and bot in the Discord developer portal,
   invite the bot to your server with permission to read and send messages in
   the channels you will use, and copy the bot token.
2. Find the IDs you need. With Discord's developer mode on, copy the server
   (guild) ID, each channel ID, and the user ID of every person who may send
   work. Find the Station conversation ID for each channel you want to bind.
3. Write `<STATION_HOME>/security/discord-gateway.json`. `STATION_HOME` is the
   home of the Station that should answer, for example
   `~/.station/instances/nightly` for a Nightly install. Restrict the file to
   your user (`chmod 600`): Station does not change the permissions of a file
   you write by hand, and the file holds the bot token.
4. Restart Station. The gateway connects only at startup, and only when
   `enabled` is `true` and a token is set; it keeps using the token it read
   then for its connection.

A minimal file:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "token": "<bot token>",
  "guilds": [
    { "guildId": "<guild id>", "channelIds": ["<channel id>"] }
  ],
  "identities": [
    {
      "discordUserId": "<discord user id>",
      "stationIdentity": "<station user who owns the conversation>",
      "capabilities": ["turn:start", "transcript:read"]
    }
  ],
  "sessionBindings": [
    {
      "guildId": "<guild id>",
      "channelId": "<channel id>",
      "sessionId": "<station conversation id>"
    }
  ]
}
```

## Configuration file

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Required. |
| `enabled` | boolean | The gateway connects only when this is exactly `true`. Absent means off. |
| `token` | string | The bot token, stored inline. There is no secret binding or environment variable for it. The token is never included in API responses or telemetry. |
| `guilds[]` | `{ guildId, channelIds? }` | The channel allowlist for each server. An absent or empty `channelIds` allows no channel in that server. |
| `identities[]` | `{ discordUserId, stationIdentity, revokedAt?, capabilities?, projectFileProjects? }` | Who may act and as which Station user. See [Identity mapping](#identity-mapping). |
| `sessionBindings[]` | `{ guildId, channelId, sessionId }` | Which Station conversation each channel reaches. Each guild and channel pair may appear once, and each `sessionId` may be bound to only one channel. |

Every string must be non-empty. One invalid entry, such as an unknown
capability or a duplicate binding, makes the whole file invalid. Unknown extra
keys are ignored.

A missing file means the gateway is off. An invalid file at startup logs
`Discord gateway configuration is unavailable` and leaves the gateway off;
Station itself keeps running.

## Scoping

A message is considered only when all of these hold:

- it is a new message in a server channel (Station subscribes to guild
  messages only, so direct messages never arrive);
- its author is not a bot;
- its text is not empty;
- its server is listed in `guilds` and its channel is in that server's
  `channelIds`.

Other messages are dropped without a reply. Station does not check whether the
bot was mentioned.

Station does not request Discord's privileged message-content intent. Discord
normally delivers message text without that intent only for messages that
mention the bot, so in practice members probably need to @mention the bot, and
the mention text then becomes part of the prompt. This has not been verified
against a live bot.

## Identity mapping

Discord users are matched by their stable user ID only; display names never
authorize anything.

- `stationIdentity` is the Station user the message runs as. It must be a user
  allowed to read the bound conversation, normally its owner. Otherwise the turn
  fails to start.
- `capabilities` lists explicit grants. An absent list grants nothing.
  - `turn:start` lets the user send a message that starts a turn.
  - `transcript:read` lets the reply include the assistant's text. Without
    it, Station only posts that the turn completed and a relative Station link
    (`/?surface=activity&session=<id>`).
  - `turn:stop` and `project-files:read` (with `projectFileProjects`) are part
    of the contract, but the gateway does not use them yet.
- Adding `revokedAt` (any value) deactivates a mapping immediately.

The first use imports the validated private configuration once. Each imported
link retains the exact `stationIdentity`, per-person capabilities, Project
slugs and revocation state as legacy provenance. Non-canonical legacy revocation values are converted to an import-time revocation. Duplicate user mappings
retain the first mapping's authority, even when that first mapping is revoked.
Entries with non-snowflake Discord IDs are unreachable and set aside; the import logs counts by kind without the IDs. Other unrepresentable configuration fails closed with a diagnostic. The import separately retains the guild/channel allowlist: importing a binding
does not allow its channel. Absent grants or channel lists remain empty. The
bot token is not imported.

An imported `stationIdentity` is still a legacy user ID, not a verified
principal ID. Continuing an existing conversation uses the same orchestration
authorization as before. This extraction does not grant new Task-start,
Project-membership or approval authority.

The file is re-read as an additional ceiling for every authorization decision.
Revoking a person, removing a grant or channel, or removing/changing a binding
takes effect without a restart. Adding authority to the JSON after import does
not add links or widen imported grants. New management writes belong to the
later linking lane; there is no Settings or CLI management path in this slice.
A message from a person who is not linked, is revoked or lacks `turn:start`
gets no reply in Discord. A durable link revocation cannot be undone by
reimporting the old file.

Authorization for a reply is checked again when the turn completes, against
`transcript:read`. If the sender lost access while the turn ran (the mapping
was revoked, the capability removed or the channel taken off the allowlist),
Station does not post the answer, but it still posts "Station completed the
turn" with the relative Station link for that session.

## Replies

Station replies with an ordinary channel message, not a threaded reply. The
reply is visible to everyone who can read the channel, so bind a channel only
where every reader may see that conversation's answers. Text over Discord's
2,000 UTF-16-unit limit is split at grapheme boundaries into ordered messages.
A single oversized grapheme is split at code-point boundaries. At most ten
messages are sent per reply: if it exceeds that cap, the tenth is a notice
linking to the conversation in Station.

Station answers in the channel when it cannot run a turn:

| Reply | Cause |
| --- | --- |
| This channel is not bound to a Station session. | The channel is allowed but has no `sessionBindings` entry. |
| A Station turn is already running for this channel. Please wait for it to finish. | The bound conversation has a turn in progress. |
| Station could not confirm that this turn started. Do not retry automatically. | The turn was submitted but Station could not confirm it began. |
| Station could not start this turn. | The turn was refused, for example because `stationIdentity` cannot read the conversation. |

## Failure behaviour and limits

- **Restart needed:** turning the gateway on takes effect at the next Station
  start, and the gateway connection keeps the token it read then. Replies are
  sent with the token currently in the file, so changing the token while
  Station runs splits the two until a restart. Setting `enabled` to `false`
  while Station runs stops replies, but not message handling; restart Station
  to stop the gateway completely.
- **Kill switch:** a separate persisted per-app switch refuses new inbound
  work and outbound sends, and prevents connection on restart. It does not
  cancel a turn already submitted to orchestration. Its service write seam
  requires a current operator-authority callback; the later management lane
  supplies the authenticated UI/route caller.
- **Disconnects:** Station reconnects after one second and resumes the Discord
  session when it can. There is no backoff, and an invalid token is retried
  every second rather than reported.
- **Rate limits:** a failed reply, including one refused by Discord's rate
  limit, is logged as `Discord message delivery failed`. Sending stops at the
  failed or unconfirmed chunk; completed chunks are not replayed.
- **Pending replies:** Station records each turn it is waiting on in
  `<STATION_HOME>/runtime/discord-turn-relays.json` so a reply survives a
  restart. The record is cleared before the completion reply is sent, so a
  crash during delivery does not replay earlier or uncertain chunks. A turn that is
  aborted rather than completed may leave its record behind, and the channel
  then keeps answering that a turn is already running.
- **Hosted Stations:** a Station running in hosted tenant mode cannot start
  turns from Discord; every message receives "Station could not start this
  turn."

## Monitoring

Station counts gateway events in `station.discord.gateway_events`, with one
`outcome` attribute such as `connected`, `authorized`, `unmapped_identity`,
`turn_started`, `relay_delivered` or `delivery_error`. See the
[metric reference](../reference/metrics.md). Log lines use fixed text and never
include message content.

The core also appends refusal and delivery receipts to SQLite, without the
token or message text. A busy inbound refusal is linked to its acknowledgement.
Each reply chunk has its own receipt; the final notice records overflow.
Pending receipts precede external sends; a confirmed
outbound receipt retains Discord's message ID. A transport that returns no
message ID leaves delivery pending/unknown. Errors do not cause retries, and
an uncertain submission stays pending. These receipts have no public read
route in this slice.

## Evidence and limits

The behaviour above was traced from the service code and its tests in
`src-server/services/discord/__tests__/discord-gateway-service.test.ts` and
`src-server/runtime/bootstrap/__tests__/station-runtime-discord-forwarder.test.ts`.
Those tests use a simulated gateway. Live Discord behaviour (the mention
requirement, invalid-token close codes, messages inside Discord threads) and
whether a pending tool approval on a Discord turn ever times out are not
verified.
