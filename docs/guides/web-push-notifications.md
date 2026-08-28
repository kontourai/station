# Web Push notifications

Station can send a Web Push (VAPID) notification to a paired device when an
approval-request notification is delivered and no client is actively
watching. This is what makes device pairing (`docs/guides/...` pairing UX,
see `PairedDevice`/`DevicePairingService`) pay off when the tab is closed: a
paired phone gets a push, and tapping it lands on the attention inbox
(`/notifications`).

## How it fits together

- **Keys**: a VAPID keypair is generated once and persisted at
  `<STATION_HOME>/security/vapid-keys.json` (0600, atomic write — same pattern as
  `paired-devices.json`). `VapidKeyService` (`src-server/services/notifications/vapid-key-service.ts`)
  owns this.
- **Subscription storage**: a Web Push subscription lives *on* the paired
  device's own record (`StoredDevice.pushSubscription`, private — never in
  `publicDevice()`/`PairedDevice`). It is set via
  `POST /api/system/push-subscribe` and cleared via
  `POST /api/system/push-unsubscribe`, and it is explicitly nulled the moment
  the device is revoked (`DevicePairingService.revokeDevice`) — a
  subscription never outlives its device record.
- **Auth boundary**: both push routes resolve the caller's credential to a
  paired device via `identifyDevice` (`EnvironmentSecurityService` ->
  `DevicePairingService`). Verifying the *operator* credential — or being on
  loopback — is deliberately not enough; an unidentified caller that reaches
  the route gets `403 {error: 'device_pairing_required'}`. This is the
  structural guarantee behind "no pushes to unpaired browsers."

  A caller can also be refused one layer earlier, and since archive#1123
  slice 3 (archive#1189) a revoked device is refused there: the runtime auth gate
  verifies any *presented, well-formed* credential regardless of peer class,
  so a revoked credential fails it and gets
  `401 {error: {code: 'authentication_required'}}` without ever reaching the
  route. The guarantee is unaffected — denial is earlier, not weaker.

  That 401 is not revoked-specific. The gate returns the same body whether a
  credential was presented and rejected or never presented at all; only the
  audit record separates them (`reason: 'invalid_credential'` vs
  `'authentication_required'`). Clients treat both statuses as "pair this
  device again" because on this surface every reachable cause needs that same
  recovery — a revoked credential cannot be re-authenticated, and a caller
  with no credential was never paired. Whether the gate should distinguish
  the two on the wire is open in archive#1212.
- **Sender**: `wireWebPushDelivery` (`src-server/services/notifications/web-push-delivery.ts`)
  is a decoupled `EventBus` subscriber on `NOTIFICATION_DELIVERED`, filtered
  to any category the attention-ranked outcome model classifies
  (`classifyNotificationCategory`, `@kontourai/station-shared/notification-priority`)
  — today that's `approval-request` (outcome `needs-input`) and `job-failure`
  (outcome `failed`; archive#1100). It fans out over every paired device's
  subscription, self-heals a 404/410 ("this subscription is gone") by
  clearing it, and catches everything — a push failure can never affect the
  in-app SSE/toast delivery path. `needs_input`/`review_pending` are polled
  projections with no discrete delivery event, so they are **not** pushed
  (deferred to a follow-up).
- **Payload composition (archive#1100)**: `composeWebPushPayload`
  (`src-server/services/notifications/push-payload-composer.ts`) builds the
  title/body/deep-link/TTL:
  - **Ranking (AC1)**: when composing from more than one pending notification,
    the highest-outcome-priority one leads (approval/input > failed > running
    > done, `NOTIFICATION_OUTCOME_PRIORITY`), ties broken by
    most-recently-updated. The live delivery path always composes from a
    single notification (the one that just fired) — ranking across
    everything else currently pending is deliberately not wired in (it risks
    replacing a fresh event's own push with a stale re-announcement of an
    older, higher-tier notification still sitting unresolved); the composer
    is proven correct for a real multi-item batch via unit tests and is
    ready for a future digest surface.
  - **Per-state TTL (AC2)**: the Web Push protocol TTL header (RFC 8030,
    `WebPushService.send`'s `ttlSeconds`) is sized per outcome —
    `needs-input`/`failed` ~24h (a user may legitimately ignore an approval
    or a failure notice overnight), `running` ~2h, `done` ~15min
    (`NOTIFICATION_TTL_MS`). The same TTL also defaults the *stored*
    `Notification.ttl` for a classifiable category
    (`NotificationService.schedule`), so an unresolved approval or job
    failure eventually expires out of the in-app inbox too, not just out of
    the push service's queue.
  - **Deep link (AC3)**: resolves the exact session
    (`resolveNotificationOpenHref`, shared with
    `AttentionProjectionService`'s approval projection) from the
    notification's `sessionId`/`sessionKind`/`projectSlug` metadata,
    falling back to the generic attention inbox (`/notifications`, the
    fallback the manual checklist below still exercises) when metadata
    doesn't carry enough to resolve one.
  - **All-quiet framing**: `outcomeFirstAllQuietHeadline` produces an
    outcome-first headline ("Agent work completed" / "Agent work failed"),
    never a bare zero count like "0 active agents". No summary/badge surface
    in the product reads it yet — it exists as a tested, reusable composer,
    disclosed rather than silently wired into a surface that doesn't exist.
- **Client**: `usePushNotifications` (`src-ui/src/hooks/usePushNotifications.ts`)
  registers `public/sw.js`, requests permission, subscribes, and POSTs the
  subscription. A `403 device_pairing_required` response — or the
  `401 authentication_required` a revoked device now gets from the auth gate —
  surfaces as a distinct "Pair this device first" state (`pairingRequired`),
  not a generic error.
  `sw.js`'s `notificationclick` focuses an existing tab (navigating it to the
  push's deep link) or opens a new one, defaulting to `/notifications`.
- **Metrics**: `station.web_push.subscriptions` (subscribe/unsubscribe by
  outcome) and `station.web_push.sends` (sent/gone/error) in
  `src-server/telemetry/metrics.ts`.

## Manual phone checklist

Web Push requires a real browser, a real push service, and a real paired
device — none of which the automated suite can exercise end to end. Run this
manually on a release build (or a dev server reachable over the tailnet) with
a real phone before shipping a change that touches this surface.

1. **Pair a phone over the tailnet.** From Settings → Notifications, enable
   "Push notifications." Pair the phone as a device the same way as any other
   mobile pairing flow (see `docs/guides/connections.md` / the mobile pairing
   panel), so it authenticates with its own device credential rather than the
   operator credential.
2. **Subscribe.** On the phone, tap "Enable push notifications" and grant the
   browser's notification permission. Confirm the UI flips to "✓ Subscribed
   to push notifications."
3. **Close the tab entirely** (not just background it) on the phone.
4. **Trigger a real approval request** from another device/session (a tool
   call that needs approval, or any other `approval-request` notification).
5. **Confirm the push arrives** on the phone as a system notification, even
   though the tab is closed.
6. **Tap the notification.** Confirm it opens (or focuses) Station and lands
   on the exact session the approval belongs to when the notification's
   metadata resolves one (archive#1100 AC3), or the attention inbox
   (`/notifications`) otherwise — never a blank tab or the root route.
7. **Revoke the device** from the host's paired-devices list (Settings →
   Notifications → Mobile Pairing, or the pairing management panel).
8. **Trigger another approval request.** Confirm **no further push arrives**
   on the revoked phone — the subscription died with the device record.
9. **Blocked-platform degradation.** On a platform/browser where Web Push is
   blocked or unsupported (e.g. notification permission denied, or a browser
   without the Push API), confirm the in-app experience is unchanged: the
   existing SSE/toast notification still appears while the tab is open, the
   "Enable push notifications" button reads "Notifications blocked by
   browser" (permission denied) or the section doesn't render the subscribe
   control at all (unsupported), and no error breaks the rest of Settings.

Record the result (pass/fail per step, and which platform/browser was used)
in the delivery evidence for any change to this surface, the same way
`docs/guides/desktop-tray.md`'s manual tray checklist is recorded for the
desktop tray.
