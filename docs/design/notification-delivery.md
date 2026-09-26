# Notification delivery on native shells

The contract for how a Station notification reaches the person who needs to act
on it, and why the obvious implementations do not work.

## The problem

Station raises notifications server-side — a device asking to pair, an approval
waiting. The web app receives them over SSE and shows a toast. On a phone that
is not enough: the moment you are looking at something else, the toast has
nobody to show itself to, and the thing you are being asked to approve expires
in five minutes.

## Four implementations that do not work

Each looks correct and fails in practice. They are recorded because each was
actually built before something — usually a device, once the upstream issue
tracker — disproved it.

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

The lesson generalises past notifications: **native Rust HTTP is not usable on
Android in this app**. Anything the host needs to fetch has to be resolved by
the platform, not by `getaddrinfo`.

## Status: the watch is landed and dormant

`notification_watch_start` / `notification_watch_stop` exist and are tested, and
**nothing calls them**. Push (below) supersedes it for backgrounded delivery.
The dormant call site is commented in
`src-ui/src/contexts/ApiBaseContext.tsx` so switching it on is a visible,
small change rather than an archaeology exercise.

(Historical: archive#3088 corrected this record after a backlog sweep closed
the original tracking issue with no code change. It is itself now closed, so
it must not be cited here as live tracking — that would repeat the very
defect it was filed for.)

## Where this leaves delivery

| App state | Covered |
|---|---|
| Foreground | yes |
| Backgrounded, process alive | **no** — frozen, and the service that would prevent it is blocked upstream |
| Force-quit / swiped away | **no** |
| Device rebooted, app never opened | **no** |

