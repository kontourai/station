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
- **What stops a stranger.** Anyone can mint a key, so a key alone proves
  nothing. A sender also needs the phone's FCM token, and the phone drops any
  payload whose `device_id`/`user_id` differ from what its own Station
  configured, so those must be unguessable per-registration values.
- **Android.** FCM *data* messages are received by a native
  `FirebaseMessagingService` that renders the card itself — no WebView, no
  JavaScript. While work runs the card requests promotion
  (`setRequestPromotedOngoing`, `setShortCriticalText`), which Android 16 shows
  as a status-bar Live Update chip.
- **iOS.** A Live Activity from a widget extension, updated by APNs
  `liveactivity` pushes, with push-to-start tokens (iOS 17.2+) so a card can
  appear while the app is closed.

The payload carries status, thread titles and project names, never
transcripts, code or tool output (the same rule as the
[connection broker](connection-broker.md)).

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

The Station side mirrors Web Push (`push-routes.ts`, `wireWebPushDelivery`):

- **Push key.** `security/push-signing-key.json` (0600) holds a P-256 key used
  only for gateway requests: domain-separated from the connection signing key,
  whose tokens are not a general signature (connection-broker.md). It is
  created on the first registration, never before.
- **Registration.** `POST /api/system/native-push/register` from a paired
  device, body `{ token, packageName, platform: 'android' }`, stores
  `{ token, packageName, platform, registrationId, updatedAt }` privately on
  that device's record and returns `{ registrationId, stationId }`.
  `registrationId` is 128 random bits, kept across token rotation, and is the
  value the phone checks on every push (`device_id`); `stationId` is the
  environment id (`user_id`). `DELETE /api/system/native-push` clears the
  caller's own registration only. Unpairing a device drops it with the rest of
  the record. Hosted-tenant mode disables both routes, as it does Web Push.
- **Publisher.** An `ORCHESTRATION_EVENT` subscriber keeps a per-session
  snapshot (title, project, lifecycle state, updated time), coalesces per
  Station, and sends one card to every registered device: at most five rows,
  attention first (approval, input), then failed, then running, then sessions
  finished in the last 15 minutes. Lifecycle maps to the plugin's phases:
  `queued` → `starting`, `running` → `running`, an approval request →
  `waiting_for_approval`, `needs_input` → `waiting_for_input`, `completed` →
  `completed`, `failed` → `failed`; canceled sessions leave the card. An
  alert (`alert_id` = hash of session, phase and entry time) goes out on entry
  into approval or input, and on a finish within the last two minutes. A 410
  from the gateway clears that registration. The listener never throws.
- **Gateway URL.** `STATION_PUSH_GATEWAY_URL`, defaulting to the Kontour
  gateway. Nothing is sent until a device registers, which only happens when
  its user turns agent activity on; the flow is listed in the privacy
  inventory.

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
| Station publisher (push key, device tokens, card building, session state → gateway) | not started. FCM rotates tokens without the app open and the plugin has no `onNewToken` hook yet, so it must re-register from `pushToken` on every foreground or add one |
| Web registration (`configure`, `pushToken`, settings UI) | not started |
| One card per Station on the phone | not started; the plugin has one card slot, so two Stations would overwrite each other |
| iOS Live Activity (widget extension in `gen/apple/project.yml`) and APNs in the gateway | not started |

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
