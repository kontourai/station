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
  which is exactly what Station builds. A fix exists in unmerged PR archive#15678.

Shipping it would trade "notifications do not arrive while backgrounded" for
"the app is broken after you swipe it away" — a worse defect, and one the user
hits without doing anything unusual. Revisit when archive#11609 has a fix.

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
**nothing calls them** — the live blocker is archive#917 (the FCM/APNs dependency
decision). The dormant call site is commented in
`src-ui/src/contexts/ApiBaseContext.tsx` so switching it on is a visible,
small change rather than an archaeology exercise.

(Historical: archive#3088 corrected this record after a backlog sweep closed the
original tracking issue with no code change. archive#3088 is itself now closed, so
it must not be cited here as live tracking — that would repeat the very
defect it was filed for.)

## Where this leaves delivery

| App state | Covered |
|---|---|
| Foreground | yes |
| Backgrounded, process alive | **no** — frozen, and the service that would prevent it is blocked upstream |
| Force-quit / swiped away | **no** |
| Device rebooted, app never opened | **no** |

Everything below the first row needs FCM on Android and APNs on iOS (archive#917).
The native capability report therefore returns `remote-push: unsupported`
instead of allowing the presence of the local-notification plugin or dormant
watch to be mistaken for wake-capable delivery. archive#1225 remains open until archive#917
selects and provisions both the mobile applications and server send
credentials; repository code cannot manufacture those provider identities.

That is not a consolation prize. Push is the mechanism that does not require
keeping a process alive at all — the system unfreezes the app to deliver — so it
sidesteps the freezer, both Tauri bugs, and the battery cost of polling
together. Keeping a process alive to poll is fighting the platform; push is the
platform's answer. The cost is real and is a product decision, not a technical
one: every notification leaves the machine and transits Google or Apple, which
matters for a self-hosted product.

The seam is ready for it: `notification_watch_start` takes a URL and a
credential and owns delivery from then on, so a push relay slots in behind the
same call without the web layer changing.

**iOS** has no foreground-service equivalent either, and is foreground-only
until push is decided.

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
