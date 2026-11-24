# Notification delivery on native shells

> **Reading status: historical mobile failures plus current push design and recorded receipts.**
> [Native capability reporting](../../src-desktop/src/lib.rs), the
> [publisher](../../src-server/services/notifications/agent-activity-publisher.ts),
> [registration routes](../../src-server/routes/operations/native-push-routes.ts),
> and [client registration](../../src-ui/src/platform/native/agentActivity.ts)
> own the current path. Early foreground-only tables predate the push work.
> Provisioning and delivery-status entries retain their recorded evidence;
> this review did not inspect a live gateway, provider account, installed app,
> or physical phone, and does not claim that those deployments remain current.
> Beta is retired by [#4929](https://github.com/kontourai/station/issues/4929);
> historical Beta provisioning receipts below do not grant a current runtime
> or push-delivery identity. Current release channels are Stable and Nightly.

The contract for how a Station notification reaches the person who needs to act
on it, and why the obvious implementations do not work.

## The problem

Station raises notifications server-side — a device asking to pair, an approval
waiting. The web app receives them over SSE and shows a toast. On a phone that
is not enough: the moment you are looking at something else, the toast has
nobody to show itself to, and the thing you are being asked to approve expires
in five minutes.

## In-app outcomes and durable conditions

[ToastContext](../../src-ui/src/contexts/ToastContext.tsx) owns short client
outcomes, stable operation IDs, explicit deduplication keys, and async action
feedback. Updating an ID changes the existing card. Actionable messages group
only when a caller supplies a deduplication key; the current callbacks replace
the earlier ones. Reading time pauses while a card is hovered, focused, expanded,
queued, or the app is hidden. Visibility uses viewport intersection and document
visibility; it does not detect an overlapping dialog or another occluding surface.
Actions that transfer from Station details close that dialog before reporting their
outcome in a toast. Failed actions stay available to retry; an action can name
why it failed instead of the generic line. A toast's dismissal callback runs once
when the toast is dismissed. A dismissed transient card stays inert while its
exit animation finishes. A card displaced by stack overflow returns to the queue
immediately so its reading timer pauses. The dismissal callback is what
[General Undo](../../src-ui/src/components/undo/undoable-actions.tsx) uses to
commit a deferred write, or to drop it when Station changes.
[NotificationContainer](../../src-ui/src/components/notifications/NotificationContainer.tsx)
adds **Troubleshoot** to an error-tone toast that has fewer than two actions
and is not one of troubleshooting's own (`troubleshoot-*` deduplication keys);
see [troubleshoot with an agent](troubleshoot-in-app.md).
On touch, a sideways swipe dismisses a transient toast. Approval and pairing
cards keep their explicit dismiss. When the phone Inbox is open, it reserves
space for the displayed notification stack so the scope and search controls
stay reachable. Taller stacks and the Inbox list scroll independently.

Server-backed silent notifications remain in History and do not play a
browser sound or show a transient toast. An otherwise audible turn completion
keeps its category sound. The existing foreground check suppresses the toast
for the chat the person is reading.

[NotificationsPage](../../src-ui/src/pages/NotificationsPage.tsx) shows local
recent messages separately from server attention. Persistence is opt-in through
caller-approved `recallText`, bounded by count and age, and scoped to the selected
Station on this device. Raw messages, metadata, details, and actions are not
persisted as recall. Switching Stations clears active notices and rejects stale
scoped callbacks. Approval requests retain their separate server-backed lifecycle.

Durable connection, pairing, local-service, and recovery conditions live in
[Station details](../../src-ui/src/components/notifications/StationConditions.tsx),
reachable through the existing Station control. Work restrictions also appear in
the workspace; setup-return guidance stays inline with the setup journey. The
client no longer mounts a global banner stack. Updates have a separate unified
[Updates panel](../../src-ui/src/components/updates/UpdatesPanel.tsx), with distinct
app and connected-server mechanisms. None of these local surfaces replaces
background push delivery.

## External transcripts

Threads followed from another app (`controlMode: read-only-attached`) do not
raise Station completion or approval notifications. The
[completion producer](../../src-server/services/orchestration/turn-completion-notifications.ts)
and [approval producer](../../src-server/services/approvals/approval-inbox.ts)
check Station's recorded ownership before scheduling a notification, so those
transcript events produce no notification popup, sound, desktop alert, Web Push,
or native mobile alert. External transcripts are also excluded from Android
activity cards and iOS Live Activities by the
[shared card phase selector](../../src-server/services/notifications/agent-activity-card.ts),
using ownership carried by the
[publisher's summary projection](../../src-server/services/notifications/agent-activity-publisher.ts).

They remain available in Activity and the imported conversation reader. A
Station-owned session using an external engine, or a new Station-owned
continuation of an external transcript, keeps its ordinary notification
behavior. Automation triggers are separate from this notification policy.

## Finished alerts: one per completion episode

"Your agent finished" means the work is done, not that one turn ended. The
[completion producer](../../src-server/services/orchestration/turn-completion-notifications.ts)
holds a `done` or `replied` outcome. It writes the record once nothing holds
it and no turn has started for `FINISHED_ALERT_CONFIRM_MS` (5 s). This window
avoids announcing completion between a finished turn and an immediately queued
follow-up. One completion episode per thread gets one alert. A later turn's
completion joins the episode and its turn id names the record. So a user turn
followed by Claude's own reply after a background
child settles is one "finished", not "finished" then "replied". An episode
made only of engine-opened turns reads "replied".

Completion, failure and stop notices name the chat when Station has its
title and explain what to review there. The link uses the Session ID.
Provider response text and raw errors are kept in the chat. Device settings
that hide notification previews still apply.

What holds it ([finished-alert-hold.ts](../../src-server/services/orchestration/finished-alert-hold.ts),
read by `OrchestrationService.readFinishedAlertHold`, plus the inbox's
`hasWaitingFollowUp` composed in
[runtime-route-support.ts](../../src-server/runtime/routes/runtime-route-support.ts)):

| Fact | Holds |
| --- | --- |
| A running child of kind `agent` (engine subagent or Station delegate) | Always |
| A running `command` or `monitor` child | Only while not `backgrounded` |
| An owned child session running, or a cascade stop pending | Always |
| The adapter's `hasOpenEngineWork` | Only when the child-work record is not reported, absent, or lists nothing running |
| Claude's `provider/follow-up-pending` (5 s) | Always |
| A follow-up queued, being placed, or unconfirmed in the inbox | Always |

Child-work carries no "the agent is awaiting this" signal. `backgrounded`
("outlives the turn that spawned it") is the closest fact, so a dev server
left running in the background never holds "finished". Claude counts every
background shell task as open engine work, so the engine flag alone is not
trusted when the record can classify what is running. A hold is read again
on events that can release it (child-work, session exit and state, any
turn terminal, a session projection update such as Claude's pending
follow-up expiring) and every `FINISHED_ALERT_RECHECK_MS` (10 s) while held.
A hold that cannot be read fails open and the alert is sent.

Failures, stops, approvals and questions are not held: a failure or stop ends
the episode and is pushed at once, and the held finish is never sent. The
listener retains the reported Stop for the existing settlement window so a
duplicate terminal for that turn cannot announce a finish. A
Station-delegated child whose result returns to its parent conversation
(#3158's owner record) announces no finish of its own. The parent's own
completion covers it, and the parent's finish is held while the child runs.
Its failures, approvals and questions still notify.

The record is written when the alert is decided, not earlier and later
upgraded, so the in-app list never shows "finished" while work runs. The
coordinator wake reads the same `NOTIFICATION_DELIVERED` frame, so it wakes on
the settled finish.

Each finish persists in `finished-alert-episodes.json` in the Station home as
it moves through three states, at most one row of each per thread:

- `held`: a hold or the confirmation window still applies.
- `writing`: the release was decided. This row is saved before the record
  is written, and nothing is announced if that save fails (the next recheck
  tries again). A failed write keeps the row, gives the card no release, and
  is retried after 10 s, doubling to at most 10 min, with each failure
  logged.
- `released`: the record exists. The row is saved before the card hears of
  the release and is kept for the card's two-minute alert window. If that
  save fails, the card is still told (the record exists), and a restart
  reads the row as `writing`, finds the record and does not write it again.

A restart replays the rows by state. A `released` row inside the window
restores the card's release. A `held` row is read again with no turn open and
sent once nothing holds it. A `writing` row is looked up by its dedupe tag
before anything is written:

- No record: it was either never written, cleared by the person, or removed
  by [retention](../reference/config.md#notification-retention) after it
  settled, and the saved state cannot tell these apart. The replay is dropped and logged as
  `replay_ambiguous`: no notification is written, no phone is pushed, the
  coordinator is not woken, and the card gets no release. Without a record of
  what the person cleared, this recovery is not exactly-once.
- This producer's own record for that turn, still delivered and not leased,
  with a reader for the thread: it is handed to the coordinator wake, whose
  durable item dedupe drops a repeat. It is not rewritten, which would reset
  its read state, and `NOTIFICATION_DELIVERED` is not emitted again, which
  would push the phones again. A read record is still handed on: the person
  reading it is not the coordinator seeing it.
- Dismissed, actioned, expired, snoozed (`pending`), leased or readerless,
  or another producer's record: the person's decision or the other owner
  stands. Nothing is replayed and the card gets no release, so it reads Done
  without an "Agent finished". A snoozed record is delivered by the
  notification service when the snooze ends.

Only that finish's own row ends: a newer held finish on the thread keeps the
card held, and an earlier release is kept. A live write ends the same way,
with no card release, when the session has lost its reader or is an external
transcript before the record is written.

A newer finish on a thread replaces an older one whose write failed, so an
old turn never shadows the new one. A new turn takes a finish waiting on a
write retry back as held with that turn open, and a failure or stop ends it.
A finish a restart has not looked up yet is left to its lookup, so its record
is never rewritten. A lookup that fails retries with the same backoff, and a
dedupe tag another producer owns ends the finish without a record or a card
release. A terminal for a turn the thread has moved
past is already rejected by the turn anchor. The file holds at most 2,000
rows. A new held finish is admitted only below that, after released rows give
way (past the window first, then oldest first). When every row is held or
writing, the new finish is refused: no row and no "finished", a warning
(`finished-alert episodes full (2000); finish for <thread> not held`) and the
`overflow` result on the turn-completion counter. Accepted finishes are kept,
and the thread's next completion is admitted once the store drains. Failures,
stops, approvals and questions never enter the store. An unreadable or
oversized file replays nothing and is logged.

One Station process writes a home. `station start` refuses a second instance
on the same home
([lifecycle.ts](../../packages/cli/src/commands/lifecycle.ts)), and the
unsupported `--allow-shared-home` override already warns that two processes
can lose each other's writes; this file shares that limit. The server holds no
home lock of its own, so entry paths that bypass the CLI are not shown to be
exclusive. A race reproduced on a supported path is a bug to fix.

The agent-activity card reads the same episodes
([finished-alert-episodes.ts](../../src-server/services/orchestration/finished-alert-episodes.ts)),
not the hold facts, so the card and the push agree on one finish per episode,
after confirmation. The producer marks a completed turn pending as the bus
publishes it, before its queued task decides, so the card cannot read Done in
between. An attached session with a pending episode reads Running
(`finishHeld`). A detached one reads Done without an alert until the release.
The release names the episode's last terminal event, the same key the card
derives from the event log, and the card dates that Done from the release on
every rebuild. A finish held past the two-minute alert window therefore still
alerts once, even when the send waits out the per-phone floor. The Station
notification is left to the card, so this is the phone's only alert. A
change to the episodes flushes the card, so a hold that releases with no bus
event updates it by the next recheck. A Done alerts only under its released
key: a successful `session.exited` after the turn keeps the released entry
rather than naming a second one, and a Done the producer never released (no
turn terminal, a refused or dropped finish) shows without an alert. A
Station-delegated
child's Done raises no "Agent finished" on the card either. Its Failed and
attention phases still alert.

Focus is per session for these records. A focus report may list the sessions
its document shows (`viewingSessionIds` in
`@kontourai/station-contracts/presence`, at most four ids). The policy then
counts a focused surface for a session-targeted `done` or `info` record only
while that surface shows the record's session. A focused laptop showing
another chat, or none, leaves the phone's alert in place and gets its own.
Attention and failed keep surface-wide focus, and so does a surface whose
client does not report what it shows.

### Per-Project settings (#5072, `project-overview` preview)

Turn-completion records and approval-inbox requests name the session's local
Project: `source.projectId` on the turn envelope, and `metadata.projectId` on
the approval record, which `deliveryEnvelopeFor` lifts onto its legacy system
source. The id is the one the session recorded at its start, resolved by the
same session-record resolver station-control callers use. With the
`project-overview` Feature Preview on, the policy applies that Project's
`perProject` level to those two subsystems only: `attention-only` lets needs-input
or approval (`attention`) and `failed` through and keeps finished turns in the
inbox, and `off` interrupts no surface. The global agent level and every other
system subsystem are unaffected, and the in-app record is always written. A focus
report may also carry `viewingProjectId`. A focused surface showing that Project
then counts as watching that Project's `done` and `info` records, as if it showed
the session. With the preview off, the router plans these records as if they
named no Project. That keeps an earlier inbox **Mute this project**, which writes
the same `perProject` level, from silently muting turn and approval alerts.

## Approval actions in the running client

The in-app approval toast sends the selected decision and opens its originating
conversation. An accepted approval action in notification history or Attention
also opens that conversation; a runtime Activity link is converted to the chat
dock for this decision action. An Attention row's own Open session link is that
dock href (`notificationSessionHref`) for a session on this Station, a failed
one included, so the row and its alert open the same chat. A stored Activity
link still opens the session reader in Chat. These client actions do not add
approval buttons to native push or change background delivery guarantees. A
request answered with a form (a harness question) carries no decision actions
in notification history or Attention: an Allow or Deny there names no answer
and no exact request event, so the command route would refuse it. Its Open
session link leads to the form.
A request whose content, or the content of a call it gates, was stored out of
line carries only Deny there: allowing it needs the whole request loaded,
which the conversation's card does ([event content spill](event-content-spill.md)).
The same holds when Station cannot read the request back, and a card that
offered Allow before such content arrived is rewritten when it does, or when
Station refuses an Allow from it. The rewrite emits `notification:updated`,
so open notification history and Attention views refetch and stop offering
Allow. It is not pushed again, so a native notification already delivered is
not updated; any Allow that still reaches Station is refused.
While its request is open the item still counts as waiting on you: the
session's generic composer stays hidden and Dismiss stays secondary.

Failed decisions remain visible with a short explanation and disclosed details.
An uncertain answer must be inspected before sending another decision. See
[tool-policy delivery](../conformance/tool-policy-delivery.md#answering-on-a-phone-and-recovering-delivery)
for the shared request binding and send deadlines.

## Five historical approaches and their observed limits

The following observations describe the builds and probes that motivated push.
They do not establish the present status of an upstream issue, every platform
configuration or the current SSE replay contract.

### 1. Web push

Station's browser delivery is web push, which needs `PushManager`. Android
WebView does not implement it. The native app therefore never subscribes and
can never be told anything — silently. The same phone reports `push=yes` in
Chrome and `push=no` in the app.

### 2. An OS notification raised from the web layer

The web layer already sees every notification over SSE, so posting a local
notification from there looks like one line of code. But that stream lives in
the webview, Android suspends the webview when the app is backgrounded, and SSE
does not replay on reconnect. A notification raised while you were elsewhere is
therefore *lost*, not delayed. On device this presents as notifications working
perfectly in the foreground and never arriving otherwise — which reads as
"notifications are broken", not "notifications are late".

### 3. A poller on a host thread

Moving delivery into a Rust thread survives the webview being suspended, which
is the right instinct and still not enough. Android's cached-app freezer
SIGSTOPs the **entire process** once the app is cached, so the replacement
thread freezes along with the webview it replaced:

```
$ adb shell dumpsys activity processes | grep -A30 'ProcessRecord{.*station' | grep isFrozen
    hasPendingCompaction=false    isPendingFreeze=false isFrozen=true
```

## 4. A foreground service — blocked upstream, not by design

A foreground service is the sanctioned Android answer to the freezer: it keeps
the process out of the cached bucket, at the cost of a permanent visible
notification. It was built here and then removed, because Tauri 2.11 cannot
carry one:

- [tauri#11609](https://github.com/tauri-apps/tauri/issues/11609) — a foreground
  service makes the process outlive `MainActivity`, which Tauri does not expect.
  The activity leaks, two instances end up in memory, and the next launch fails
  with a `TAURI_INVOKE_KEY` mismatch that leaves the app unusable. Open since
  November 2024 with **no known workaround**.
- [tauri#15671](https://github.com/tauri-apps/tauri/issues/15671) — with the
  service holding the process alive, swiping the app from recents and relaunching
  gives a blank webview. Filed against tauri 2.11.5 / wry 0.55.1 / tao 0.35.3,
  which is exactly what Station builds. A fix exists in unmerged PR #15678.

Shipping it would trade "notifications do not arrive while backgrounded" for
"the app is broken after you swipe it away" — a worse defect, and one the user
hits without doing anything unusual. Revisit when #11609 has a fix.

## 5. Even in the foreground, native HTTP cannot resolve DNS

With the freezer and the foreground service both ruled out, the poller was at
least expected to work while the app was open. It does not. Every request from
the Rust layer fails at resolution:

```
notification poll failed: io: failed to lookup address information:
No address associated with hostname
```

This is not specific to the tailnet host — `example.com` fails identically —
and it is not a permissions gap: `android.permission.INTERNET` is granted. The
WebView in the same process resolves and fetches the same URL over HTTPS
without trouble, because Chromium resolves through Android's own resolver while
Rust's `std` goes to bionic `getaddrinfo`.

That device probe demonstrated a resolver failure in the then-current Rust
HTTP path. It is historical evidence for that path and build, not proof that
every current native HTTP operation fails on Android. New native transport
paths require their own platform verification.

## Status: the watch was retired

The host-side watch (`notification_watch_start` / `notification_watch_stop`
and their web callers) landed dormant and nothing ever called it. It has been
deleted. Push (below) supersedes it for backgrounded delivery; the findings
above are why a host poller does not come back.

(Historical: archive#3088 corrected this record after a backlog sweep closed
the original tracking issue with no code change. It is itself now closed, so
it must not be cited here as live tracking — that would repeat the very
defect it was filed for.)

## Historical delivery limits before native push

| App state | Covered |
|---|---|
| Foreground | yes |
| Backgrounded, process alive | **no** — frozen, and the service that would prevent it is blocked upstream |
| Force-quit / swiped away | **no** |
| Device rebooted, app never opened | **no** |

Everything below the first row needs FCM on Android and APNs on iOS
(archive#917, reseeded as #63 and batched into #177). The capability report originally returned `remote-push: unsupported` for that
reason. It now reports build-dependent push support: Android requires its
Firebase build values; iOS requires the Live Activity build. Neither means a
phone has registered or a provider delivered a message. The later sections
record implementation and qualification separately from these original limits.

That is not a consolation prize. Push is the mechanism that does not require
keeping a process alive at all — the system unfreezes the app to deliver — so it
sidesteps the freezer, both Tauri bugs, and the battery cost of polling
together. Keeping a process alive to poll is fighting the platform; push is the
platform's answer. The cost is real and is a product decision, not a technical
one: every notification leaves the machine and transits Google or Apple, which
matters for a self-hosted product.

The original iOS foreground-only conclusion predates the implemented Live
Activity path below; physical delivery retains the later receipt's limits.

## Decision: push through a Kontour-operated push gateway

Decided September 23, 2026 by the owner: follow the pattern an existing
self-hosted product already ships today, adapted where Station differs.

- **Why a hosted service at all.** Push credentials belong to whoever publishes
  the app (the Firebase project and the APNs key are bound to its package and
  bundle IDs), so a self-hosted Station cannot send to the published app
  directly, and the publisher has to run a hosted service that does.
- **Named "push gateway", not relay.** In Station, relay and
  [broker](connection-broker.md) name the path a Device uses to *reach* a
  Station. The push gateway does the opposite job, Station to phone through
  Google or Apple, and only the app's publisher can run it. The broker design
  already kept notifications apart ("a separate payload policy and delivery
  grant").
- **Station-signed, without gateway account enrollment.** The gateway does not
  link Stations to hosted user accounts, persist device tokens or build cards.
  Station owns its paired-phone registrations. The gateway (`deploy/push-gateway`)
  retains rate-limit state and, for APNs, the channel ledger described below;
  it is not wholly stateless. Every request is signed by the
  Station's own P-256 push key (ES256, body hash bound into the token, at most
  120 s lifetime). The gateway verifies it, rate limits per key and globally,
  accepts the reviewed data-only activity/notification kinds for Station packages,
  and forwards them to FCM with the kind's priority policy. The Station owns device tokens, builds
  the card, and drops a token when the gateway answers 410.
- **What stops a stranger.** Anyone can mint a key, so passing the gateway
  proves only possession of *some* key. The gateway therefore stamps the
  verified key's thumbprint into every message (`station_key`, which callers
  cannot supply), and the phone accepts a push only when `station_key`,
  `device_id` (a random per-registration value) and `user_id` all match what
  its own Station returned at registration. Per-address, global, per-key and
  per-push-token rate limits bound the rest.
- **Android.** FCM *data* messages are received by a native
  `FirebaseMessagingService` that renders the card itself — no WebView, no
  JavaScript. While work runs the card requests promotion
  (`setRequestPromotedOngoing`, `setShortCriticalText`), which Android 16 shows
  as a status-bar Live Update chip.
- **iOS.** A Live Activity from a widget extension, updated by APNs
  `liveactivity` pushes, with push-to-start tokens so a card can appear while
  the app is closed. Station's implemented broadcast-channel path requires iOS 18.

The card carries status, session titles and project names, never
transcripts, code or tool output (the same rule as the
[connection broker](connection-broker.md)), and it is end-to-end encrypted
to the phone: the gateway and Google see only routing data.

**What doing without hosted accounts costs**, compared with an account-backed
relay: no single card
merging several Stations (each Station owns its own card), revocation happens
at the Station rather than centrally, and the gateway cannot restrict senders
to known people, so abuse is bounded by rate limits and the phone-side check
rather than by sign-up. Revisit when a Station has more than one person, or a
cross-Station inbox is wanted.

Push avoids the failures above for a backgrounded or swiped-away app: the
platform wakes the process to deliver, so nothing has to stay alive, and
neither the freezer nor tauri#11609/#15671 is involved in that delivery path.
The Android platform service receives and renders the card without the old
Rust poller's HTTP path; native registration and other requests have separate
transport owners. Two limits remain. FCM
does not deliver to an app the user force-stopped (Settings → Force stop)
until it is opened again. And normal-priority data messages wait out Doze,
while the client drops activity older than ten minutes, so the gateway sends
activity as high-priority messages.

### Station contract

The Station side mirrors Web Push (`push-routes.ts`, `WebPushChannel`):

- **Push key.** `security/push-signing-key.json` (0600) holds a P-256 key used
  only for gateway requests: domain-separated from the connection signing key,
  whose tokens are not a general signature (connection-broker.md). It is
  created on the first registration, never before.
- **Registration.** `POST /api/system/native-push/register` from a paired
  device's own credential (a relay alias is refused with
  `device_pairing_required`, after the credential gate's read-scope
  refusal), body `{ token, packageName, platform: 'android' }`, returns
  `{ registrationId, stationId, stationKey, payloadKey }`. `registrationId` is
  128 random bits and is the value the phone checks on every push
  (`device_id`); `stationId` is the environment id (`user_id`); `stationKey`
  is the push key's RFC 7638 thumbprint, which the gateway stamps as
  `station_key` after verifying the signature, so the phone can pin it;
  `payloadKey` is 32 random bytes (base64url, 43 characters) the card is
  sealed with. `registrationId` and `payloadKey` are kept across token
  rotation and replaced after a `DELETE`. The registration is stored in its
  own 0600 sidecar, `security/native-push-registrations.json`, keyed by
  device id — not on the paired-device record, which older Stations read
  with a strict key check and would refuse whole. The same strictness applies
  to this file: once any registration carries `cardShown`, a Station built
  before that field (for example after a rollback to an older nightly)
  cannot read the file at all and answers 503 for native push until it is
  upgraded again, or `security/native-push-registrations.json` is deleted and
  agent activity is turned on again on the phone. The package must be one the
  gateway delivers to, and the route sits on the `/api/system` operate tier.
  `DELETE /api/system/native-push` clears the caller's own registration only.
  `GET /api/system/native-push` (`/api/system` read tier) answers
  `{ registered, registrationId }` for the caller's own device, with no token
  or key, and 503 when a registration file is unreadable; it is not gated on
  the gateway URL. The phone's refresh uses it to notice a registration the
  Station dropped (a gateway "unregistered" answer clears it, and a device
  paired again is a new device with none).
  Revoking or replacing a device drops its registration, and a registration
  whose device is no longer active is never listed. Hosted-tenant mode
  disables these routes, as it does Web Push; an invalid gateway URL, or a
  corrupt key or registration file, makes registration answer 503.
- **Sealed card.** Only routing data travels in clear: the FCM data is
  `{ station_kind: 'agent_activity', device_id: <registrationId>, sealed }`,
  where `sealed` = base64url(nonce[12] || AES-256-GCM ciphertext || tag[16])
  under that registration's `payloadKey`, with additional authenticated data
  `station-agent-activity:v1:<registrationId>`. The plaintext is one JSON
  object of strings: `user_id`, `updated_at`, `active`, `activity_phase`,
  `activity_line_0..4`, `activity_active_count`, `activity_attention_count`,
  `activity_expires_at`, and the `alert_*` fields. It is held to 2500 bytes
  (rows dropped from the tail, a long alert body shortened first), so the
  sealed data stays under the gateway's 3800-byte limit with room for
  `station_key`. `NATIVE_PUSH_SEALED_TEST_VECTOR` in
  `@kontourai/station-contracts/native-push` is the known-answer vector for
  the phone's opener.
- **Opening the session a card names (#2515).** The plaintext may also
  carry `activity_session_id` / `activity_project_slug` (the session in row 0)
  and, for a single-session alert, `alert_session_id` / `alert_project_slug`.
  A grouped alert names none. They travel only inside the seal, and only
  when the session id (and the project slug, if the session has one) match
  `NATIVE_PUSH_SESSION_REFERENCE_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`,
  ASCII); otherwise nothing is sent and a tap opens the app where it was. The
  reference is a pair of identifiers, not a path, so neither the card nor the
  phone ever supplies a URL. On the phone, `AgentActivityModel.kt`
  (`SessionRoute.validOrNull`) checks the same grammar — a server test pins
  the Kotlin pattern to the contract's — and drops the whole route on any
  failure; the route's Station is the registration's verified Station id,
  never a card field. The route never rides on an intent: the tap's
  launch intent (no data URI or action, which the deep-link plugin would
  read as a pairing link) carries only a random tap nonce, and
  `AgentNotifications.openApp` records nonce → route in app-private storage
  (`TapLedger` in `AgentActivityModel.kt`: one live nonce per card or alert,
  at most 20, expiring after 24 hours, the longest a card lives). Each card
  and alert has its own request code and, from API 29, intent identifier, and
  `FLAG_UPDATE_CURRENT` replaces the extras of the same notification's
  intent, so a re-posted card carries only its newest nonce.
  `AgentActivityPlugin` looks at an intent from `load` or `onNewIntent` only
  if it is shaped like those launch intents (`ACTION_MAIN`, no data, not
  `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`), and adopts a route only by
  redeeming its nonce, which consumes it. That is what makes the exported
  launcher activity safe: extras another app supplies name no issued nonce,
  and the original launch intent Android restores to a recreated activity
  after process death names a nonce already redeemed (removing the extra
  only helps within one process). Redeeming always records a fresh nonce for
  the same card or alert, and writes it into that notification's
  PendingIntent only if it still exists (`FLAG_NO_CREATE` check, then
  `FLAG_UPDATE_CURRENT`), so tapping the same ongoing card again works; for
  a notification already gone the fresh nonce is never carried and simply
  occupies a ledger slot until it expires. The
  plugin then holds the route
  and hands it to the web layer through `take_launch_route` (returns and
  clears), announced by a `launchRoute` plugin event while the app runs. The
  web layer (`agentActivitySessionTarget`) validates the grammar a third time
  and hands the route to the notification opener ([Opening a
  notification](#opening-a-notification-on-the-station-that-sent-it)) with
  the route's Station id: the notification href
  (`/projects/<slug>?chat=<id>&dock=open`, or `/?chat=<id>&dock=open`
  without a project) opens on that Station, switching to its saved
  connection first when another one is connected, and a Station not saved on
  the phone shows a notice instead of being dropped. The Station is matched
  by id, not by user: with two registrations for different users on one
  Station, a card may navigate the app while it is connected as the other
  user. Only navigation follows; the session itself stays behind the
  server's per-session read checks. The iOS Live Activity receives the same
  fields inside its seal and ignores them: a Live Activity tap opens the app
  without routing. An iOS alert tap routes (see the iOS alert section).
  The references count against the 2500-byte plaintext budget and are
  never cut: the card's reference stays for as long as row 0 does, and an
  alert's stays with the alert, so under a tight budget they displace tail
  rows (at most about 310 bytes each for the longest id and slug).
- **Station notifications on Android (#2588).** A notification the delivery
  router decides to send to a phone goes out through the same gateway,
  registration and payload key as the card, as
  `{ station_kind: 'station_notification', device_id, sealed }` with AAD
  `station-notification:v1:<registrationId>` (so a card never opens as a
  notification or the reverse). The plaintext is one JSON object of strings,
  `NativePushNotificationPlaintext` in
  `@kontourai/station-contracts/native-push`: `v` (`"1"`), `user_id`, `id`,
  `kind` (`alert` or `retract`), `created_at` and `expires_at` (epoch ms, an
  hour apart), and on an alert `title`, `urgency`, an optional `body`, and an
  optional `session_id` / `project_slug` in the session-reference grammar
  (the session the record names, the one its audience was limited by; none
  for a path target). There is no link: a tap opens that session through the
  card's tap-nonce ledger, never a URL. `NATIVE_PUSH_NOTIFICATION_TEST_VECTOR`
  is its known-answer vector. The title and body are sealed in display form
  (#3382): bidi controls and invisible characters removed, controls turned
  into spaces, the title on one line with a multi-line title's lines joined
  by " ⏎ ", the body keeping its line breaks. Every cut to the size budget
  re-bounds the original text, so it ends in "…" and keeps a title's
  "(+N lines)" count. When the phone's surface asked
  to hide content, the title and body are replaced with generic copy before
  sealing. Station
  notifications carry no FCM collapse key: FCM keeps at most four collapse
  keys per offline or dozing device and drops the rest without saying so,
  which would lose alerts, retracts or card updates, so each message is kept
  and the phone's `created_at` history orders them (an alert arriving after
  its retract is dropped). Attention and failed go at high
  priority, everything else (and every retract) at normal, and the gateway
  gives a notification an hour to live instead of the card's five minutes.
  A read or dismiss elsewhere sends a retract. The channel
  (`delivery/fcm-alert-channel.ts`) shares the per-phone three-second send
  floor with the card (`native-push-send-floor.ts`): each phone has one
  queue of waiting notification sends, drained a slot at a time, and the
  card waits for the slot after the one a notification holds. What a send
  says (title and body after the hide-content choice, urgency, session
  reference) is fixed when it is queued; the push key and registration are
  read, `created_at` and `expires_at` stamped and the message sealed only
  when its slot comes, and a slot is taken only for a phone that can be sent
  to. A newer send for the same id replaces the waiting one in place. Eight
  waiting sends per phone is the `info`-eviction threshold: past that the oldest waiting `info` alert
  is dropped and logged, and attention, failed and done alerts and retracts
  are never dropped by this cap. A queue containing only those retained kinds
  can exceed eight; this is not a hard total queue bound. The router records a delivery when it plans it, so the
  channel keeps, per phone, the ids it dropped without ever taking a version
  of them for sending in this process (an `info` alert dropped at the cap,
  or a waiting alert a retract removed), and sends no retract for those. Any
  other retract is sent, including one for an id a restarted process has
  never seen. An id leaves that set when a version of it is taken for
  sending, and a waiting alert a retract removes is not sent while the
  retract still is if an earlier version was taken. Both sets hold at most
  256 ids per phone and are forgotten when the phone has no Android
  registration. A retract that empties the queue gives its reserved floor
  slot back (hold-backs the card counted while that alert was waiting stay
  counted). Each time a notification's slot
  holds back a card update that is still waiting, the card counts it; after
  two the queue leaves the next slot free for the card, so a burst cannot
  starve it, and the count is cleared when the card sends or has nothing
  left to send.
  It does not retry a failed send (like Web Push); a 410 clears the
  registration. It does not carry what the card already announces: the
  same `isCardAlerted` rule as the iOS alert channel (see "What is carried"
  under "iOS: notification alerts"), which requires the `onActivityCard`
  mark the approval-inbox and turn-completion writers set only when the card
  carries the event. So an orchestration approval or a Done or Failed turn
  in a listed session, and the registry twin of a Station-agent approval,
  are left to the card; an approval in an ephemeral session, a stopped
  turn, and every other registry approval are carried. The known edges
  listed there apply on Android too. On the
  phone (`StationNotifications.kt`) each urgency has its own notification
  channel; one Android notification per id per registration; a history of
  the newest `created_at` seen per id (64 ids) drops a duplicate or older
  delivery and an alert arriving after its own retract (and a retract older
  than the newest delivery of its id cancels nothing); an expired alert is
  not shown; and, as for card alerts, nothing is posted while the app is in
  the foreground.
- **Publisher.** An `ORCHESTRATION_EVENT` subscriber marks the card dirty on
  lifecycle events (never streamed content), coalesces per Station, and reads
  the session read model once per reading principal: each phone reads with
  the read authority its own device credential carries
  (`pairedDevicePrincipal` — the device's tailnet person binding, else the
  operator for a credential minted with home-possession or a device holding
  [owner-device standing](../security/remote-access-threat-model.md#owner-device-standing-2026-11-02), else the device
  itself), so a card never holds a session that credential may not
  read. Only a person's device with `orchestration:read`, not bound to a
  deployment account, may register or be read for; a device narrowed below
  that gets one final empty card and then nothing. A scope change requests
  a flush (`DevicePairingService.onDeviceAccessChanged`), so that card goes
  out at once, subject to the same per-phone interval and backoff as any
  other send. Whether the last card a phone accepted had rows is kept with
  its registration (`cardShown`), so a restart before that flush still sends
  the final card, and a phone that never showed a row is never sent one. A
  revoked or replaced device has no registration left to send to; its last
  card expires on its own, within two hours. A phone
  paired by code but reached through Tailscale Serve lists sessions as its
  WhoIs person, and a local-UI device's requests resolve to the local
  operator, so either one's in-app list can differ from its card; the card
  never exceeds what the device credential may read. The registration file
  is cached in memory and re-read when its file identity changes, which covers
  `station environment reset` from another process; two processes writing it
  in the same instant can still lose one write. It sends one card per registered
  phone: at most five
  rows, attention first (approval, input), then failed, then live, then
  sessions finished in the last 15 minutes. Lifecycle maps to the plugin's
  phases through `sessionAttentionDisposition`, the adjudication the bell
  shares: `queued` with an open turn → `starting` (an attached-but-idle
  session also projects `queued` and stays off the card), `running` →
  `running`, an approval request (`review_pending`, which the lifecycle fold
  derives from an unresolved non-input `request.opened`) →
  `waiting_for_approval`, `needs_input` → `waiting_for_input`, `blocked` →
  `stale` (live, but not counted as attention: the phone's attention means an
  approval or input request), `completed` → `completed` (`running` while the
  finish is held, see "Finished alerts" above), `failed` → `failed`;
  canceled sessions leave the card. Failed sessions leave after 15 minutes
  like any other finished one, and live phases require the session to be
  attached in this process.
- **Entries and alerts.** Which entry into a phase a session is in comes from
  its event log: the open request for approval or input, the turn for a live
  session, the terminal event for a finished one. So a second approval is a
  new entry even if nothing saw the session leave the first. An alert goes
  out once per entry into approval or input, and for a finish within the last
  two minutes; `alert_id` is SHA-256 of Station, session, phase and entry.
  Several new entries for one phone are one grouped alert ("2 agents need
  you", up to five titles listed) whose id is derived from the sorted set.
  The ids a phone has been sent are kept (bounded) with its registration in
  the sidecar, so a restart or token rotation does not raise a group again.
  A finished entry only counts a terminal event after the latest
  `turn.started`; otherwise the observation time stands in.
- **Delivery.** Per phone, at most one send every three seconds (the gateway
  allows 30 a minute per token); a change inside the interval is coalesced
  into the next send. 503, 429, 401 (which can be transient), other 5xx and
  network errors wait for the
  publisher's single unref'd timer with backoff (5 s, ×3, at most 5 min,
  8 timed attempts; after that only a new event retries). A live card is
  re-sent 30 minutes before its two-hour expiry, and the publisher flushes
  once shortly after boot. A 410 clears that registration (unless the phone
  re-registered with a new token meanwhile); a registration pinned to a push
  key this Station no longer holds is dropped. Requests never follow
  redirects. The listener never throws, and the runtime stops the publisher
  (and its timer) on shutdown. Implementation:
  `src-server/services/notifications/` (`agent-activity-card.ts`,
  `agent-activity-publisher.ts`, `agent-activity-seal.ts`,
  `native-push-registration-store.ts`, `push-signing-key-store.ts`) and
  `src-server/routes/operations/native-push-routes.ts`.
- **Gateway URL.** `STATION_PUSH_GATEWAY_URL`, defaulting to the Kontour
  gateway; it must be a bare https origin (a path, query or credentials are
  refused, and native push is then off). Nothing is sent until a device
  registers, which only happens when its user turns agent activity on; the
  flow is listed in the privacy inventory.

### iOS: Live Activities over broadcast channels

iOS 18 and later get the same card as a Live Activity (the design record for
issue #2513). The Station side and the gateway's APNs routes are built (the
gateway ships dark until its APNs secrets are set). The widget extension is
built but off by default, and enabling it and App Store signing are a
separate, owner-gated slice, so nothing reaches an iPhone yet (see Delivery
status).

- **Architecture.** Each Live Activity has its own APNs broadcast channel,
  created by the gateway inside the start: the Station sends
  `event: 'start'` with the registration's push-to-start token and no
  channel, and the gateway creates the channel, sends the push-to-start with
  it as `input-push-channel`, and answers `{ result: 'sent', channelId,
  channelAuth }`. `channelAuth` is the gateway's HMAC over the channel and the
  Station's key; every update and end of that activity, and the channel's
  deletion, must carry it. Once an ended activity's dismissal time has passed
  (at once for an immediate end) the Station deletes its channel with
  `POST /v1/apns/channels`, `{ op: 'delete', bundleId, environment,
  channelId, channelAuth }`. There is no endpoint that creates a channel on
  its own: channels are an app-wide quota that never expires, and push keys
  are free to mint. The phone never reports a per-activity token, so nothing
  on the phone uses a credential in the background. Registration makes no
  network call.
- **Registration.** The same route, with
  `{ token, packageName, platform: 'ios', apnsEnvironment }`: the token is
  the ActivityKit push-to-start token (hex, 32 to 100 bytes, stored
  lowercase), `packageName` one of `NATIVE_PUSH_IOS_BUNDLES`, and
  `apnsEnvironment` `production` or `sandbox`. The answer is unchanged. iOS
  records live in their own sidecar, `security/native-push-ios-registrations.json`
  (0600, schemaVersion 1), with the started `activity` (`startedAt`, a random
  `runId`, `channelId`, `channelAuth`) and `channelDeletes` (ended
  activities' channels, with their topic and the time they may be deleted,
  at most 16) beside the Android fields, so a restart neither starts a second
  activity nor forgets a channel. A separate file
  because the Android file is read as strictly as the device registry: one
  iOS record in it would cost an older Station every Android registration.
  A device holds one registration; registering on one platform clears the
  other (best effort: an unreadable file for the other platform does not
  block this one, and should both ever hold the device the newer one is
  served; a later re-registration on the stale record's own platform then
  wins again, and the other record lingers until the device is cleared or
  revoked), and `DELETE`, revocation and replacement clear both files. A
  removed iOS record that still has a live activity or queued channels
  leaves a tombstone in the file (`tombstones`, at most 32, drops logged):
  the publisher is told at once, ends that activity with an empty card
  dismissed now, then deletes its channels, so a revoked phone stops
  showing sessions even when the Station restarted in between. A phone
  revoked while its start is in flight has that start's activity retired
  the same way once the start answers; during a rollover that start's
  activity is the one ended, and the rolled-over one (whose end already
  went out) only has its channel deleted. A tombstone older than 24 hours is
  dropped: the activity has ended on the phone, and the sweep reclaims its
  channels. While one registration file is unreadable, its phones keep
  their state but are only looked at on the stalled-flush minute. A token
  for another bundle or APNs environment queues the live activity's channel
  for deletion under its old topic.
- **Card.** `content-state` is `{ v: 1, rid, sk, sealed }`: `sealed` is the
  Android card, sealed with the iOS registration's `payloadKey` and AAD
  `station-agent-activity:v1:<registrationId>`; `sk` is always stamped by
  the gateway. The only plaintext APNs carries for display is a fixed alert
  ("Station" / "Agent activity"), which the gateway builds from fixed
  vocabulary; the Station sends only `alert: true | false`.
- **Planner.** `live-activity-planner.ts` decides from the stored activity
  and the card: no activity and an active card not yet sent → start; an
  activity and a changed card, or one 30 minutes from going stale → update
  (stale at the card's expiry); an activity and a finished card → end with
  that card, dismissed at its expiry but within 4 hours, alerting a pending
  finish; an empty card or lost read access → end, dismissed now. An
  activity started 7 h 30 m ago is ended and started again before Apple's
  8-hour limit, on its own timer: end, delete its channel, and start again
  on a new one.
- **Requests.** `POST /v1/apns/live-activity`, signed like the FCM send:
  `{ bundleId, environment, event, pushToStartToken (start only), channelId
  and channelAuth (update, end), registrationId, sealed, alert, timestamp,
  staleAt (start, update) | dismissAt (end) }`, times in Unix seconds. `timestamp` is
  `max(ceil(now), previous + 1)` per registration, so an end and the start
  that follows it in one flush are ordered. The per-phone three-second
  interval, backoff, alert bookkeeping and per-principal read are the
  Android publisher's. Answers: 200 sent (a fresh `channelAuth` in it, after
  the gateway rotated its secret, is stored); 410 `{ result: 'unregistered' }`
  clears the registration (at a start the gateway has already deleted the
  channel it made); 410 `{ result: 'channel-gone' }` and 403
  `{ result: 'channel-unauthorized' }` forget the activity, and the retry
  starts a new one; a 410 naming neither is retried with backoff; 422 is
  refused for good (a refused end still forgets the activity, which goes
  stale, and queues its channel); 429, 503, 401 and network errors back off.
  Deletions back off on their own (so a failing delete never holds back a
  card) and are dropped after the same eight timed attempts; a gone or
  refused channel counts as deleted; a given-up channel is logged by a hash
  of its id. A start that fails after a rollover's end forgets what the
  phone was sent, so the next attempt starts again rather than waiting on a
  rollover that already happened. A 200 start that names no channel is
  retried like a 503; that start may already have put an activity on the
  phone, so a retry can show a second one while the first, unreachable,
  goes stale — preferred over a card nothing can update or end. Each activity keeps its last `timestamp` in the file,
  so a restart never sends it an older one. An unreadable registration file
  stops only its own platform's cards. A registration pinned to a previous
  push key cannot have its activity ended (its `channelAuth` is bound to
  that key): it goes stale, and the gateway's channel ledger and sweep
  reclaim the channel within about 12 hours and a few sweeps, as they do any channel the
  Station loses track of.
- **What differs from Android in the threat model.** A forged or replayed
  push can blank the card but not inject content: the widget (slice C) is to
  show a neutral placeholder unless the state's `rid` matches its attributes, `sk` matches
  the pinned key, the card opens with the registration's key and `user_id`
  is the Station. Alert text is fixed by the gateway, so no session title
  ever reaches APNs in clear. Channels are a per-app quota shared by every
  Station: no request creates a channel except a start, which the gateway
  rate limits per address, per device, per key and globally, and
  only the Station whose key the `channelAuth` was minted for can update,
  end or delete a channel. The Station deletes each activity's channel after
  it ends. A channel whose registration was cleared (unregistered, revoked,
  or moved to Android) while the Station was stopped is not deleted: the
  Station no longer knows it. A retained tombstone is the exception described
  above: it gives the publisher enough state to end and delete after restart.
  The gateway sweep is another recovery path, only for configured sweep scopes.
  Its 12-hour ledger expiry plus ten-minute unrecorded grace and bounded sweeps
  are not a guaranteed deletion deadline during outages or sustained backlog.

### iOS: notification alerts (fixed text, interim)

Issue #2589. A notification the delivery router decides to send to an
iPhone goes out as a regular APNs alert push through the gateway, beside the
Live Activity card. The Station side is built and dormant: nothing is sent
until a phone registers an alert token, and the app half is inside the same
off-by-default plugin build as the Live Activity. The gateway route is not
dormant: a gateway deployed with its APNs secrets set and the route's own
`ALERT_PER_TOKEN_LIMITER` binding (declared in `wrangler.jsonc`) serves
`/v1/apns/alert` live to any correctly signed request; without that binding
the route answers 503. The gateway is deployed by hand
(`deploy/push-gateway/README.md`); no workflow deploys it.

- **Token.** The Live Activity push-to-start token cannot address a regular
  alert, so the app also asks UIKit for its APNs device token
  (`registerForRemoteNotifications`). UIKit reports it only to the app
  delegate, and Tauri's iOS runtime (tao 0.35) declares its own `AppDelegate`
  class at run time without the remote-notification callbacks, without
  adopting `UIApplicationDelegate`, and with no hook for plugins. So when the
  plugin loads, it adds
  `application:didRegisterForRemoteNotificationsWithDeviceToken:` and
  `…didFailToRegisterForRemoteNotificationsWithError:` to the delegate's class
  with the Objective-C runtime (calling any existing implementation first),
  then sets the same object as the delegate again (through `setDelegate:`,
  keeping its own reference to it), because UIKit may cache which optional
  delegate methods a delegate answers when it is set. Whether UIKit calls
  methods added this way on current iOS is **not verified on a device**; the
  hook, the chaining and the re-assignment are tested on macOS only
  (`StationAgentActivityAlerts`). The `alert_token` command asks for alert
  and sound permission, registers, and answers `unconfigured` (build not
  signed for push), `denied`, or the token as lowercase hex, within 10 s. It
  shows the system permission prompt the first time, so the web layer must
  call it only from an explicit user action (turning alerts on), never on
  launch or refresh.
- **Registration.** The iOS registration takes an optional `alertToken`
  (lowercase hex, 32 to 100 bytes). It is stored only when sent, so a record
  without one is byte-identical to before. A record that has one makes the
  whole iOS file unreadable to a Station built before this field (for
  example after a rollback to an older nightly), the same trade as
  `cardShown` in the Android file: such a Station answers 503 for native push
  until it is upgraded again, or `security/native-push-ios-registrations.json`
  is deleted and agent activity is turned on again on the phone.
- **Alert-token web-layer contract** (separate from the implemented iOS
  push-to-start registration described in Delivery status):
  - every registration and re-registration of an iPhone that should get
    alerts must restate `alertToken`; one that omits it turns alerts off for
    that phone (the stored token is dropped);
  - alerts ride on a Live Activity registration: the route requires the
    push-to-start `token` (iOS 18+), so there is no alerts-only
    registration, and an iPhone below iOS 18 gets no alerts;
  - call `alert_token` only from an explicit user action (see Token).
- **Request.** `POST /v1/apns/alert`, `{ bundleId, environment, deviceToken,
  registrationId, kind, collapseId, sealed }`, signed like every gateway
  request. The gateway builds the whole APNs body: topic the bundle id, push
  type `alert`, `mutable-content: 1`, and visible text chosen from a fixed
  vocabulary by `kind`, so neither notification nor agent text reaches Apple
  in clear. `attention` and `failed` sound at priority 10, `done` is quiet at
  5. A surface with `hideContent` gets `hidden-urgent` (for attention and
  failures) or `hidden` (for done): the same neutral text either way, while
  sound and priority follow the notification's urgency, so the privacy
  setting never quiets an urgent alert. The notification's title and body
  travel in `sealed` under the registration's payload key with AAD
  `station-alert:v1:<registrationId>` (so an alert never opens as a card, or
  a card as an alert), for the Notification Service Extension (#2590) to
  open; a build without it shows the fixed text. With `hideContent` the
  sealed payload carries neither title nor body.
- **Notification Service Extension (#2590).** `StationNotificationService`
  (`src-desktop/ios/StationNotificationService`, bundle
  `<app>.NotificationService`) replaces the fixed title and body with the
  sealed ones only when every check passes: payload `v` 1, a registration in
  the shared keychain group for `rid`, `sk` equal to that registration's
  pinned Station key, a seal that opens under its payload key in the alert
  domain, `user_id` naming its Station, and a sealed `issued_at` no more
  than 2 hours older than the phone's clock and no more than 10 minutes
  ahead of it. The gateway sets a one-hour APNs expiry and every retry is
  sealed afresh, so a genuine alert fits that window. The window compares
  the Station's clock with the phone's: a Station clock more than 10
  minutes ahead of the phone, or 2 hours behind it, makes every alert show
  its fixed text. Anything else, a seal without a title or body (hidden
  content), and `serviceExtensionTimeWillExpire` deliver the push exactly as
  it arrived; a seal with a title and no body keeps the fixed body. The
  logic is `StationNotificationServiceCore` in the agent-activity Swift
  package, tested on macOS against `NATIVE_PUSH_ALERT_SEALED_TEST_VECTOR`.
  Replay is bounded by that `issued_at` window, not by APNs expiry: whoever
  holds a genuine sealed push (the gateway, or anyone with its APNs
  credentials and the device token) can re-send it and have it open for up
  to 2 hours after the Station sealed it, including after the user has
  since turned on hidden content. It cannot suppress a push, only rewrite
  it.
- **What stops a stranger.** Nothing binds a device token to the Station that
  registered it (there is no `channelAuth` for a device), so anyone who
  learns a phone's device token can sign alerts to it with a key they minted:
  fixed text only, but with sound. The gateway bounds it with
  `ALERT_PER_TOKEN_LIMITER` (6 a minute per device token, whichever key
  signs, checked before the shared per-token, per-key and global limits; the
  alert route answers 503 without that binding). The ceiling is shared by
  every signer of a token, the phone's own Station included: a stranger who
  knows the token can spend it, and the owner's alerts over it are refused
  with 429, which the channel reports as retry, and the router does not
  retry a push, so they are dropped to the inbox. Accepted: a per-signer
  ceiling would let a stranger buy fresh budgets by minting keys (keys are
  free), which is the flood this limiter exists to stop, while the
  starvation costs only lock-screen alerts (the inbox, the in-app toast and
  the Live Activity card are unaffected) and needs the token, which only
  the phone, its Station and Apple hold. Refusing such alerts on the
  phone needs the Notification Service Extension (#2590), which checks the
  stamped `sk` against the pinned Station key, plus Apple's notification
  filtering entitlement (`com.apple.developer.usernotifications.filtering`),
  without which an extension cannot suppress a push, only rewrite it.
- **What is carried.** What the Live Activity card already announces is not
  sent as an alert, so one event is not announced twice:
  `isCardAlerted(notification)` in `delivery/card-alerted-categories.ts`
  (shared with Android's alert channel, #2588). It is true only for an
  `approval-request`, `turn-completed`, `turn-stopped` or `turn-failed`
  record that its writer marked `onActivityCard: true` and whose metadata
  says it is about an orchestration session (`sessionKind: 'runtime'` with
  a `sessionId`, and `requestKind`, when present, `'orchestration'`),
  because the card is built from the orchestration session read model. The
  writers (approval-inbox.ts, turn-completion-notifications.ts) mark a
  record only when the card carries its event: the session is not
  ephemeral (inbound webhooks start ephemeral sessions, which
  `listSessionReadModel` leaves out), and a turn terminal leaves the session
  Done or Failed on the card (an aborted or cancelled turn folds to
  `canceled`, which the card leaves off, so a stopped turn still alerts). No
  other source may set the mark: `schedule()` refuses it from REST
  `POST /notifications`, providers and every other producer.
  One registry approval is on the card too: a Station-agent
  session relays each turn through `/chat`, so a tool approval there is both
  a registry approval and, republished by the adapter, the thread's
  orchestration `request.opened`. The relay names its thread in the
  internal `x-station-orchestration-thread` header (accepted only from a
  direct internal caller, and only for the request's own conversation), and
  that approval's registry notification carries
  `metadata.orchestrationThreadId` equal to its `sessionId`, marked
  `onActivityCard` under the same session rule; that twin does not alert
  either. Every other registry approval (a managed chat outside
  orchestration, an MCP UI call, an ACP bridge request, a Kit action:
  `sessionKind: 'managed'`, `requestKind: 'registry'`, no
  `orchestrationThreadId`) never writes the orchestration `request.opened`
  that puts a session on the card as waiting for approval, so it still
  alerts, as does any record that is unmarked or fails one of these checks
  (including one written before the mark existed). One known edge: the
  twin is marked when the approval registers, but the card's entry needs
  the adapter to receive the injected approval chunk; a relay stream that
  aborts in between leaves that approval with no phone alert (the inbox
  still has it). A second known edge is timing: the mark says the card
  carries the event, not that the card alerted. This channel decides once,
  when the record is created, but the card alerts only on the state it
  reads after its ~1 s coalescing and the 3 s per-phone floor, so a Done or
  Failed superseded before the card sends (a queued follow-up or Flow step
  starting the next turn at once, or `runtime.error` followed by
  `turn.aborted`) is marked yet alerts nowhere. A finish also alerts only
  within two minutes of happening (`FINISH_ALERT_WINDOW_MS`), while a
  failed card send backs off for up to five minutes, so a finish whose card
  lands late raises no alert either. The inbox keeps both. Only the two
  phone alert channels (this one and Android's) read the stamp: the two
  records of a Station-agent approval are still two notifications
  everywhere else. The exclusion does not look at the phone: with Live
  Activities (or the Android card) turned off, the card-announced
  notifications raise no alert at all (the inbox keeps them).
  Info-level notifications are not carried either (fixed text for them would
  say nothing).
- **Channel.** `ApnsAlertChannel` (`delivery/apns-alert-channel.ts`) is the
  router's `apns-alert` channel: it lists iOS registrations that carry an
  alert token, skips one pinned to another push key, and on 410
  `unregistered` drops only the alert token (the registration and its Live
  Activity stay), and only while it is still the token sent to.
- **Retract.** Not supported (`retract: false`). APNs cannot remove a
  delivered notification; only code on the phone can
  (`removeDeliveredNotifications`), which needs the app running: a background
  push is throttled and never reaches a force-quit app, and a Notification
  Service Extension only rewrites the push it receives. What APNs does allow
  is `apns-collapse-id`: every push for one notification carries the same id
  (a hash of Station and notification ids), so a re-delivery after a content
  edit replaces the shown alert instead of stacking. Replacing a read alert
  with a quiet "handled" push was rejected: it re-posts to the lock screen to
  say there is nothing to see. An iOS alert therefore stays in Notification
  Center until the person clears it.
- **Alert taps.** The sealed plaintext also carries `session_id` and
  `project_slug` (the FCM alert's reference, from the same
  `nativeSessionReference`; contract grammar only, kept with hidden content
  and never cut to fit). The plugin wraps the notification-center delegate's
  `userNotificationCenter(_:didReceive:withCompletionHandler:)` (the Tauri
  notification plugin owns that delegate and ignores push taps) with
  `NotificationResponseHook`, which runs the original after it. On a default
  tap `AlertTapRouteResolver` opens the seal again with the registration's
  key and the extension's checks (version, `rid`, pinned `sk`, alert domain,
  `user_id`), takes the reference only in the contract grammar, and keeps
  the route for `take_launch_route` with a `launchRoute` event: the same
  path, shape and opener as Android. The route also carries the seal's
  `notification_id` (record grammar only), so the tap reads the record. A
  route has no freshness bound; it only navigates and reads. The hook and the take command are unit-tested on macOS
  and compile for the iOS simulator; cold- and warm-start taps on a device
  are not verified.
- **Remaining alert-specific work.** Foreground alert presentation and
  web-layer alert-token registration are separate from the implemented iOS
  Live Activity registration. A push-to-start registration does not by
  itself enable regular alert pushes.
- **Enablement checklist** (in addition to the Live Activity slice D steps):
  1. Push on the App ID (alerts need no broadcast capability or extension),
     and the `ALERT_PER_TOKEN_LIMITER` binding deployed with the gateway.
  2. Device verification of the delegate hook, before anything depends on
     it: on an enabled build, `alert_token` returns a token (not the 10 s
     timeout) on a fresh launch and after a relaunch, on the oldest and newest
     supported iOS. The delegate is set again on every launch of an enabled
     build, so also confirm that a deep link (`openURL`), a universal link,
     scene connection, and going to the background and back to the
     foreground all still work after launch.
  3. A real alert through the gateway to that token, with and without
     `hideContent`, confirming the fixed text, sound and collapse.
  4. The web layer's iOS registration (#2660) following the contract above.

### Provisioning

- Firebase project `kontour-station` under the kontourai.io organization,
  Spark plan, Analytics and Gemini off. Android apps are registered for
  `io.kontourai.station` and its `.nightly`, `.beta` and `.debug` variants in
  the recorded setup. `.beta` is now retired; current configured gateway
  allowlists exclude it. This source change does not delete provider records
  or establish that a new gateway configuration was deployed.
- Service account `station-push-gateway`, whose only role is Firebase Cloud
  Messaging API Admin. The organization blocks service-account keys; the
  project alone carries an exception (`iam.managed.disableServiceAccountKeyCreation`
  not enforced) so the Worker can hold one key, which lives only in the Worker
  secret `FCM_SERVICE_ACCOUNT`.
- Worker `station-push-gateway` on Cloudflare (workers.dev for now).

### Delivery status

| Slice | State |
|---|---|
| Android rendering + FCM receipt (`src-desktop/plugins/agent-activity`) | built. Verified on a Pixel 10 Pro XL (Android 16): real FCM delivery, and delivery through the deployed gateway, to a killed process; promoted chip; launch after that wake. That device verification predates the 2026-09-25 rewrite of the card model and notifier, which is verified by JVM unit tests, a one-off randomized comparison against the previous code (not kept in the repo), and an old-versus-new comparison on an Android 16 (API 36) emulator: channels, cards, alerts, dedupe, stale and clock-skewed pushes, swipe and tap re-arm matched. Status-bar promotion and real FCM delivery were not exercised after the rewrite |
| Push gateway (`deploy/push-gateway`) | built and deployed; FCM only. Verified end to end with a throwaway Station key |
| Station notifications on Android (#2588: gateway kind, `FcmAlertChannel`, `StationNotifications.kt`) | built; the channel is tested through the production delivery wiring against the gateway's own verifier and request parser, and the phone opens the shared known-answer vector in a JVM unit test. Not yet verified on a device or emulator. The gateway change is deployed |
| Station publisher (push key, device tokens, card building, session state → gateway) | built; cards are sealed to each phone. Verified against the gateway's own verifier and request parser, and against the phone's opener through a shared known-answer vector. FCM rotates tokens without the app open and the plugin has no `onNewToken` hook, so the app re-registers on start and on return to the foreground |
| Web registration (`configure`, `pushToken`, settings UI) | built: Settings → Notifications → "Agent activity on this phone", shown only when the host reports `remote-push` enabled: an Android build with all four `STATION_FIREBASE_*` values, or an iOS build with the Live Activity plugin (`STATION_IOS_LIVE_ACTIVITY=1`), where it also stays hidden until the plugin's `status` reports the build signed for push (`pushConfigured`) on iOS 18. iOS registers `{ token, packageName, platform: 'ios', apnsEnvironment }` from the plugin's push-to-start token and the environment it names, and asks for no notification permission. Registrations are kept per Station; the card key goes from the Station's response straight to the plugin (on iOS, into the keychain group shared with the widget) and is never kept in WebView storage. The app re-registers on start and return to the foreground when the token (or its APNs environment) changed, the registration is a day old, or the Station's `GET /api/system/native-push` reports no registration or a different `registrationId`; a Station without that route (404/405) or one that cannot answer leaves the first two rules. The iOS path is unit-tested against the plugin's reply shapes only; no device has run it |
| One card per Station on the phone | built: each registration has its own card, replay state and intents; cards open only with that registration's key and must carry its Station's key thumbprint |
| APNs in the gateway (`/v1/apns/live-activity`, `/v1/apns/channels`) | built: one broadcast channel per activity, created inside its start, bound to the Station key by `channelAuth`, and recorded in a SQLite-backed Durable Object ledger that a three-minute sweep reconciles against Apple, with bounded deletion opportunities shared across scopes after expiry and grace. The Durable Object is chosen for correctness (a strongly consistent single writer: Workers KV's eventual consistency could let the sweep miss a fresh record and delete a live channel); the sweep's cadence and per-run caps are shaped by the Workers Free plan's 50-subrequest limit, and Free's CPU limit is not yet verified. The ledger also keeps a guard of six accepted starts per device per UTC day against a runaway honest Station (not an abuse bound; the per-key and global limiters are); an end may carry the fixed alert. Live on a gateway deployed with the `APNS_AUTH_KEY` and `APNS_CHANNEL_AUTH_SECRET` secrets set, dark without them; the gateway is deployed by hand, no workflow deploys it; tested against a fake APNs only |
| iOS Station side (registration, `native-push-ios-registrations.json`, planner, tombstones, live-activity and channel requests) | built; every request body is checked against the gateway's own APNs request parsers, and every gateway answer against the Station's handling |
| iOS Live Activity: widget extension and Swift plugin (#2513 slice C) | built, off by default. Enabling takes both halves: `STATION_IOS_LIVE_ACTIVITY=1` builds the plugin, and `scripts/ensure-ios-agent-activity-extension.mjs` adds the extension and the app's keychain groups to the rendered `gen/apple/project.yml`, followed by `xcodegen generate`. The committed project carries neither half; current Nightly TestFlight builds enable it (slice D); Stable uses the same path only after the owner sets `STATION_IOS_STABLE_PUSH_ENABLED=true` in `native-release`. The widget shows a card only if it opens and verifies; at or past `activity_expires_at` (or once ActivityKit marks it stale) it shows "Waiting for Station" with no card content. A relay can replay an earlier genuine card until that card's expiry; the phone keeps no record of the last card it accepted. Shared card code is tested on macOS only (`swift test`); no device build has been verified |
| iOS enablement and App Store signing (#2513 slice D) | source-enabled in CI for Nightly; not verified here on a device. The earlier Beta/Nightly provisioning report records Push Notifications, Broadcast, production profiles and gateway APNs secrets; it does not establish current provider state. Beta is retired. Current `testflight-delivery.yml` builds both halves for Nightly through `ios-nightly`, with separately provisioned profiles. It declares `NSSupportsLiveActivities` in the shipped app `Info.plist`, and signs the extension with its own profile. It audits the embedded widget, both profiles, both sets of entitlements, and the compiled plugin class in the IPA ([mobile-release.md](../guides/mobile-release.md#live-activity-in-stable-and-nightly)). Stable defaults off, with both extensions available behind its environment switch and separate profiles. See the [Stable owner checklist](../guides/mobile-release.md#stable-push-owner-checklist). Signed-package evidence and physical delivery must be obtained separately; #2808 owns physical verification |
| iOS notification alerts, fixed text (#2589) | built. The Station side is dormant until a phone sends an alert token. Gateway `/v1/apns/alert` is live on a gateway deployed with the APNs secrets set and the `ALERT_PER_TOKEN_LIMITER` binding (without the binding it answers 503); the gateway is deployed by hand, no workflow deploys it; tested against a fake APNs only. Also built: the optional `alertToken` on the iOS registration, `ApnsAlertChannel` in the delivery router, and the plugin's `alert_token` command (off with the rest of the plugin; the delegate hook is tested on macOS only and needs device verification before enabling). See the enablement checklist in "iOS: notification alerts" |
| iOS Notification Service Extension (#2590) | built, off by default: `scripts/ensure-ios-agent-activity-extension.mjs` with `--notification-service` adds it on top of the Live Activity's project half, a separate switch because it needs a third App ID and profile (`<app>.NotificationService`). The committed project does not carry it; `testflight-delivery.yml` enables it for Nightly (its own App Store profile in `ios-nightly`) and audits its embedded profile and signed entitlements in the IPA. Stable defaults off and can opt into the same extension pair after owner provisioning. The opening logic has macOS `swift test` coverage; physical decrypted-alert delivery remains a separate check (#2808) |

The Android plugin builds with or without Firebase. Its Firebase identity comes
from `STATION_FIREBASE_APP_ID`, `_API_KEY`, `_PROJECT_ID` and `_SENDER_ID` at
build time (public values, but bound to one project); without them
`pushToken` reports `unconfigured`. With them, Firebase auto-init stays off
until `pushToken` is called, so installing the app does not contact Google
before the user asks for push; the `clear` command turns it off again and
deletes the token. The plugin's Kotlin unit tests also have a hosted job in
`desktop-rust.yml`, using `scripts/run-agent-activity-android-unit-tests.mjs`
(which also runs the media-intake plugin's tests).
The runner builds a temporary Gradle root, uses the locked Tauri Android library,
and refuses missing test classes or required cases. That workflow contract is
not a receipt for a particular hosted run or physical FCM delivery. Debug builds include a broadcast receiver,
restricted to the `adb` shell, that stands in for FCM so rendering and
wake-from-cold can be verified without a sender — see
`DebugAgentActivityReceiver.kt`.

## Rules this area has earned

- **The retired generic watch received an SDK-built URL.** Its route paths and status
  vocabulary live in the SDK (`notificationsUrl`, `LIVE_NOTIFICATION_STATUSES`)
  and were handed to the host as a finished URL. The first cut of the poller
  kept its own copy of both, and the copy was already wrong — it polled
  `/api/notifications` when the route is `/notifications`. The later host-owned
  desktop delivery consumer has its own fixed typed endpoint contract below;
  this watch rule is not a claim that no Rust module knows a Station route.
- **A poll loop must not swallow its first error.** The watch failed 100% of
  its polls for three build cycles (no TLS backend compiled in) and looked
  exactly like a working one. Its fix made the first poll synchronous and
  report failure; only after it proves the endpoint may errors be treated as blips.
- **`eprintln!` does not reach logcat.** Tauri pipes Chromium's output, not
  Rust's. Diagnostics have to come back through the command's return value.
- **Test guards against the real failure, not the happy path.** The TLS guard's
  first version asserted against a closed port, where connection-refused
  short-circuits before TLS is negotiated — it passed with no TLS backend at
  all. It now runs against a live local listener.

## Desktop local access review

The desktop tray now owns a separate, narrow access-request watch (`src-desktop/src/local_access_watch.rs`). It watches only the local instance selected by native ownership, proving possession of that instance's owner-only boot secret through the local-access route. It does not depend on a mounted WebView. Pending requests remain in the tray menu; OS notification activation opens the exact still-pending request for Approve, Deny or Not now. Closing the dialog never grants access. Expired requests and changed instance ownership cannot be acted on through a stale notification.

This is distinct from the retired generic/mobile notification watch described above. It does not establish background mobile push support. Physical delivery and click evidence must be recorded against the native build; unit tests alone are not delivery proof.

Channel-specific `open-browser` links are handled by the desktop host. It verifies the requested loopback browser port against its owned Station before minting a launcher capability. These links carry an origin, never an operator credential or arbitrary redirect destination.

Closing the desktop main window hides it to the tray while its owned backend and access watch continue. Explicit Quit remains the process/sidecar shutdown action.

## Desktop OS alerts: one native consumer of the delivery feed

The server's delivery router decides desktop OS alerts and queues them per
surface: this computer's desktop app reads `local:desktop-<installationId>`,
a desktop app paired to a remote Station reads `device:<id>`, both from
`GET /api/notifications/deliveries?after=&epoch=` with the
`X-Station-Desktop-Installation` header. Every entry has already passed focus
presence, quiet hours, mutes and minimum urgency, and is redacted per the
surface's `hideContent`. A reader shows what it reads and filters nothing.

This feed is the direct HTTP/bearer path. The selected native relay member route
has a separate read-only application allowlist that excludes notification
feeds and registration; host command registration does not add those resources.
Its account-bound Device also cannot register for agent activity, whose
registration owner requires an eligible personal Device. Native relay enrollment
and account sign-in therefore do not establish desktop feed delivery, background
push or card continuity. The retained push and direct-feed receipts below do
not qualify that member route.

**The desktop host is the only reader (#2608).** The webview used to read the
feed, and a window hidden in the tray suspends its page, so nothing alerted
while hidden. `src-desktop/src/notification_feed.rs` now reads it on a host
thread with a 20-second sleep between polls (normally inside the server's
90-second lease), whatever the
window is doing. The webview asks `notification_feed_native_consumer` before
its first read; this host answers `true`, and the webview then never reads the
feed and never posts from it (`src-ui/src/platform/native/deliveryFeed.ts`).
The answer is fixed for the process, so the role never changes hands at
runtime and the two can never both alert. A shell without the command answers
`false` and the webview stays the reader, as before.

- **Same surface, same credential for direct profiles.** The host reads the host-authorized active
  Station through direct HTTP with that profile's bearer, matching the direct
  webview broker's `station_native_http_request` authority, so the server derives
  the same surface. No new credential exists; with no authorized Station the
  host reads nothing.
- **Cursor and epoch** persist per Station origin in the app config directory
  (`notification-delivery-cursors.json`, owner-only, least recently used
  origin evicted past 16), tagged with the surface the server
  echoed; a cursor for another surface is not used, and a different epoch is
  a restarted server whose answer is all new.
- **Only a definite answer settles the role.** `true`, or `false` / Tauri's
  "Command … not found" from an older shell (or no Tauri bridge at all), is
  remembered for the page. Any other failure of the question reads and posts
  nothing and asks again on the next poll; treating it as "not native" would
  let both post. A test pins the three command names the webview invokes to
  the desktop `generate_handler!`.
- **Handoff across an upgrade.** An older build's webview kept its cursor in
  localStorage. The new webview offers it to the host once
  (`notification_feed_adopt_cursor`, main window only, off the main thread)
  and deletes its copy only if the host took it. The host takes it only when
  it has no cursor of its own for that Station, and then resumes exactly where
  the webview stopped. Without either cursor the host reads without applying
  for up to 30 seconds (monotonic clock), then starts from the cursor its
  first read saw, so entries after that read still alert and an
  already-alerted backlog is not replayed. An offer is refused once the host
  has chosen its own start (a committed cursor, or a read that chose one
  still being committed), so entries queued between the webview's cursor and
  the host's first read (while the app was closed for the upgrade) are then
  not alerted.
- **One attempt per entry.** A read is decided under the consumer lock, its
  OS calls are made with the lock released, in order, and the cursor is
  committed as far as the outcomes allow: saved past each consumed entry
  before the next call, and through the whole read when the poll ends.
  Shown, refused by the OS, or timed out (the call was made and did not
  answer within five seconds): the entry is consumed, the cursor passes it,
  and it is never tried again. Refusals and timeouts are logged at most once
  a minute. A show that answers late still has its handle kept.
- **Only a call not made is retried.** When the breaker is open or the gate
  is disabled, no call is made: the poll stops before that entry, the cursor
  does not pass it, and nothing after it is posted in that poll.
- **Stale entries.** An alert queued more than 15 minutes before the server
  answered is consumed without posting, so the backlog after the gate
  re-enables or after a restart is not replayed. Both times are the
  server's: the entry's `at` against the feed's `now`. The desktop's own
  clock is never used, so a remote Station whose clock differs from this
  computer's neither drops fresh alerts nor keeps stale ones. A server too
  old to send `now` has nothing stale. Stale drops are logged at most once a
  minute.
- **Stuck notification service.** zbus has no method timeout, so each OS
  call runs on a helper thread bounded at five seconds, and while four calls
  are still stuck no new call is made. After 15 polls in a row (about five
  minutes) ending that way, the stuck calls are written off and calls
  resume; once 16 calls have been written off over the process's lifetime,
  Station makes no OS notification call again and **desktop alerts stop until
  the app restarts** (logged as an error). The consumer lock is never held
  across an OS call, so none of this blocks a handover.
- **Duplicates.** The dedupe of shown content is in memory and bounded. The
  poll thread is not joined on quit. The cursor is saved before each next
  call, not inside one, and nothing is saved before a read's first call. So
  a crash or quit during that first call replays, on the next launch, the
  whole read from the previous cursor, including entries consumed without
  a call (focus-suppressed, deduped, retracted), which are decided again
  with the in-memory dedupe gone. Later in the read, it reposts the entry
  whose call was in progress or had just returned. A cursor file that fails
  to save (logged once per failure streak) replays from the last saved
  cursor on the next launch, bounded by the server's 60-minute retention
  and, when the server sends `now`, by the 15-minute staleness.
- **Focus.** No OS alert while the main window is focused and visible (the
  in-app toast shows it); the entry is consumed.
- **Retract** closes the OS notification the host posted for that id where the
  pinned backend can: Linux (D-Bus `CloseNotification`). A retract that
  arrives before its alert's late answer leaves a bounded tombstone, and the
  late notification is closed as soon as it answers; an older post's late
  answer never replaces a newer post's handle, and that superseded
  notification stays on screen with no handle, so a retract of its id closes
  only the newer one. notify-rust 4.18's
  macOS (NSUserNotificationCenter) and Windows handles expose no close, so
  there a retract only stops an alert not yet posted (a retract later in the
  same read). tauri-plugin-notification 2.4.0 cannot remove a delivered
  notification on any desktop platform either.
- **Click** focuses the app and hands the entry's `link` to the main webview,
  with the Station origin the host read that entry from (its own record,
  never a feed field): the host keeps `{ link, origin }` for 60 seconds and
  emits `station://notification-open`, and the webview takes it once
  (`take_notification_open_link`) and gives it to the notification opener,
  which opens the link on the saved Station at that origin, switching first
  when another Station is active by then. An alert clicked after a Station
  switch therefore never looks its session up on the wrong Station. A link
  naming a different Station than its origin's connection, or an origin no
  saved connection serves, shows a notice instead. The link must be an in-app path (`/…`, optional query; no
  scheme, `//host`, backslash, fragment, whitespace or control character),
  and its NORMALIZED path must not be `//host` either (`/..//host`,
  `/%2e%2e//host`); it is checked natively and again in the webview
  (`src-ui/src/lib/notificationOpen.ts`), and the normalized path is what
  navigates. Anything else opens the app where it was; no URL outside the app
  is ever opened. On macOS a click is observed by a waiting thread per alert
  (at most 32), and a slot frees only when its notification is clicked,
  dismissed or cleared from Notification Center; past the cap alerts still
  show but their clicks open nothing.

The retired host notification watch was not this: it posted raw titles and
ignored envelopes, `hideContent`, quiet hours and mutes.
Blocking-category alerts (`blockingAlert.ts`) still come from the webview and
so still pause while it is hidden.

## Opening a notification on the Station that sent it

A device may be paired with several Stations, and a notification can arrive
from one while another is active. Opening it must land on the right Station
and the right conversation.

- **One href.** Every channel opens a record at the same place, computed once
  on the server: the envelope's path target; else the session
  `notificationOpenSession` names (`notificationSessionIdentity`: the
  metadata's session, then the envelope's audience, target or agent; the
  session the read gate and audience were checked against) as
  `notificationSessionHref` (`/projects/<slug>?chat=<id>&dock=open`, the
  metadata's Project unless the metadata names another session, else
  `/?chat=<id>&dock=open`, for runtime and managed sessions alike); else the
  record's validated `metadata.link`; else `/notifications`. Web Push and the
  desktop feed send it as a link (`notificationOpenLink`); FCM and APNs
  alerts seal the same session as `session_id` / `project_slug`
  (`nativeSessionReference`). The in-app toast and the attention inbox's
  Open use the same href builder for a session.
- **The sending Station.** An OS link carries `station=<environmentId>`
  (`NOTIFICATION_STATION_QUERY_PARAM`, the id a client saved for that
  Station when it connected), added by `withOpenedNotification` beside
  `openedNotification`; one already in the link is replaced, never trusted,
  and an id outside the contract grammar is left out. A phone's route
  carries its registration's verified Station id, and an alert tap's route
  also carries the alert's record id (the APNs seal's `notification_id`, the
  FCM plaintext's `id`), which the web layer adds as `openedNotification` so
  opening the alert reads it; an id outside the record grammar drops only the
  read. The desktop host adds the origin it read the alert from. None of these names an origin to open: the
  identity only selects among connections already saved on the device, and
  the link stays a relative in-app path with every same-origin check intact.
- **One opener.** `requestNotificationOpen` (`src-ui/src/lib/notificationStationOpen.ts`)
  is the entry point for a desktop click, a Web Push tap, a cold load and a
  phone tap. The active Station's id is its saved connection's, or the
  verified authority observation's when the connection never saved one (a
  same-origin browser connection does not); taps wait for it, up to eight
  seconds, before they are placed. With no Station named (an older
  Station) or the active one, it navigates at once. A Station id that
  matches no saved connection while the active id is still unknown is never
  opened on a guess: "Couldn't confirm the Station", with Retry. On the
  desktop the host's origin outranks the link: an origin no saved
  connection serves is "not saved", whatever id the link names. For another
  saved Station it shows "Opening conversation on <Station>" with a spinner,
  switches (`setActiveConnection`), and only then navigates, and only when
  this is still the newest tap and the store committed that Station (the
  connection provider resolves a selection a newer one overtook without
  committing it). A tap for the active Station while an earlier tap is
  still switching away re-selects the active Station, so the last tap wins.
  A Station not saved on this device, or a failed or overtaken switch,
  shows a notice with Manage Stations (and Retry for a failed switch)
  instead of dropping the tap. On a phone-width screen the notice sits just
  above the collapsed dock rather than over the top of the page.
- **Cold loads.** A tab loaded on a link that names a Station has `chat`,
  `dock`, `openedNotification` and `station` taken off the URL before the
  first render, and the request waits for the opener: the dock never looks
  the conversation up on whichever Station happened to be active, and the
  read marker is sent to the right one. A request that waited is dropped
  when the person navigated (or went Back) before the opener mounted
  (`installNavigationPosition`, the navigation store's history index).
- **No reload where the app runs.** The service worker posts
  `station-notification-open` with the link's on-origin URL to the focused
  tab and waits up to 1.5 seconds for its acknowledgement
  (`NotificationStationOpener`); a tab that does not answer is navigated to
  the link, and with no tab one is opened. The attention inbox's Open and
  the in-app toast's Open navigate in the app (`openNotificationTargetHere`),
  marked like a tap so a missing or refused conversation is reported; the
  attention Open records its acknowledgement after.
- **Opening and failure states.** While the dock resolves a deep-linked
  conversation it shows a visible "Opening conversation" label ("Opening
  conversation on <Station>" after a switch) over the conversation it showed
  before, which stays mounted hidden and inert; the header names the open,
  and the inbox selection and This Chat card stand down until it lands.
  When a notification asked for the conversation, a miss is said rather
  than only cleared: not found (also what an unreadable session answers),
  no access (403, at once: a refusal is the Station's answer), or the
  Station did not answer, with Retry. That Retry belongs to the Station that
  did not answer: once another Station is active the notice is retired and
  its Retry does nothing. A `?chat=` that no notification opened (a reload
  of a draft that was never saved, #1582) keeps its quiet behavior,
  including a 403, which keeps the bounded retry and then the Chat surface. A second attempt for the same chat
  while its lookup is in flight (the agent catalog loading mid-lookup) reuses
  that lookup.
- **Not covered.** Approval notifications open their session, not the
  pending request inside it: the dock's `?chat=` open does not read the
  message anchor `surfaceDeepLink` can carry. Android still suppresses every
  Station's notification while the app is in the foreground, including one
  from a Station other than the connected one, which then shows nowhere.
