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

Decided September 23, 2026 by the owner: follow
[T3 Code](https://github.com/pingdotgg/t3code), which ships this for a
self-hosted product today, adapted where Station differs.

- **Why a hosted service at all.** Push credentials belong to whoever publishes
  the app (the Firebase project and the APNs key are bound to its package and
  bundle IDs), so a self-hosted Station cannot send to the published app
  directly. T3 runs a hosted relay (`infra/relay/src/agentActivity/`).
- **Named "push gateway", not relay.** In Station, relay and
  [broker](connection-broker.md) name the path a Device uses to *reach* a
  Station. The push gateway does the opposite job, Station to phone through
  Google or Apple, and only the app's publisher can run it. The broker design
  already kept notifications apart ("a separate payload policy and delivery
  grant").
- **Stateless, Station-signed.** T3's relay links servers to Clerk user
  accounts, stores device tokens and builds each card itself. Station has no
  hosted accounts, and a Station already knows its paired phones, so the
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

**What doing without hosted accounts costs**, compared with T3: no single card
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
| Android rendering + FCM receipt (`src-desktop/plugins/agent-activity`) | built; ported from T3's Kotlin module. Verified on a Pixel 10 Pro XL (Android 16): real FCM delivery, and delivery through the deployed gateway, to a killed process; promoted chip; launch after that wake |
| Push gateway (`deploy/push-gateway`) | built and deployed; FCM only. Verified end to end with a throwaway Station key |
| Station notifications on Android (#2588: gateway kind, `FcmAlertChannel`, `StationNotifications.kt`) | built; the channel is tested through the production delivery wiring against the gateway's own verifier and request parser, and the phone opens the shared known-answer vector in a JVM unit test. Not yet verified on a device or emulator, and the gateway change is not yet deployed |
| Station publisher (push key, device tokens, card building, session state → gateway) | built; cards are sealed to each phone. Verified against the gateway's own verifier and request parser, and against the phone's opener through a shared known-answer vector. FCM rotates tokens without the app open and the plugin has no `onNewToken` hook, so the app re-registers on start and on return to the foreground |
| Web registration (`configure`, `pushToken`, settings UI) | built: Settings → Notifications → "Agent activity on this phone", shown only when the host reports `remote-push` enabled: an Android build with all four `STATION_FIREBASE_*` values, or an iOS build with the Live Activity plugin (`STATION_IOS_LIVE_ACTIVITY=1`), where it also stays hidden until the plugin's `status` reports the build signed for push (`pushConfigured`) on iOS 18. iOS registers `{ token, packageName, platform: 'ios', apnsEnvironment }` from the plugin's push-to-start token and the environment it names, and asks for no notification permission. Registrations are kept per Station; the card key goes from the Station's response straight to the plugin (on iOS, into the keychain group shared with the widget) and is never kept in WebView storage. The app re-registers on start and return to the foreground when the token (or its APNs environment) changed or the registration is a day old. The iOS path is unit-tested against the plugin's reply shapes only; no device has run it |
| One card per Station on the phone | built: each registration has its own card, replay state and intents; cards open only with that registration's key and must carry its Station's key thumbprint |
| APNs in the gateway (`/v1/apns/live-activity`, `/v1/apns/channels`) | built: one broadcast channel per activity, created inside its start, bound to the Station key by `channelAuth`, and recorded in a SQLite-backed Durable Object ledger that a three-minute sweep reconciles against Apple, so a channel left behind is reclaimed about 12 hours after its creation. The Durable Object is chosen for correctness (a strongly consistent single writer: Workers KV's eventual consistency could let the sweep miss a fresh record and delete a live channel); the sweep's cadence and per-run caps are shaped by the Workers Free plan's 50-subrequest limit, and Free's CPU limit is not yet verified. The ledger also keeps a guard of six accepted starts per device per UTC day against a runaway honest Station (not an abuse bound; the per-key and global limiters are); an end may carry the fixed alert. Ships dark until the `APNS_AUTH_KEY` and `APNS_CHANNEL_AUTH_SECRET` secrets are set; tested against a fake APNs only |
| iOS Station side (registration, `native-push-ios-registrations.json`, planner, tombstones, live-activity and channel requests) | built; every request body is checked against the gateway's own APNs request parsers, and every gateway answer against the Station's handling |
| iOS Live Activity: widget extension and Swift plugin (#2513 slice C) | built, off by default. Enabling takes both halves: `STATION_IOS_LIVE_ACTIVITY=1` builds the plugin, and `scripts/ensure-ios-agent-activity-extension.mjs` adds the extension and the app's keychain groups to the rendered `gen/apple/project.yml`, followed by `xcodegen generate`. The committed project carries neither half; only the Beta and Nightly TestFlight builds enable it (slice D). The widget shows a card only if it opens and verifies; at or past `activity_expires_at` (or once ActivityKit marks it stale) it shows "Waiting for Station" with no card content. A relay can replay an earlier genuine card until that card's expiry; the phone keeps no record of the last card it accepted. Shared card code is tested on macOS only (`swift test`); no device build has been verified |
| iOS enablement and App Store signing (#2513 slice D) | enabled in CI for Beta and Nightly; not yet verified on a device. The Beta and Nightly App IDs have Push Notifications and Broadcast. Their App Store profiles carry `aps-environment=production`, and `<app id>.AgentActivity` has its own profile in the `ios-beta` and `ios-nightly` environments. The gateway has its APNs secrets. `testflight-delivery.yml` builds both halves for those channels. It declares `NSSupportsLiveActivities` in the shipped app `Info.plist`, and signs the extension with its own profile. It audits the embedded widget, both profiles, both sets of entitlements, and the compiled plugin class in the IPA ([mobile-release.md](../guides/mobile-release.md#live-activity-in-beta-and-nightly)). Stable builds neither. No TestFlight run has built the Live Activity yet, and no installed build has shown a Live Activity |

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

## Desktop OS alerts: one native consumer of the delivery feed

The server's delivery router decides desktop OS alerts and queues them per
surface: this computer's desktop app reads `local:desktop-<installationId>`,
a desktop app paired to a remote Station reads `device:<id>`, both from
`GET /api/notifications/deliveries?after=&epoch=` with the
`X-Station-Desktop-Installation` header. Every entry has already passed focus
presence, quiet hours, mutes and minimum urgency, and is redacted per the
surface's `hideContent`. A reader shows what it reads and filters nothing.

**The desktop host is the only reader (#2608).** The webview used to read the
feed, and a window hidden in the tray suspends its page, so nothing alerted
while hidden. `src-desktop/src/notification_feed.rs` now reads it on a host
thread every 20 seconds (inside the server's 90-second lease), whatever the
window is doing. The webview asks `notification_feed_native_consumer` before
its first read; this host answers `true`, and the webview then never reads the
feed and never posts from it (`src-ui/src/platform/native/deliveryFeed.ts`).
The answer is fixed for the process, so the role never changes hands at
runtime and the two can never both alert. A shell without the command answers
`false` and the webview stays the reader, as before.

- **Same surface, same credential.** The host reads the host-authorized active
  Station with that profile's bearer — the authority the webview's own
  requests use through `station_native_http_request` — so the server derives
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
- **Click** focuses the app and hands the entry's `link` to the main webview:
  the host keeps it for 60 seconds and emits `station://notification-open`,
  and the webview takes it once (`take_notification_open_link`) and
  navigates. The link must be an in-app path (`/…`, optional query; no
  scheme, `//host`, backslash, fragment, whitespace or control character),
  and its NORMALIZED path must not be `//host` either (`/..//host`,
  `/%2e%2e//host`); it is checked natively and again in the webview
  (`src-ui/src/lib/notificationOpen.ts`), and the normalized path is what
  navigates. Anything else opens the app where it was; no URL outside the app
  is ever opened. On macOS a click is observed by a waiting thread per alert
  (at most 32), and a slot frees only when its notification is clicked,
  dismissed or cleared from Notification Center; past the cap alerts still
  show but their clicks open nothing.

The legacy `notification_watch.rs` is not this: it posts raw titles and
ignores envelopes, `hideContent`, quiet hours and mutes. It stays dormant.
Blocking-category alerts (`blockingAlert.ts`) still come from the webview and
so still pause while it is hidden.