Everything below the first row needs FCM on Android and APNs on iOS
(archive#917, reseeded as #63 and batched into #177). The native capability
report therefore returns `remote-push: unsupported` instead of allowing the
presence of the local-notification plugin or dormant watch to be mistaken for
wake-capable delivery. archive#1225 remains open until the mobile applications
and server send credentials are provisioned; repository code cannot
manufacture those provider identities.

That is not a consolation prize. Push is the mechanism that does not require
keeping a process alive at all — the system unfreezes the app to deliver — so it
sidesteps the freezer, both Tauri bugs, and the battery cost of polling
together. Keeping a process alive to poll is fighting the platform; push is the
platform's answer. The cost is real and is a product decision, not a technical
one: every notification leaves the machine and transits Google or Apple, which
matters for a self-hosted product.

**iOS** has no foreground-service equivalent either, and is foreground-only
until push lands.

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
- **Stateless, Station-signed.** The gateway does not link Stations to hosted
  user accounts, store device tokens, or build cards. Station has no hosted
  accounts, and a Station already knows its paired phones, so the
  gateway (`deploy/push-gateway`) keeps nothing: every request is signed by the
  Station's own P-256 push key (ES256, body hash bound into the token, at most
  120 s lifetime). The gateway verifies it, rate limits per key and globally,
  accepts only a data-only agent-activity message for a Station package, and
  forwards it to FCM at high priority. The Station owns device tokens, builds
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
  `liveactivity` pushes, with push-to-start tokens (iOS 17.2+) so a card can
  appear while the app is closed.

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
neither the freezer nor tauri#11609/#15671 is involved. Rust does no
networking, so the DNS failure does not apply either. Two limits remain. FCM
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
  device, body `{ token, packageName, platform: 'android' }`, returns
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
  Revoking or replacing a device drops its registration, and a registration
  whose device is no longer active is never listed. Hosted-tenant mode
  disables both routes, as it does Web Push; an invalid gateway URL, or a
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
  and navigates only when the route's Station is the connected one, to the
  Station's exact-session deep link: `/projects/<slug>?chat=<id>&dock=open`,
  or `/?chat=<id>&dock=open` without a project. A route for another Station
  is dropped; switching Stations from a tap is not attempted. The check is
  per Station, not per user: with two registrations for different users on
  one Station, a card may navigate the app while it is connected as the
  other user. Only navigation follows; the session itself stays behind the
  server's per-session read checks. The iOS Live Activity receives the same
  fields inside its seal and ignores them: an iOS tap opens the app without
  routing.
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
  is its known-answer vector. When the phone's surface asked to hide content,
  the title and body are replaced with generic copy before sealing. Station
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
  to. A newer send for the same id replaces the waiting one in place. At
  most eight sends wait per phone: past that the oldest waiting `info` alert
  is dropped and logged, and attention, failed and done alerts and retracts
  are never dropped. The router records a delivery when it plans it, so the
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
  registration. It does not carry what the card already alerts for: an
  `approval-request`, `turn-completed`, `turn-stopped` or `turn-failed`
  whose record says it is about an orchestration session (`sessionKind`
  `runtime` with a `sessionId`, and `requestKind` absent or
  `orchestration`). A registry approval (`sessionKind` `managed`,
  `requestKind` `registry`) is never on the card and is carried, as is any
  record that does not identify itself as orchestration-backed. The iOS
  alert channel (#2589) applies the same rule. On the
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
  device itself), so a card never holds a session that credential may not
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
  approval or input request), `completed` → `completed`, `failed` → `failed`;
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
  Station no longer knows it.

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
- **Web-layer contract** (for the iOS registration flow, #2660, not built:
  the settings flow is Android-only today, so no phone sends a token yet):
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
  open; until it exists, the fixed text is what shows. With `hideContent` the
  sealed payload carries neither title nor body.
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
  phone needs the Notification Service Extension (#2590) to check the
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
  lands late raises no alert either. The inbox keeps both. Only this
  alert channel reads the stamp: the two records of a Station-agent
  approval are still two notifications everywhere else. The exclusion
  does not look at the phone: with Live Activities turned off, the
  card-announced notifications raise no alert at all (the inbox keeps them).
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
- **Not built.** Foreground presentation (the app sets no
  `UNUserNotificationCenter` delegate, so an alert that arrives while the app
  is open is not shown; the in-app toast covers that case), tap routing, and
  the web layer's iOS registration.
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
  `io.kontourai.station` and its `.nightly`, `.beta` and `.debug` variants.
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
| Station notifications on Android (#2588: gateway kind, `FcmAlertChannel`, `StationNotifications.kt`) | built; the channel is tested through the production delivery wiring against the gateway's own verifier and request parser, and the phone opens the shared known-answer vector in a JVM unit test. Not yet verified on a device or emulator, and the gateway change is not yet deployed |
| Station publisher (push key, device tokens, card building, session state → gateway) | built; cards are sealed to each phone. Verified against the gateway's own verifier and request parser, and against the phone's opener through a shared known-answer vector. FCM rotates tokens without the app open and the plugin has no `onNewToken` hook, so the app re-registers on start and on return to the foreground |
| Web registration (`configure`, `pushToken`, settings UI) | built: Settings → Notifications → "Agent activity on this phone", shown only when the host reports `remote-push` enabled: an Android build with all four `STATION_FIREBASE_*` values, or an iOS build with the Live Activity plugin (`STATION_IOS_LIVE_ACTIVITY=1`), where it also stays hidden until the plugin's `status` reports the build signed for push (`pushConfigured`) on iOS 18. iOS registers `{ token, packageName, platform: 'ios', apnsEnvironment }` from the plugin's push-to-start token and the environment it names, and asks for no notification permission. Registrations are kept per Station; the card key goes from the Station's response straight to the plugin (on iOS, into the keychain group shared with the widget) and is never kept in WebView storage. The app re-registers on start and return to the foreground when the token (or its APNs environment) changed or the registration is a day old. The iOS path is unit-tested against the plugin's reply shapes only; no device has run it |
| One card per Station on the phone | built: each registration has its own card, replay state and intents; cards open only with that registration's key and must carry its Station's key thumbprint |
| APNs in the gateway (`/v1/apns/live-activity`, `/v1/apns/channels`) | built: one broadcast channel per activity, created inside its start, bound to the Station key by `channelAuth`, and recorded in a SQLite-backed Durable Object ledger that a three-minute sweep reconciles against Apple, so a channel left behind is reclaimed about 12 hours after its creation. The Durable Object is chosen for correctness (a strongly consistent single writer: Workers KV's eventual consistency could let the sweep miss a fresh record and delete a live channel); the sweep's cadence and per-run caps are shaped by the Workers Free plan's 50-subrequest limit, and Free's CPU limit is not yet verified. The ledger also keeps a guard of six accepted starts per device per UTC day against a runaway honest Station (not an abuse bound; the per-key and global limiters are); an end may carry the fixed alert. Live on a gateway deployed with the `APNS_AUTH_KEY` and `APNS_CHANNEL_AUTH_SECRET` secrets set, dark without them; the gateway is deployed by hand, no workflow deploys it; tested against a fake APNs only |
| iOS Station side (registration, `native-push-ios-registrations.json`, planner, tombstones, live-activity and channel requests) | built; every request body is checked against the gateway's own APNs request parsers, and every gateway answer against the Station's handling |
| iOS Live Activity: widget extension and Swift plugin (#2513 slice C) | built, off by default. Enabling takes both halves: `STATION_IOS_LIVE_ACTIVITY=1` builds the plugin, and `scripts/ensure-ios-agent-activity-extension.mjs` adds the extension and the app's keychain groups to the rendered `gen/apple/project.yml`, followed by `xcodegen generate`. The committed project carries neither half; only the Beta and Nightly TestFlight builds enable it (slice D). The widget shows a card only if it opens and verifies; at or past `activity_expires_at` (or once ActivityKit marks it stale) it shows "Waiting for Station" with no card content. A relay can replay an earlier genuine card until that card's expiry; the phone keeps no record of the last card it accepted. Shared card code is tested on macOS only (`swift test`); no device build has been verified |
| iOS enablement and App Store signing (#2513 slice D) | enabled in CI for Beta and Nightly; not yet verified on a device. The Beta and Nightly App IDs have Push Notifications and Broadcast. Their App Store profiles carry `aps-environment=production`, and `<app id>.AgentActivity` has its own profile in the `ios-beta` and `ios-nightly` environments. The gateway has its APNs secrets. `testflight-delivery.yml` builds both halves for those channels. It declares `NSSupportsLiveActivities` in the shipped app `Info.plist`, and signs the extension with its own profile. It audits the embedded widget, both profiles, both sets of entitlements, and the compiled plugin class in the IPA ([mobile-release.md](../guides/mobile-release.md#live-activity-in-beta-and-nightly)). Stable builds neither. No TestFlight run has built the Live Activity yet, and no installed build has shown a Live Activity |
| iOS notification alerts, fixed text (#2589) | built. The Station side is dormant until a phone sends an alert token. Gateway `/v1/apns/alert` is live on a gateway deployed with the APNs secrets set and the `ALERT_PER_TOKEN_LIMITER` binding (without the binding it answers 503); the gateway is deployed by hand, no workflow deploys it; tested against a fake APNs only. Also built: the optional `alertToken` on the iOS registration, `ApnsAlertChannel` in the delivery router, and the plugin's `alert_token` command (off with the rest of the plugin; the delegate hook is tested on macOS only and needs device verification before enabling). See the enablement checklist in "iOS: notification alerts" |

The Android plugin builds with or without Firebase. Its Firebase identity comes
from `STATION_FIREBASE_APP_ID`, `_API_KEY`, `_PROJECT_ID` and `_SENDER_ID` at
build time (public values, but bound to one project); without them
`pushToken` reports `unconfigured`. With them, Firebase auto-init stays off
until `pushToken` is called, so installing the app does not contact Google
before the user asks for push; the `clear` command turns it off again and
deletes the token. The plugin's Kotlin unit tests run only
locally (`./gradlew :tauri-plugin-station-agent-activity:testDebugUnitTest` in
a generated `gen/android`); no workflow runs them yet. Debug builds include a broadcast receiver,
restricted to the `adb` shell, that stands in for FCM so rendering and
wake-from-cold can be verified without a sender — see
`DebugAgentActivityReceiver.kt`.

## Rules this area has earned

- **Never assemble Station API knowledge in the host.** Route paths and status
  vocabulary live in the SDK (`notificationsUrl`, `LIVE_NOTIFICATION_STATUSES`)
  and are handed to the host as a finished URL. The first cut of the poller
  kept its own copy of both, and the copy was already wrong — it polled
  `/api/notifications` when the route is `/notifications`.
- **A poll loop must not swallow its first error.** The watch failed 100% of
  its polls for three build cycles (no TLS backend compiled in) and looked
  exactly like a working one. The first poll is synchronous and reports
  failure; only after it proves the endpoint may errors be treated as blips.
- **`eprintln!` does not reach logcat.** Tauri pipes Chromium's output, not
  Rust's. Diagnostics have to come back through the command's return value.
- **Test guards against the real failure, not the happy path.** The TLS guard's
  first version asserted against a closed port, where connection-refused
  short-circuits before TLS is negotiated — it passed with no TLS backend at
  all. It now runs against a live local listener.

## Desktop local access review

The desktop tray now owns a separate, narrow access-request watch (`src-desktop/src/local_access_watch.rs`). It watches only the local instance selected by native ownership, proving possession of that instance's owner-only boot secret through the local-access route. It does not depend on a mounted WebView. Pending requests remain in the tray menu; OS notification activation opens the exact still-pending request for Approve, Deny or Not now. Closing the dialog never grants access. Expired requests and changed instance ownership cannot be acted on through a stale notification.

This is distinct from the dormant generic/mobile notification watch described above. It does not establish background mobile push support. Physical delivery and click evidence must be recorded against the native build; unit tests alone are not delivery proof.

Channel-specific `open-browser` links are handled by the desktop host. It verifies the requested loopback browser port against its owned Station before minting a launcher capability. These links carry an origin, never an operator credential or arbitrary redirect destination.

Closing the desktop main window hides it to the tray while its owned backend and access watch continue. Explicit Quit remains the process/sidecar shutdown action.
