# Connections Guide

Connections power Station's chats and agents. A **Model connection** is a hosted service or
local model server that Station's engine runs inference on; an **Engine** is an agent app such
as Codex or Claude Code that runs its own loop. They appear under **Connections** on the
**Models** and **Engines** tabs, each with one clear readiness label and one next action.

For the precise vocabulary used below, see [docs/glossary.md](../glossary.md).

---

See the [application walkthrough](../learn/walkthroughs.md#connections) for a captured example and its evidence limits.

## S3 source profiles

Experimental Project S3 sources use an explicitly selected named AWS profile on
the Station host. They remain default-off pending real AWS acceptance and are
configured in Project **Sources**, separately from model connections and personal
connected-tool accounts. Sharing a prefix explicitly lets current Project readers
use that host profile for bounded reads; it does not copy its credentials to
members or choose a person's account by fallback. See [the S3 source guide](knowledge.md#experimental-read-only-s3-prefixes).

## Read the connection list

Each row shows one readiness state and a next action. Model connections distinguish
saved settings from a check that actually reached the provider:

- **Ready** — the current readiness evidence permits selection; it does not prove every model or tool capability.
- **Sign in required**, **API key required**, or **Credentials required** — complete the named authentication step.
- **Saved — not verified** — settings exist, but no qualifying provider check or chat result is recorded.
- **Check failed** — the provider refused the last applicable check; fix the settings and test again.
- **Reachable — no model catalog** — the endpoint answered, but its model list did not establish a usable selection.
- **Unreachable — retrying** or **Cannot reach provider** — the latest reachability check failed; the former retains a recent pass within the retry grace period.
- **Found, not connected** — Station observed a service-specific setup signal; connect it to Station.
- **Setup required** — finish the remaining setup.
- **Limited** — usable with reduced capabilities; review the details.
- **Disabled** — configured but turned off.
- **Unreachable** — configured, but Station cannot reach it.

Select the action on the row. Station keeps transport, process, and connection-kind details
out of the overview; they remain available only where setup or diagnosis needs them.

When adding a Model connection, **Create** saves it and immediately checks the
provider. OpenAI's service requires an API key. For a custom endpoint, follow
that server's authentication requirements; some permit anonymous access or
host-managed credentials. Blank fields alone do not establish readiness. A
refused check retains its reason so you can correct the settings and retry.

**Test Connection** first requests the model catalog. If no usable catalog is
available, it can send one minimal chat request using the connection's default
model; that request may be billable. A successful catalog check alone does not
prove chat, tool calling, images, or other model features. See the
[readiness projection](../../src-ui/src/views/provider-settings/providerCatalog.tsx)
and [connection form](../../src-ui/src/views/provider-settings/ProviderConnectionForm.tsx).

---

## Sign an engine profile in from a device

Open **Connections → Engines → Codex** or **Claude**. The account picker shows
saved accounts and marks the account currently in use. Picking an account changes
what you view; it does not change the account used by runs. Existing account
application controls remain under **Advanced**.

Choose **Add account**, name it, and select **Sign in**. Codex displays a code:
open the OpenAI page, enter the code, and approve access. Claude opens its
subscription sign-in page: finish there, paste the returned code into Station,
and select **Finish sign-in**. Station reports completion only after the engine
confirms authentication. **Cancel** stops a pending login. Returning to the
account resumes status checks. Login capabilities come from the installed CLI;
unsupported or unreadable installations remain unavailable.

Relayed login applies to saved credential profiles. The default account follows
the connection's configured home and environment and is managed by the host CLI;
Station does not replace it through this page. A paired device needs **Start
engine sign-in** (`engine:login`), granted under **Change access**. That grant
permits existing profile names and login status, not account creation, manual
commands or token-backed allowance reads. These require credential-management
access. Refused starts retain their reason; after a transport failure, check
status before starting again because the server may still be running the login.

**Allowance** shows the selected account's provider-reported limits and reset
times. Failed or unrecognized readings say unavailable, never zero. **Refresh**
requests a new reading. While the account page is visible, it refreshes every minute; it does not poll in the background. Claude credentials
are read from the selected macOS Keychain namespace first, with a credential
file fallback when that namespace has no usable entry. A stale legacy file does
not override the current secure-store login. Tokens remain on the server.

Codex window labels use the provider's reported duration. A primary window is
not necessarily five hours; absent durations are labeled primary or secondary.
Reset countdowns tick locally, with the absolute reset time beside them.
Passing a reset time does not clear the captured quota; refresh for a new reading. Individual reserve/model windows retain their own availability verdict.

**Account & credits** expands account identity, credit balances, approximate
local/cloud message ranges, reset credits and model availability when Codex
returns them. Claude extra usage shows enabled/user-disabled state, prior credit
enablement, utilization, currency/decimal metadata and amounts
in provider units; Station does not assume those amounts are dollars.
Claude provider spending uses explicit minor-unit/currency/exponent data for
formatted amounts and exposes provider severity and credit/settings capability
flags. **Weekly usage breakdown** and **Provider limit details** retain the
provider's dated breakdown and active/group/model/surface annotations.
Unavailable fields remain **Not reported**. An unavailable quota percentage does
not discard readable account/credit details.

**Data captured** shows the reading's source, credential storage kind, storage policy, unmapped non-null
field paths and deliberate exclusions. Only field names leave the server for
unmapped values. This bounded shape audit excludes null/empty fields, value
validation, credential stores and other endpoints; “none in this response” does
not establish complete provider coverage. The full quota response remains a live projection. **Allowance history** retains
only window labels, percentages, durations, reset times and observation timestamps.
It saves a 30-day window of the latest observation per UTC hour, at most 720 observations
and 32 windows per observation, under this Station's `analytics/engine-allowance/`.
The window is pruned on capture; closed or deleted profiles are not automatically
purged. Each profile file is bounded, while the number of files follows the
profiles/config homes observed. Identity values, credits, spending, raw responses and credentials are not stored
in that history. History is partitioned by engine, connection, profile and config
home. A changed reported account identity clears that profile's history; when a
provider does not report identity, observations describe the credential profile
and cannot detect an external sign-in to a different account in the same home.
Unknown readings remain gaps. No history is backfilled or captured while the
page is closed. A failed history write leaves live limits readable and shows
that history is unavailable. **View observations** exposes timestamps and resets,
with older rows loaded on request. History keeps a reused window ID separate
when its label or duration changes, so different allowance periods are not blended. Usage receipts are persisted separately.

The current projection inventory is:

| Source fields | Capture and display | Storage / limits |
| --- | --- | --- |
| Codex `email`, `account_id`, `user_id`, `plan_type` | Account identity and plan | Live, credential-management access |
| Codex rate limits, additional limits, code-review limits, chat-pass windows | Percentage, duration, absolute/relative reset, availability; additional model/feature identity | Live plus bounded hourly allowance history; null windows omitted, unknown durations not guessed |
| Codex `credits` | Availability, unlimited flag, balance, overage verdict and message ranges | Live; credit units are not currency |
| Codex `model_usage` | Model availability, availability time, whether credits enable it | Live; at most 32 models projected |
| Codex `rate_limit_reset_credits` | Available and applicable counts | Live |
| Codex `spend_control.reached` | Account exhaustion verdict | Live; individual spend-limit policy, promo and limit-reached type deliberately excluded |
| Claude `five_hour`, `seven_day`, model/OAuth/Cowork weekly windows and scoped `limits` | Percentage, reset and provider exhaustion verdict | Live plus bounded hourly allowance history; not all accounts return each window |
| Claude `extra_usage` | Enabled/user-disabled state, prior credit enablement, used amount, monthly limit, utilization, spend-limit verdict and declared units | Live; raw amounts stay in provider units |
| Claude `spend` | Declared-currency amounts, severity, enabled state, capability flags and provider disclaimer | Live; explicit minor units/exponent required for currency formatting; no purchase or setting mutation |
| Claude `limits`, `seven_day_breakdown`, `member_dashboard_available` | Active/group/model/surface annotations, dated weekly percentage breakdown and dashboard availability | Live; detail/breakdown arrays capped at 32; shape audit marks truncation |
| Station usage rollup | Input/output/cache tokens, receipts, reported/estimated costs, pricing sources/snapshots, coverage/freshness/observed turns | Persisted receipts; selected profile or all engine accounts on this Station, not provider-wide billing |
| Non-null unrecognized response leaves | Unmapped paths, never their values | No raw-response storage; audit capped at depth 8, 2048 visited nodes, 256 leaves, 64 keys/object and 32 items/array |

On 2026-10-01 a read-only Codex account probe confirmed the weekly-primary,
reserve, model availability, credit, chat-pass and reset-credit response shapes.
The legacy Claude credential file returned 401, while its selected macOS
secure-store credential returned 200. After correcting credential-source
precedence, both readers reported no unmapped non-null field paths or audit
truncation for those account responses. Claude spending, breakdown, active-limit
and extra-usage shapes are live-observed as well as fixture-validated. Other plans and provider endpoints remain outside this observation.

**Activity** initially shows 7 or 30 days of all engine runs on this Station, so
older activity remains visible. **Activity for** switches
between the selected credential profile and all accounts of this engine. New
Claude and Codex sessions record an opaque account key from the profile actually
resolved for the process. Raw profile references are not published in runtime
events. Source-home continuations and older events without this observation
remain unattributed. A process restart does not inherit a previous process's
account observation. Account filtering excludes unattributed receipts; it never
assigns old costs to today's active account. Capture counts still describe the
engine, and account results disclose this attribution gap.

Reported costs and estimates remain separate. **Tokens**, **Reported cost** and
**Estimated cost** select the daily chart measure. A cost measure with no values
shows unavailable observations, never a token chart labeled as cost. Mixed
currencies retain separate totals and a currency selector; Station does not
convert or combine them. Missing days keep their place and are marked unreported.
**Token breakdown & capture coverage** expands cache/input/output totals, pricing
provenance and observed-versus-usage-reported turn counts. Missing values are not
added as known zeros; reported subtotals can be incomplete. Subscription allowance
and engine-reported costs are not billing statements. Activity requires
credential-management access, even for this Station alone.

The component/transport tests exercise both account pages and the login relay
with controlled provider responses. An isolated Claude CLI probe confirmed the
browser-code prompt on macOS; these checks do not prove a completed live OAuth
exchange, every provider plan or Windows secure-store behavior.

## Invite a device to a relay Station

Under **Connections → Computers**, the **Devices** list and its **Invite device**
action appear when the selected
Station has a configured connector and the caller can manage relay access. A
Station operator can explicitly promote a paired Device with **Manage remote
access** (`relay:manage`). This permission is absent from presets and default
grants. It permits only the closed relay-management and Project access
management routes; Project membership and its `manage-members` action remain
independent requirements. It grants no Agent, terminal, or Task publication
(share/unshare) authority.

**Invite device** opens three steps:

1. **Send the app link.** Choose the recipient app and copy its setup link. The
   link supplies routing intent; it does not approve a Device or a Station
   signing key.
2. **Approve their phone.** The recipient opens the link and returns their setup
   info. Paste it (surrounding message text is ignored); setup info for another
   Station is refused before any write. **Approve and invite** approves that
   exact installation and then creates its invitation. If the invitation's
   outcome is uncertain, the action stays disabled instead of retrying; check
   with the recipient before starting again.
   This protection survives **Change** and closing/reopening the dialog only
   within the current Devices panel and Station/account authority. Navigation,
   reload, or an authority remount resets it. There is no durable invitation
   deduplication or broker-status reconciliation; manually check with the
   recipient before creating another invitation. Only choose **Allow another**
   after that check.
3. **Send the invitation.** Copy the invitation link and share the Station code
   and key ID by a separate call or message so the recipient can confirm the
   Station. Invitations are single-use. The default lifetime is 24 hours; choices are
   5 minutes, 15 minutes, 1 hour, 24 hours, or **Never expires**. A non-expiring
   invitation still permits only one redemption.

After the three-step dialog, review the pending account-bound Device request
in **Devices** and approve or decline it. Project access is a separate
invitation and membership decision. Removing an installation approval is also
a separate action and requires confirmation.

Native registration and Project invitation acceptance accept a full Project
invitation link or its code. They extract the token without switching the
selected Station; the selected Station still validates it. Details about the
separate approvals are available through the information controls.

The desktop and native views use the same selected-Station authority. Native
Project access controls require the Project's `manage-members` action, and
writes are disabled without a current management or operate scope. The server
rechecks Device authority, the actual human actor and account-provider
currentness, plus the exact target approval before committing a decision.
Connector issuer credentials stay in the runtime; these controls expose no
issuer secret. See [the broker operator path](self-hosted-broker.md#station-invitation-controls)
and [native verification limits](native-shell-verification.md#relay-management-source-integration).

This is source integration with diagnostic checks, not a released Nightly or
physical-device delivery receipt. For account-bound Devices, the gate admits only
the exact native relay-management leaves with current Device proof and account
binding/session. Management separately requires explicit `relay:manage`; a
credential-only account-bound Device remains refused. The capabilities read
returns `canManage: false` without management authority and grants nothing.
Project access administration still requires Project IAM. See the
[exact admission inventory](deployment-authentication.md#native-relay-management-admission).

## Saved Station addresses

Choose **Manage Stations**, then **Connect a Station**. Enter its address, a pairing code,
or scan a QR code. Station checks compatibility and displays the destination's
reported identity. That public response is not a signing-key trust decision.
In a browser, the destination must permit the current page's exact origin
through its existing `--allowed-origin` startup setting. HTTPS pages may also
block an HTTP destination. If identification fails, no access request has been
submitted. Use the native app or open the destination directly for Device
pairing when the browser cannot read its response. The current receiver also
checks browser pairing-request provenance separately: Chromium requests from
another page origin are refused even when discovery is allowed. That refusal
does not create a pending request. Use the native app to request Device access,
or open the receiver's own page; peer setup still belongs to the sending
Station's trusted session.

Choose either or both access requests:

- **Use the destination from this device** saves this device's approved access.
- **Let the current Station send work to the destination** requests a separate,
  server-held delegation grant.

Each request needs its own receiver approval. Peer enrollment also requires an
operator-authorized session on the controlling Station; ordinary paired-device
access cannot manage peer credentials. If that authority is unavailable, the
dialog explains the limitation instead of asking for an operator key. Existing
trusted approval surfaces remain the remedy; this flow does not implement
remote operator elevation.

Device access saves without replacing an existing selected Station. From a
Project's Delegate dialog, setup preserves the draft and resource selection and
returns there without submitting work. Peer approval and completion do not grant
Project execution: the receiver must offer the exact resource, and its Agent
must be available. Foreground peer threads remain unsupported in the Project
default picker.

Once the sending Station confirms a peer request, **Check approval** completes
that existing enrollment. Before confirmation, **Retry this same request** keeps
its retained identity and destination. Each state offers cancellation separately;
retry does not create a replacement automatically. If an exchange outcome is unknown, inspect or
revoke the receiver's grant before starting again. Cancelling a local pending
request does not revoke an already approved receiver grant. A saved peer
credential establishes permission, not observed reachability or Project readiness.

Tap the connection dot on a phone, or the connection name on desktop, to
choose a Station. A checkmark identifies the current Station, whose status is
live. The chooser does not probe inactive Stations; they say **Not checked**
unless a saved access or connection error needs attention. Holding the phone's
dot shows its saved name without switching or opening the chooser.

Choose **Manage Stations** to inspect saved connections. Tap a row to reveal
**Switch to this Station** and **Edit Station**; inspecting a row does not
switch the active connection. Switching respects unsaved-work decisions.
Each address wraps on narrow screens so its port stays visible. The row's
**More actions** menu provides **Copy address** and **Check reachability**.
Expand the row's details to select its address text, or use **Copy address**
to copy the full address directly.
For the current saved Station, **Reconnect** opens its access-request flow
even when this device is already paired, so you can request fresh approval.
It is not offered for an inactive Station or a connection managed by the
native host. Completing reauthorization still requires Station approval.
The manager uses the current Station's live status; inactive rows show
**Not checked** until checked there. Connections with valid saved access do
not prompt for another access request. A rejected or missing credential still
offers the appropriate access remedy.

Use an HTTPS address when connecting another device. An HTTP address requires
**Allow an unencrypted connection** before requesting access, including a
`localhost` address in a native app. The exception is numeric loopback
(`127.0.0.1` or `[::1]`), or the browser session on the Station that served its
page. The choice applies only to that exact origin on this device; approval
and pairing are still required.

Native clients save edits through the shared profile store. A name change
preserves pairing and updates references to that profile, including its default
and project selections. Changing the address requires connecting the device
again: the previous credential is never sent to the new origin. Concurrent
changes to the same name or address are rejected for review rather than
overwritten. The app-managed local Station is not editable through this form.

Clients without the profile owner's editing capability keep shared profiles
read-only; they can still display and copy the complete address. Ordinary
browser-local saved Stations retain their existing edit and endpoint-verification
flow.

On native clients, **Add computer → Save an encrypted broker route** records
public Station and broker addresses and the exact Station enrollment. Saving
this record does not connect, sign in, pair a Device or grant Project access.
**Your Stations** exposes separate Station signing-key approval, routing
grant redemption and Device setup. The host keeps routing and Device
credentials in OS custody, outside the saved public record.

On a native client with no saved Station, open the Station manager from Home
and choose **Set up a broker route** in the list footer. This opens the same
saved-route setup used by **Add computer**; the address, QR and pairing-code
actions remain available in the manager.

On iOS, a public setup link opens **Connect to a Station**. Give the Station a
name with **Save this Station → Save Station**. The address comes from the link
and is not yet verified; inspect it under **Connection details**. Saving does
not connect, sign in, approve a Device, or grant Project access.

Choose **Share device details**, then **Copy device details**, and send them to
the Station owner for approval. These are public installation details, not a
password or private key. This action is available even when the Station is
already confirmed. It does not rotate trust or issue an invitation.

The owner’s later bound invitation requires that exact saved Station and its
matching device details. The host retains the secret; the UI receives public
metadata and an opaque handle. Choose **Check this Station**. Compare the code
and full key ID with the owner through a separate trusted channel, enter both,
and explicitly **Confirm Station**. Both values and the separate-channel check
remain required. Setup shows the current step first; connection controls appear
after confirmation. The form asks for **Owner’s code** and **Owner’s key ID**.
The received values, route identifiers and deadline are collapsed under
**Station identity details**. An expired check asks for a new invitation.
After confirmation, inspection and removal are under **Confirmation details**.
Info icons explain Station confirmation and device approval on demand. Hover
or focus gives the icon’s label; tap or click opens the explanation. Escape
closes help before the surrounding setup dialog. Setup uses the shared theme
for controls and statuses; the setup-link expiry remains visible.


**Continue to device approval** is a separate action. A confirmed routing grant
opens Device setup. The consumed invitation’s expiry no longer closes that
setup; grant and Device deadlines remain unchanged. Account sign-in and
Project membership are still separate. Opening or cancelling a link does not
select a Station or retire an existing account session. Cold intake precedes
the operator and member roots; warm intake covers their mounted owners.
If a connection is already saved, the next invitation stops before redemption
and offers a review of those saved connections. Removing them requires an
explicit confirmation; the new invitation is not consumed during review.

Station confirmation and connection changes made in the invitation dialog
refresh **Your Stations** automatically. The card rechecks native host state
after setup operations settle, including an uncertain or late reply. Closing
the dialog preserves the mounted application and its selected Station and
account session. A refreshed card does not select a Station, approve a Device
or grant account or Project access.

The saved Station card shows that the connection invitation is stored on this
device. Its collapsed expiry details describe the local credential; they do not
show whether the Station is online or the connection will work.

These links use separate iOS schemes for each installed channel. Android
secret-link intake is unsupported. The d956 development simulator observed
nonsecret public cold and warm intake, cancellation, unchanged saved profiles
and confirmation, and error-free empty grant status. Bound secret delivery,
actual grant storage writes/deletes, account/application traffic, store
releases and physical acceptance remain unverified. The UI owners are the
[root intake](../../src-ui/src/platform/native/NativeRelayLinkIntake.tsx) (with its iOS-only [controller](../../src-ui/src/platform/native/NativeRelayLinkIntakeController.tsx)) and
[opaque native adapter](../../src-ui/src/platform/native/nativeRelayLinkAdapter.ts).

**Approve this device** verifies a supported account, presents the exact Device
candidate for operator approval, then requires explicit activation. Reopening
setup recovers an existing attempt from the host journal; an uncertain
activation is checked before the UI reports **Device configured**. That label
establishes Device configuration only, not an account session or membership.
See [native enrollment](../design/native-relay-enrollment.md) for the separate
Station, routing, Device and account owners and current qualification limits.

If a Device request expires, close the expired request before starting another.
A newer connection can close an old expired candidate when it still points to
the same Station and installation with unchanged trust. It does not restart
account submission or renew the old Device request. Staged delivery or an
uncertain activation needs its own status recovery; keep that setup open.


Configured routes are not selected automatically. A configured row says
**Not in use** until you choose **Use this Station**. A selected configured row
distinguishes **In use · sign in needed** from **In use** using the current native account scope; neither
status says the workspace is connected. Sign in with the Station account only
after selecting its route. Account sign-in does not approve a Device or create
Project membership.

Before account sign-in, the native member shell shows Station setup on the
page. After sign-in, shared Projects come first and **Stations** opens the
connection controls in a dialog. An empty Project list offers **Use a Project
invitation** through that same dialog. Technical setup and the outbound
delegation command stay behind **Advanced** disclosures; they do not supply
additional authority.

The selected route's **Accept account invitation** action requires that account
session. Station returns a typed Project membership receipt with the exact
Project scope and `grantsDeviceAccess: false`; the UI invalidates the Station
Project-list cache. Device approval remains separate. **Sign out of this
Station account** asks Station to revoke the account session and reports
revocation only after the host validates Station's typed confirmation. If the
response is lost or invalid, the UI reports the remote outcome as unconfirmed.
**Forget account session on this device** only clears the host-held local
continuation; it does not revoke the remote Station session. Either action
also hands this device back its own appearance (mode and color theme) in
place of the signed-out account's
([color themes decision](../decisions/user-color-themes.md)).

The ordinary native transport obtains fresh ICE and verifies Station proof for
each encrypted application peer. Its current resource surface is health,
authority and member Project reads; operator Workspace features and writes
remain unsupported. The member Project view is available only when Station
returns its member-safe Project shape. It lists published shared work; opening
an item reads its current publication, bounded human-message history and
published document through the member-read SDK. History and document content
stay hidden while publication is being rechecked, after it is unshared, or when
the current request scope is unavailable. The member detail view does not load
operator layouts, Git status, knowledge, or workspace panes; an operator
Project response does not mount those Project detail panels. Member Project
icons follow the same icon rule as every other surface: one that points to a
URL or a path is omitted, so the native relay view does not issue raw image
requests outside the broker, while an uploaded image icon is inline data and
is shown.

The UI owners are [saved relay routes](../../src-ui/src/views/connections-hub/RelayRouteProfiles.tsx),
[Project detail](../../src-ui/src/views/ProjectPage.tsx), and the
[member Project view](../../src-ui/src/views/project-page/MemberProjectPage.tsx).
Its captured-scope list and detail reads live in
[ProjectsContext](../../src-ui/src/contexts/ProjectsContext.tsx) and use the
[shared-task SDK readers](../../packages/sdk/src/client/project-shared-tasks.ts).

No direct HTTP fallback is used. The CLI continues to refuse these routes as
defaults or explicit `--station`/`STATION_TARGET` targets. Focused source and
mounted UI checks do not establish installed Nightly or physical iOS
acceptance. The mounted journey checks live in the
[relay-route tests](../../src-ui/src/views/connections-hub/__tests__/RelayRouteProfiles.test.tsx)
and [Project/member view tests](../../src-ui/src/__tests__/ProjectPage.test.tsx)
and [member reader tests](../../src-ui/src/views/project-page/__tests__/MemberProjectPage.test.tsx).

Already redeemed native routing grants have a separate foreground maintenance
path. While the native renderer is visible, it observes every saved broker
route and renews an existing unambiguous grant when at most 12 hours remain.
It rechecks host status before renewal and after wake/online events, with
bounded retries. More than 64 saved routes pauses maintenance for all routes
and displays a limit notice. Saving a route or approving a Station key does
not redeem a grant. This maintenance does not select an application route,
sign in, pair a Device, or grant Project access. Mobile shells now mount this
same supervisor; actual iOS background/foreground qualification remains
separate from the mounted frontend checks.
The [host renewal and supervisor](self-hosted-broker.md#native-routing-grant-foundation-v2)
keep credentials and durable retry identity out of the renderer.

Before redeeming a linked invitation, Station checks saved grants for the same
route and installation. If even one belongs to an earlier routing generation,
it keeps the invitation unconsumed and asks you to review the old connection.
The same review is available for multiple saved grants or pending cleanup.
**Review saved connections** opens a preview. **Remove saved connections**
confirms the cleanup. Technical routing details appear only when expanded. The host first
tries to retire each broker grant and clears eligible local records only after
cleanup is established. This does not change Station
trust, Device approval, account sign-in or shared Project access. For an older
routing generation only, the host can use the still-unconsumed invitation to
establish that the old scope is no longer admitted. If observation or local
storage fails, cleanup remains pending and the invitation stays available.
After cleanup, continue to device approval; account sign-in and shared Projects
are separate steps. If device setup still finds multiple connections, it asks
for a new owner-issued setup invitation; use that invitation’s review and
confirmation before retrying the saved setup check. Diagnostic details report
`native_enrollment_saved_connections_ambiguous` without raw host errors. A
same-generation saved connection does not trigger older-generation cleanup.
Operational status continues to refuse multiple grants until cleanup resolves;
it never chooses one silently. This native journey still needs installed-shell
qualification, as described in
[native shell verification](native-shell-verification.md#qualify-native-relay-link-intake).

Once **Request device access** opens the account form, submit it within the
five-minute Device request. If the request expires, choose **Close expired
request**. Station verifies and closes the saved attempt before offering a new
**Request device access** action. Closing the dialog alone does not remove a
saved Device setup.

For a native signing-key approval, select the saved broker route and choose
**Share device details**. Station creates or reopens this install's
proof key in the OS keyring and shows only its public key, thumbprint, client
instance, app/channel, and selected route. Choose **Copy device details** and
send this public installation proof to the Station owner. On the owner's machine, with the self-hosted connector
configured and online, save that JSON to a private file and run:

```sh
npm run connector:invite -- /absolute/station-home /absolute/private-connector-config.json /absolute/prepare.json /absolute/private-directory/new-invitation.json
```

Invitations default to 24 hours. Add `--expires-in 5m`, `15m`, `1h`,
`24h`, or `never` to choose another expiry. Each invitation remains single-use
and bound to the receiving installation. Routing withdrawal or rotation
invalidates an invitation even when it has no time expiry.


The command uses the Station-owned broker credential internally and writes one
surface-bound native invitation to a new 0600 file in a private directory. It
does not print the invitation secret. Send the file's contents to the intended
client through a private channel; the invitation alone grants no Station,
account, Device, or Project authority. The client expands
**Advanced: paste a setup invitation** and pastes it into the saved
route's **One-time Station invitation** field, then chooses **Check this Station** and independently compares the
candidate's 16-character code and full key ID with the operator using a
separate channel. The operator can read those values with
`npm run --silent connection:key -- fingerprint --home=<absolute-home-path>`.
Only after entering both independently obtained values and confirming that
separate comparison does **Confirm Station** store public trust on the
client. Under **Confirmation details**, **Revoke Station key trust** requires the current full key ID and a
successful keyring write; an error leaves revocation unresolved. Approval and
revocation do not start a native broker route or sign the client in.
When a Station rotates its signing key, expand **Confirmation details** and
choose **Review new Station key** to open a new
invitation and comparison without discarding the currently approved key. The
replacement must advance the generation and use a different key; cancelling
the review keeps the existing approval. A revoked key likewise needs a newer
generation and different key before trust can be restored.

In the browser, open **Connections → Computers → Broker routes → Advanced:
broker setup** to start the **Station signing key** step. This disclosure stays
closed for ordinary direct-address and pairing use; saved route actions remain
outside it. A fresh browser with no Device cookie can reach the same
setup from **Connect to a Station → Use a broker invitation**. The operator can run
`npm run --silent connection:key -- inspect --home=<absolute-home-path>` and
send its public JSON report through a separate trusted channel. Compare the
complete SHA-256 JWK thumbprint shown by the browser with the operator before
checking the approval box. A broker invitation, its URL, or its contents cannot
approve this key. The browser records only public trust metadata in its
origin-local trust store. Rotation requires a higher key generation for the
same enrollment; revoked trust stays revoked until a higher-generation key is
independently approved. A different enrollment cannot be reset from this form.

For a shorter independent comparison, the Station operator can also run
`npm run --silent connection:key -- fingerprint --home=<absolute-home-path>`.
It prints the full key ID and an 80-bit, 16-character confirmation code derived
from the Station ID, enrollment, key generation, and public key. Compare both
values through a separate channel. The browser's Station signing-key form now
shows the code alongside the full key ID from the public report; compare both
with the operator before approving. The broker has a bounded pre-grant courier
for a Station-signed, short-lived candidate bound to the selected broker and
one client challenge. The signature proves possession of the included key;
it does not approve the Station. The native verifier checks the signature,
challenge, route, client key, key ID, and confirmation code; the explicit
native approval ceremony stores public trust in the OS keyring but does not
itself select or connect a native relay route. The recipient must compare the code and full key ID through a
separate channel and explicitly record trust in its own trust owner. Courier
delivery does not consume the invitation, enroll a Device, or grant account,
Project, or compute permissions.

After that separate approval, the browser can accept a one-time invitation
link or the operator's private JSON invitation. Enter the Station application
origin separately. For a route that must cross networks, enter the operator's
**TURN server URL**, **TURN username**, and **TURN credential** with the
invitation. The fields are optional for same-network host-candidate testing;
when supplied, all three are required and the browser uses relay-only ICE. The
versioned credentials live in a separate origin-local IndexedDB record bound to
the exact broker, Station enrollment and generation, application origin, and
browser origin. They do not enter the saved Station entry, invitation, broker
grant, account or Device authority. **Forget route** removes that record.
After a route is saved, its **Configure TURN** action can add, replace or clear
these settings without another invitation. Station retires the active browser
peer before changing the credentials, then reconnects the selected route. To
avoid replacing live route settings with an invitation that may fail, an
already-saved route cannot be accepted again; use **Configure TURN** to change
its ICE service.

Then select the saved route. The routing grant stays in browser IndexedDB,
outside the saved Station entry. A selected route uses an encrypted browser
channel for the Station handshake and application requests; a missing grant,
retired key or failed peer connection refuses instead of falling back to direct
HTTP. After selecting the route, **Verify account and
Device** offers a fresh username/password account flow where the Station's
provider supports pending Device enrollment. The Station operator must approve
that Device; only a signed activation completes the account continuation.
Unsupported providers refuse, and Project access remains a separate grant.
If you also have a Project invitation, enter its token in that dialog before
verification. After the operator approves the Device and Station activates its
account session, the browser accepts the invitation through the encrypted
channel; the response must confirm Project membership without granting Device
access. Close the dialog to open the newly permitted Project.
The local/free `--station-ui` acceptance drives this ordinary browser flow on
two distinct HTTPS Origins on one host. It verifies operator key approval,
invitation acceptance, TURN relay selection, fresh account login, explicit
Device approval, Project access, and a published Task through the Station UI;
the unpublished Task remains hidden, and the browser sends no direct Station
`/api` requests after accepting the route. This fixture does not prove Internet
NAT traversal, a second physical machine, or the real two-person journey.
Cookie-session adoption, installed native route selection, and the full account
and revocation matrix remain separate acceptance checks. Browser broker
routes also disable attachment staging uploads, interactive terminal WebSockets
and Nova voice sockets for now: those features still require direct browser
XHR, fetch or WebSocket access, so Station reports them unavailable before
sending attachment bytes, upload grants, terminal input or voice audio.

One broker can serve several Stations, and one Station can be reached through
more than one route. A broker route belongs beneath the Station it reaches; it
is not another Station or a person. A short-lived invitation can enroll one
Device's separate routing grant without sharing the operator's long-lived
broker credential. That grant permits signaling only. The Device must still
approve the Station signing key independently and complete Station account,
Device and Project authorization. The Station operator must explicitly allow
the Device's application Origin; possession of an invitation does not change
that allowlist. See the [local broker lab](local-collaboration-lab.md#separate-self-hosted-broker-and-production-browser-consumer)
for the source-level pilot and its current UI/native limits.

Native Desktop and the CLI share a strict saved-profile file. An older build
that predates broker-route metadata refuses the updated file instead of
discarding fields it does not understand. Update both clients that use the
shared profile root before saving a broker route; [#2404](https://github.com/kontourai/station/issues/2404)
tracks a mixed-version migration. Removing the route in the newer Desktop
removes its metadata without changing the Station or its trust record; other
newer profile fields may still require an updated reader.

## Local first: Ollama (no credentials)

This is the easiest path and needs no cloud account, API key, or AWS setup.

### 1. Install Ollama

Download and install from [ollama.com](https://ollama.com). Ollama runs a local model server on `http://localhost:11434`.

### 2. Pull a model

```bash
ollama pull llama3.1
# or
ollama pull qwen2.5
```

Choose a model that fits the host's resources and the work you intend to run.
Station uses Ollama's OpenAI-compatible chat endpoint. A model appearing in the
catalog does not prove tool support: Station separately asks Ollama for that
capability when building its model inventory, and leaves it unknown if the
lookup fails or times out.

### 3. Let Station suggest it

If Station finds Ollama at `http://localhost:11434`, it can show it as a detected suggestion.
Detection is read-only: it does not create a connection or read credentials.

If Ollama was not running when you opened Connections, start it and return to add or verify the
connection in the next section.

### 4. Add or verify an Ollama connection in the UI

1. Open the **Connections** view.
2. On the **Models** tab, find **Ollama**. If it says **Setup required**, select **Set up**. If it is absent, select **Add model connection** and choose Ollama. Its default server URL is `http://localhost:11434`.
3. The connection lists the models Ollama has pulled. If a model you expect is missing, run `ollama pull <model>` and refresh.

### 5. Pick a model

When editing a Station agent, choose your Ollama model from the agent's model picker. Models you have pulled appear there once the Ollama connection is verified.

---

## Add an engine

Codex, Claude Code, OpenCode, Kiro, and similar agent apps are Engines. Use
**Connections → Engines → Add engine** to add one.

Station knows these engines by name. A detected engine is one whose command is
on this computer's `PATH`; detection does not mean it is signed in or ready.

| Engine | Command Station looks for | How Station runs it |
| --- | --- | --- |
| Claude Code | `claude` | Native adapter; startup can adopt it |
| Codex | `codex` | Native adapter; startup can adopt it |
| Muse | `muse` | Native adapter; startup can adopt it |
| Kiro CLI | `kiro-cli acp` | Agent Client Protocol |
| Cursor | `cursor-agent acp` | Agent Client Protocol |
| OpenCode | `opencode acp` | Agent Client Protocol |
| Goose | `goose acp` | Agent Client Protocol |
| Qwen Code | `qwen --acp` | Agent Client Protocol |
| GitHub Copilot | `copilot --acp` | Agent Client Protocol |
| Grok Build | `grok agent stdio` | Agent Client Protocol |
| Mistral Vibe | `vibe-acp` | Agent Client Protocol |
| Google Antigravity | `agy_acp_server.par` | Agent Client Protocol, macOS only; Google ships the server as a download, so put it on `PATH` yourself |
| Factory Droid | `droid exec --output-format acp-daemon` | Agent Client Protocol |
| Hermes Agent | `hermes acp` | Agent Client Protocol |
| pi | `pi-acp` | Agent Client Protocol through the community `pi-acp` bridge, which does not pass Station tool servers and has no model switching |
| Cline | `cline --acp` | Agent Client Protocol |
| Devin | `devin acp` | Agent Client Protocol |
| Kimi Code | `kimi acp` | Agent Client Protocol |
| Kilo | `kilo acp` | Agent Client Protocol |
| Junie | `junie --acp=true` | Agent Client Protocol |
| Auggie | `auggie --acp` | Agent Client Protocol; it lists no sign-in methods, so sign in with `auggie login` or save its session JSON as a key (see [Sign an engine in](#sign-an-engine-in)) |

The native engines come from
[startup adoption](../../src-server/runtime/bootstrap/native-engine-adoption.ts)
and the Agent Client Protocol entries from the built-in catalogue in
[builtin-acp-engines.ts](../../src-server/providers/llm/builtin-acp-engines.ts). Cursor
is looked up only as `cursor-agent`: its installer also links a bare `agent`,
which other CLIs install too. Any other command
that speaks the Agent Client Protocol can be added with the custom option. What
each engine can receive from Station (system prompt, tools, skills, images) is
recorded per engine in the
[engine capability matrix](../../packages/contracts/src/engine-capability-matrix.ts);
the [ACP guide](acp.md) covers protocol details.

An engine Station did not find reads **Not installed**. Its card shows the
vendor's install command for the operating system Station runs on, with a copy
button and a link to the install guide, and **Check again** repeats the lookup
after you install it, re-reading your login shell's `PATH` so a directory the
installer added there is searched too. A paired device needs permission to
operate Station for that re-read; without it, the card says so and shows what
Station last found. Station shows the command and never runs it. On a paired
device the card says the install belongs on the computer Station runs on.

Some built-in engines carry launch settings that Station sets when it starts
them, such as `GOOSE_DISABLE_KEYRING=1` for Goose (its keychain lookup can hang
without a terminal) and the auto-update switches for Factory Droid and Auggie. A value
already set in the environment Station launches with wins. Only Station's own
catalogue sets them, and only engine-scoped names; they never carry
credentials. A custom connection running the same program, even by full path,
gets the same settings.

Add engine opens one catalogue in the Engines detail pane, beside your
engine list: saved engines that are **Not connected yet**, the native apps
Station supports, the built-in command engines (**Found, not connected** or
**Not installed**), and a custom command. Everything that follows stays in
that pane; a link to one entry (`/connections/engines/new/<id>`, or `custom`)
opens on that entry's first step.

1. Choose an engine. An engine that is **Not installed** offers only its
   install command and **Check again**; it can be connected once Station finds
   it, or through the custom option.
2. Confirm a new catalogue engine with **Connect** (or **Add** for a native
   app) after reviewing what connecting changes. Choosing a saved engine that
   is **Not connected yet** starts its retry directly. For custom setup, enter
   a name and command instead. Command arguments, working directory, and other
   raw setup details stay under **Advanced**.
3. Stay on the page while Station shows **Checking**. An
   engine that is starting for the first time can take up to a minute; the
   page says so and keeps checking. If it has not finished after about 90
   seconds, it stops waiting; Station keeps checking the engine while
   it runs. Station does not check it at startup after a restart; use its
   **Retry check** (or add it again) if it was not ready by then.
4. Read the readiness result and its detail. If it is not Ready, the result
   names the phase that failed and its reason. Use **Retry check** after fixing
   the cause, or **Edit setup** for a custom engine. The engine's Agent is
   added only once its check succeeds.
5. When it is **Ready**, **Start a chat with** the engine opens New chat with
   its Agent selected. A Project-owned Agent uses its own Project; otherwise
   New chat uses the dock's current Project, or no Project when none is open.
   Choose **Done** to finish without opening a chat.

A configured engine that reads **Setup required** offers **Retry check** on its
engine page; a Ready engine offers **Check connection** instead.
An engine whose first check never succeeded is saved but has no Agent yet; it
is listed on the Engines page and at the top of Add engine as **Not connected
yet**, and its page offers **Retry check**, **Remove**, and, for a custom
engine, **Edit setup**. It is not counted as one of your engines until a check
succeeds. A command engine's page also opens its **Connection details**: what
it reported when it connected and the tool servers Station passes to it.
In the Add catalogue, an app that still needs setup offers **Add and set up**:
after its confirm step it is added, and **Finish setup** opens its page, where
setup continues. A **Setup required** result also offers **Sign in to** the
engine, which opens the sign-in described in [Sign an engine in](#sign-an-engine-in).

Discovery reports a possible local engine; it does not guarantee readiness.
Separately, startup can register detected Claude Code, Codex, and Muse CLIs and
persist their default Agents. Automatic adoption respects an engine's recorded
removal and refuses an identity already bound to another connection. It does
not sign the engine in. See
[startup adoption](../../src-server/runtime/bootstrap/native-engine-adoption.ts)
and the [Agent registry](../../src-server/domain/agent-registry.ts).
The UI names the concrete engine, such as
OpenCode or Kiro, rather than exposing its transport as a user category.

The first-run Engines chapter shows the detected, not-yet-connected local Engine subset. Selecting
one there explicitly connects the Engine and creates its default Agent binding.
That discovery action is separate from the automatic startup adoption above.
Catalogue engines Station did not find are listed under **Station also works
with**, each with its install command and **Check again**, and cannot be
selected until Station finds them. The list opens on its own when nothing else
can be chosen.

For the built-in Claude Code Engine, Station chooses between the `claude` executable it finds
installed on your machine and the Claude Code bundled with the Claude Agent SDK:

- The installed executable runs when it reports a version that is not older than the bundled one.
- The bundled copy runs when the installed executable is older.
- The bundled copy also runs when the installed executable does not report a version — Station
  cannot confirm that such a copy runs at all, let alone that it is current.
- The installed executable runs when Station cannot read the bundled version, so an unreadable
  Agent SDK never silently downgrades a working installation.

The Engine's readiness detail names the executable Station will launch and whichever versions it
was able to read.

### Engines from the public registry

Below Station's own engines, **Add engine** lists the engines in the
[public agent registry](https://github.com/agentclientprotocol/registry) under
**From the public registry**. Their publishers list them there, not Station.
Each card shows the publisher, the version the registry lists, and whether it
can connect on this computer:

- **Found** or **Not installed**: Station has reviewed this listing against
  the publisher's own documentation, and the registry has a build for this
  computer's operating system and processor. Connecting runs only the program
  Station reviewed (`stakpak`), which you installed yourself and Station finds
  on `PATH`, with the reviewed arguments (`acp`), and only after the confirm
  step. A **Not installed** card links to the publisher's site. Station never
  downloads the program; the registry's download links are not used.
- **Unavailable**: the card says why and stays in the list, with its
  publisher, version and links. Most listings read **Not yet reviewed by
  Station**. Others have no build for this computer, run only from a package
  (`npx` or `uvx`) that Station would have to download and run, or name a
  different program or arguments than Station reviewed. You can install such
  an engine yourself and add it as a custom engine. Listings for engines
  Station connects directly, such as Claude Code and Codex, point to those
  engines instead.

**About this listing** on each card shows what the registry lists: its id,
how it is distributed, its builds and packages, the command connecting would
run, and any settings it recommends. Station does not apply those settings:
the registry is not Station's own catalogue, and an environment variable can
change what a program runs.

**Review** opens the confirm step, which shows the exact command line (an
argument with a space, or an empty one, is shown in quotes),
publisher and version before anything is saved. Adding a registry engine is
choosing a command, so a paired device needs the operator's `coding:exec`
grant. If the registry changed the command between the confirm step and the
add, Station saves nothing and asks you to review it again. An added registry
engine goes through the same check and Agent setup as any engine; being listed
does not mean it is signed in, or that Station's tools, approvals, model
choice or remote use work with it.

An engine that is also one of Station's own, such as Goose or Cursor, is listed
once, as Station's card. The registry adds only its version and publisher to
that card, never its command, arguments, settings or install instructions.

When the registry later lists a new version or command for an engine you
added from it, the engine's page says **Update listed**. Station does not
change the saved connection; update the program yourself. Changing the
connection's command yourself ends the comparison.

Station downloads the registry index when the catalogue is read and its copy
is more than a day old, or when you choose **Check registry**, and keeps the
last good copy under its home folder. Without a network it lists that copy and
says **Offline copy**. An index that is too large or malformed is refused whole
and the saved copy stays; a single malformed listing is left out. Set
`STATION_PUBLIC_AGENT_REGISTRY=off` (or `0`, `false`, `no`) to stop Station
reading the registry. Registry engines are offered only here, never in **Add
model connection**.

## Sign an engine in

An engine Station runs as a command keeps its own sign-in on the computer
Station runs on. Its engine page has a **Sign-in** panel, and a chat the engine
refused because it needs a sign-in offers **Sign in**, which opens that page.

**Status.** The panel reads **Signed in**, **Not signed in** or **Not checked**
and says where that came from:

- The engine's own status command, for the engines whose vendor documents what
  it prints: Kiro CLI (`kiro-cli whoami`) and Cursor
  (`cursor-agent status --format json`). Station runs it without a shell,
  stops it after 8 seconds or 64 KB of output, and reuses the answer for a
  minute; **Check again** runs it now. An exit code alone never reads as signed
  in. With a key for the engine present, a "signed out" answer reads as not
  checked, because no vendor documents the status command reading the key.
  Only this check feeds the engine's readiness: signed out is a required
  prerequisite, and an inconclusive check is optional.
- What the engine said: a chat or a check it refused with "Authentication
  required" reads as **Not signed in** until a later chat gets an answer, and a
  sign-in started here that finished reads as **Signed in**. Neither changes
  readiness. These observations belong to the command and arguments that
  produced them; changing the invocation or removing the connection forgets
  them. A status check already running at that point cannot restore its old
  answer.
- Otherwise **Not checked**, and the panel says the engine has no check
  Station can run.

**Ways to sign in.** Station asks the engine which sign-in methods it offers
(a short-lived start of the engine that tells it Station can run a terminal
sign-in) and lists them, minus any the catalogue hides (Factory Droid's
API-key method, which the key field replaces):

- A *terminal* method (for example pi's) runs the engine's own command, with
  its configured arguments plus the arguments the engine named, in a terminal
  on the computer Station runs on; the panel shows that terminal. The engine's
  exit code decides the result. Nothing the browser sends is run: the browser
  names only the method.
- Any other method asks the engine to sign itself in. It may open a browser on
  that computer; links it prints are shown with **Open link**, and Station never
  opens them itself. Station gives up after five minutes (a terminal sign-in
  after 15).

**Keys.** For engines that read a key from the environment (for example
`FACTORY_API_KEY`, `CURSOR_API_KEY`, `WINDSURF_API_KEY`,
`AUGMENT_SESSION_AUTH`), the panel has a field per variable. Station stores
the value in its engine credential store (`security/engine-credentials.json`
under the Station home, readable only by its owner), never in
`config/acp.json`, never in logs, and never sends it back; the panel shows
only that it is saved. The value is added to that one connection's engine
processes, overriding the same variable in Station's own environment.
Removing the connection attempts to remove its keys. Station logs a warning
if that cleanup fails; the connection removal still completes.

**Who may sign in.** Reading the panel needs read access; **Check again**
needs permission to operate Station. Starting or cancelling a sign-in and
saving or removing a key need `engine:login` on a paired device. A terminal
sign-in runs a command on the computer Station runs on, so a paired device
also needs `coding:exec` and `terminal:operate`; without them the panel says to
sign in on that computer. The operator in person needs no grant.

**Subscription logins.** Where a method can use a subscription whose provider
restricts using it in other tools (pi's and Hermes' setup can use a Claude
subscription), the panel shows a short note and a link to the provider's
terms. It does not stop the sign-in. Station never reads, copies or passes on
an engine's own credentials (see
[ADR 0013](../adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md)).

Live sign-in against real vendor accounts has not been verified; the flows are
tested against a stand-in engine that speaks the same protocol.

---

## Route an engine through a model proxy

In **Models**, save an OpenAI-compatible connection with the proxy address and key.
Then open **Engines → Claude Code** or **Engines → Codex**, select that connection
under **Connect through**, and save. Choose a **Default model** from the discovered
list and save it. **Check connection** sends one short message and reports whether
the engine answered. A failed check is shown as **Check failed**; a model catalog
alone does not override that result. **Refresh models** refreshes the catalog.

Model requests use the proxy; the engine and its tools still run on this Station.

A routed connection authenticates with that proxy key: readiness reports the
saved key as the engine's credential (shown as **Proxy key**) and does not
require the CLI's own login. Without a route the engine's CLI login is the
credential, and a missing login blocks launch. The readiness answer, the launch
gate, and the connection list all read that one derivation from the engine
adapter, so they cannot disagree.

The engine stores `config.proxyConnectionId`, referring to the saved Model
connection. Its current key is resolved on each launch and never copied into
engine settings. Codex uses provider arguments while keeping its config home.
Changing settings alone does not rewrite a session's recorded route; a relaunch
records the route it actually uses. Chat and work lists show **via <proxy name>**.

The following environment/config-home options remain available for custom setups.
Choosing **Your account** or a saved proxy in the UI explicitly replaces those
custom connection settings.

A Claude Code or Codex Engine connection can be configured to use a local
model proxy. The proxy must support the chosen engine's requests; an
Anthropic/OpenAI-compatible endpoint label alone does not establish that.
Set this in the connection's runtime
config (`agentConnections.<engine>.config` in `config/app.json`):

- `env` — environment variables merged into every engine subprocess the
  connection spawns. Names must be valid env-var names; Station-internal
  secret names and `TMPDIR` are refused. An empty-string value masks an
  inherited variable.
- `configHome` — an explicit engine config home (`~` allowed), applied as
  `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). It wins over the
  station-managed app-home opt-in (`useAppHome`); a selected credential
  profile still wins over both.

For example, if your local proxy expects a placeholder token:

```json
{
  "agentConnections": {
    "claude": {
      "config": {
        "env": {
          "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318",
          "ANTHROPIC_AUTH_TOKEN": "local-proxy",
          "ANTHROPIC_API_KEY": ""
        }
      }
    }
  }
}
```

For custom Codex configurations, `configHome` can point at a dedicated home whose
`config.toml` sets `model_provider` to the proxy's provider entry, so model
discovery lists what the proxy serves.

The Engine's login readiness is checked under the same `env` and `configHome`:
a proxy token such as `ANTHROPIC_AUTH_TOKEN` counts as signed in, an
empty-string value masks the inherited key, and Codex's login probe reads the
configured `CODEX_HOME`. A connection routed through a model proxy counts as
signed in through the proxy's injected provider key, so no Codex CLI login is
needed there. On macOS, Claude readiness reads its selected
Keychain namespace first, using `CLAUDE_SECURESTORAGE_CONFIG_DIR` before
`CLAUDE_CONFIG_DIR`. It consults the selected credential file only when the
Keychain entry is absent. An unreadable or malformed secure-store result stays
unknown; it cannot borrow another namespace's login. These checks establish
credential presence, rather than token validity. Readiness does not apply the
app-home opt-in or a selected credential profile.

On macOS, a Claude session that a Project member, a shared Agent or delegated
work starts at full access runs inside Station's Seatbelt profile. Such a
session cannot use your Keychain login, and Station never copies it there.
Give it a credential of its own: set `ANTHROPIC_API_KEY`, or a
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, in the Claude
connection's `env`. Without one, such a session runs at Auto, and says so. The
optional **Confined Claude credential** readiness entry reports whether one is
present. A confined session uses a Station-owned Claude configuration
directory, so your own `CLAUDE.md`, settings, hooks, plugins and MCP
configuration do not apply to it. A selected credential profile gets a
confined copy of its own that starts empty, so a login held only in that
profile does not reach it: the session runs at Auto until it has an
environment credential. The readiness entry checks only the default confined
home.

A confined session also gets only an allowlisted environment. Variables you
set in the connection's `env` pass, as do paths, locale, proxy and TLS
settings, `CLAUDE_*` and `ANTHROPIC_*`, the git author and committer
identity, and `EDITOR`/`VISUAL`. Everything else in Station's environment is
dropped: `GH_TOKEN`, `NPM_TOKEN`, cloud keys, and toolchain variables such as
`NVM_DIR`, `JAVA_HOME`, `GOPATH` or `PYENV_ROOT` (set them in the
connection's `env` if its tools need them). Without `SSH_AUTH_SOCK` it cannot
push with your SSH agent. In a linked worktree it can commit to its own
branch, but `git stash`, `fetch` and `pull` are refused: they write shared
refs (`refs/stash`, remote-tracking refs, `packed-refs`) that it may not
change. In a folder whose `.git` is inside it, `fetch`, `pull` and ref
packing are refused too: its remote-tracking refs are what a later Codex
session trusts the folder's `.codex` by. It also cannot create or change any `.claude` or `.codex`
directory in the folder, at any depth, which other sessions there would
load. On Linux and
Windows such a session is
refused, because no confinement exists for it there. See
[confinement providers](../design/approval-posture-server-ordered.md#410-confinement-providers-2494).

A Codex session that does not run as `host` (started by you in person, or
from a device you granted full access) runs under a Codex permission profile
Station defines, `station-workspace`. Its sandbox lets it write only inside
its folder and its temp directories, and on macOS it cannot create, change or
read any `.codex` or `.claude` directory in the folder, at any depth, which
other sessions there would load. It ignores every
`sandbox_workspace_write.writable_roots` setting and every `sandbox_mode` or
`default_permissions` setting, whether from the folder's configuration or
your own. It also ignores `sandbox_workspace_write.network_access`: to give
these sessions network, set `[permissions.station-workspace.network]
enabled = true` in your own Codex configuration. A `.codex` that came from the
repository's upstream (its exact bytes are on a remote-tracking branch, such
as `origin/main` after a fetch) still applies, as the top-level one does. Any
other `.codex` anywhere from the repository root down to the session's folder
(uncommitted, committed only locally, changed, inside a nested repository,
or in a folder with no repository or no remote) stops the session from
starting, with the directory named. Station checks from the repository that
contains the session's Project folder (the deepest Project folder around the
session's folder, even when the start names none) down to the session's
folder. Cases that refuse a session you meant to allow,
and the remedy:

- **No remote, or not pushed or not fetched yet.** The repository has no
  remote-tracking branch, or the `.codex` is committed only locally, or the
  latest push has not been fetched. Push it and run `git fetch`.
- **A local change.** An uncommitted edit or an extra untracked file inside
  a `.codex` (a local override) does not match upstream. Commit and push it,
  move it to your own Codex configuration, or run the session as `host`.
- **The reftable ref backend.** Station cannot read its refs safely, so it
  trusts no `.codex` there. Run the session as `host`.
- **An unregistered nested repository or submodule below the Project folder.** Its `.codex` is refused even when identical bytes occur on the outer Project repository's remote-tracking branches. A linked worktree must be registered to the trusted repository. Otherwise run the session as `host`, or make the nested repository a Project of its own.
- **A folder outside every Project.** A session that is not `host` there
  trusts no `.codex` at all. Add the folder as a Project, or run the session
  as `host`.

A confined Claude session cannot run `git fetch` or `pull` (or pack refs) in
a folder whose `.git` is inside it, as in a linked worktree: the
remote-tracking refs are what a later Codex session trusts. Fetch and pull
from your own terminal or a `host` session. If Codex does not
report the profile applied (a Codex version without permission profiles),
a session that must be confined is refused, and any other is recorded as
`configured-but-failed`. On Linux, Codex cannot deny a `.codex` the session
creates later, so that protection is macOS-only. Station also starts these
sessions with `approvals_reviewer="user"`, whatever your configuration sets,
so a model never approves their sandbox escalations.

Two boundaries to know: credential-profile login/enrolment children do not
receive the connection's `env`; they use the selected profile's config home
over the process environment. Changing `configHome` does not migrate existing
history. Ordinary resumes resolve the current connection/profile environment,
so changing it can make an older transcript unavailable. Adopted sessions with
a recorded source-home binding follow that binding instead. Saving silently
drops invalid `env` entries, including values containing
NUL or longer than 32,768 JavaScript string code units. It retains at most the
first 64 valid entries. These rules are also applied when spawning from
hand-edited configuration.

One failure mode to expect: most proxies re-identify requests to the provider
with their own client identity and capability flags, not your engine's. A
proxy build that lags the provider's current client can be refused for models
that require a newer client — with an error telling you to update your local
engine, which is already current — or have newer request fields rejected as
unknown. If a proxied connection fails with a client-version error, update
the proxy first; Station cannot rewrite what the proxy sends upstream, and
unproxied connections are unaffected.

### Give a credential profile its own routing

A connection's `env` applies to every session of that Engine. A **credential
profile** (a separate, Station-managed engine home per account) can also carry
its own non-secret env overlay, so one account can run through a proxy while
another talks to the provider directly. Set it with
`station connections profile-env <engine> <profile-ref> --data=<json>` or
`PUT /api/connections/agent/<engine>/credential-recovery/profiles/<profile-ref>/env`;
the body replaces the whole overlay and `{"env":{}}` clears it. For example,
to route a Claude Code profile through a local proxy and hide an inherited
API key:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318",
    "ANTHROPIC_API_KEY": ""
  }
}
```

The overlay is meant for non-secret values, and Station refuses values that
look like credentials. This is a heuristic, not a secret detector: a non-empty
value is refused when its name ends in `KEY(S)`, `TOKEN(S)`, `SECRET(S)`,
`PASSWORD(S)`, `PASSWD`, `CREDENTIAL(S)`, `AUTH`, `HEADER(S)` or `_PAT` (any
case), or when the value carries URL userinfo (`http://user:pass@host`), an
authorization or API-key header, or a `Bearer`/`Basic` credential. An empty
string is allowed under any name so the profile can mask an inherited
credential. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `TMPDIR`, and Station-internal
names are refused too. The whole overlay is refused rather than trimmed when
any entry breaks these rules. A proxy token therefore cannot be set on a
profile today: keep it in the profile's own engine home (its sign-in), or in
the connection `env`, which applies to every profile.

A session running under a profile sees, from lowest to highest precedence: the
server's environment, the connection `env`, the profile overlay, the profile's
own config-home key, then Station's engine temp directory
([resolver](../../src-server/providers/app-home/credential-profile-env.ts)). The profile is the
one an Agent pins, the one credential recovery is trying, or else the
connection's active profile. The overlay reaches Claude Code and Codex session
starts and Codex quota reads for that profile. It is not applied to model
discovery, adopted sessions and source-home resumes, login readiness checks,
login/enrolment into the profile, or the per-profile usage read
(`GET /api/connections/agent/<engine>/credential-usage`), which reads the
profile home directly.

If a saved overlay is invalid (for example after hand-editing
`config/app.json`), or the connection's active profile cannot otherwise be
prepared, the session start fails instead of running on the global engine
configuration. Station does not keep the invalid values: the next profile
change (or a settings save or import that includes the profiles) rewrites
the overlay as an `envInvalid` marker that holds only the offending variable
names, and `GET /config/app` never returns them. Until then a hand-edited
value stays in `config/app.json`. The
marker keeps the profile refused, so other profile changes cannot quietly
un-route it. `station connections profiles` shows such a profile with
`envInvalid` and the offending variable names, and the server log names them
too. Replace the overlay with `profile-env` to repair
it. Automatic credential recovery only switches to an enrolled
profile whose overlay is identical to the active profile's; when every
enrolled candidate differs, it refuses with `environment_mismatch`. Choosing
a profile by hand, or pinning one on an Agent, is not restricted this way.

### Prefer allowance that expires sooner during account recovery

Automatic recovery keeps enrollment order unless you explicitly add an
`allowancePreference` to its existing policy. This ranks already-enrolled,
authorized accounts after an observed account-scoped capacity or rate-limit
failure; it does not switch a healthy running Session or override an Agent's
explicit credential choice.

```json
{
  "automatic": true,
  "allowancePreference": {
    "windowId": "secondary",
    "minimumRemainingPercent": 20
  }
}
```

Send that body to `PUT /api/connections/agent/<engine>/credential-recovery/policy`.
Choose the window ID actually reported by your engine. Station compares that
window's qualified reset deadline, rather than allowing a short rolling reset
to outweigh the longer window you selected. Fresh provider-reported
non-renewing subscription ends can also shorten the deadline. Current native
engines do not report subscription-end/renewal facts through this quota
contract, so Station does not infer them from a plan name.

The selected window's remaining percentage must meet your threshold, and a
fresh exhausted window disqualifies the account. Observations older than one
minute, future-dated observations, unqualified deadlines, global-account
fallbacks and missing quota data cannot earn expiry priority. Unknown evidence
retains enrollment order among candidates that are not known to have
insufficient allowance; if every candidate has insufficient observed allowance,
no application is staged. Equal deadlines retain enrollment order.

Account probes are limited to four at once. Station rechecks profile routing,
enrollment and policy after probing; intervening changes refuse staging.
Existing recovery admission, durable application, cancellation and provider
acceptance remain authoritative. Choosing a candidate does not prove that an
engine applied it or that the resumed turn succeeded.

Omitting `allowancePreference` from a policy update preserves the saved
preference; send `"allowancePreference": null` to clear it. The existing SDK
`useSetCredentialRecoveryAutomaticPolicyMutation` accepts the same optional
field. This policy remains opt-in and automatic recovery remains off by default.

The overlay is not secret. It is visible to the engine and to every tool it
runs (an agent can read these variables, for example from a shell), and to
anyone who can read this Station's connection settings, not only to holders
of the `access:manage` scope that the dedicated route requires. Do not put
anything there that should stay private.

---

## OpenAI-compatible endpoints

Many hosted and self-hosted inference servers expose an OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`). Station connects to these as an **OpenAI-compatible** Model connection.

1. On **Connections → Models**, select **Add model connection** and choose a named service such as **LiteLLM** or **OpenRouter**, or choose **Other OpenAI-compatible**.
2. Confirm the **server URL** for the service's API root (for example, the URL that serves `/chat/completions` and `/models`).
3. Provide an **API key** if the endpoint requires one. Endpoints that need no auth can leave it blank.
4. Verify the connection, then pick a model when editing a Station agent.

---

## AWS Bedrock (optional)

Bedrock is optional. Choose a default AWS credential chain, a named AWS profile,
or a Bedrock API key; ambient access-key variables are not required for every
mode. See [environment variables](../reference/env-vars.md) for AWS settings and
the minimum IAM policy.

1. Choose a region and authentication mode. For the default credential chain,
   make credentials available to the Station server through its environment,
   configured AWS profile, or another supported AWS credential source.
2. Station can suggest Bedrock when its bounded AWS credential-chain check
   succeeds. The suggestion exposes readiness information rather than credential
   values; the check can consult the configured credential sources.
3. Select **Add model connection**, choose **Amazon Bedrock**, then choose the region and one of the supported authentication modes: default AWS credentials, a named AWS profile, or a Bedrock API key.
4. Pick a Bedrock model when editing a Station agent.

Bedrock-specific configuration (the AWS `region` and a Bedrock `defaultModel`) is documented in [docs/reference/config.md](../reference/config.md). These fields apply only when you run Bedrock.

Startup has a separate legacy seeding path: if there is no saved LLM connection
and the default AWS credential chain resolves within its bounded check, Station
creates an enabled Bedrock connection. That check resolves credentials; it does
not prove access to a Bedrock model. Ollama detection does not create a connection.
See [startup seeding](../../src-server/runtime/bootstrap/runtime-startup.ts) and
the [credential check](../../src-server/providers/llm/bedrock.ts).

---

## Current configuration defaults

`config/app.json` supplies Station-wide inference defaults:

- `defaultLLMProvider` — the connection ID used for inference by default.
- `defaultModel` — the default model ID (a Bedrock model ID when using Bedrock; a local model name such as `llama3.1` when using Ollama).

See [docs/reference/config.md](../reference/config.md) for the full `app.json` reference and an Ollama-first example.

A Project can override them with `defaultProviderId` and `defaultModel`; an
Agent can bind its own Model connection through `execution.modelConnectionId`.
For Station-engine Agents, connection selection uses that explicit binding,
then `defaultLLMProvider`, then the sole enabled LLM connection. Several enabled
connections without a default are ambiguous; readiness does not silently choose
one. See [Agent configuration](agent-configuration.md#agent-configuration).

The chat model picker shows the resolved connection and model. Open it to
search across ready Model connections and Engines, filter by connection or
Favorites or Recent, and choose the exact model for this chat. Open Options
for capability filters and the selected model's supported runtime controls.
Connections that still
need setup remain visible with their status, but cannot create an invalid
selection.

Favorites, recent choices, hidden models, and model order are saved for your verified person on this Station and follow that person across devices. Without a person-bound preference scope, they remain on this device. If account preferences are unavailable, changes are refused until they can be reloaded. Manage a connection's model list from its detail page. **Use project
default**, **Use agent default**, or the other named reset shown in the picker
restores both the default connection and model for a model-only choice.
An engine override instead offers **Use Agent defaults**; in an existing
conversation this opens an explicit handoff back to the authored execution
binding and model. It does not edit the saved Agent.

---

## Start a Project from a repository

In **New Project**, open **Start from a Git repository**, enter the explicit
HTTPS or SSH repository URL, and optionally choose a branch or tag and a
repository-relative subdirectory such as `apps/web`. Choose
**Acquire repository**, then **Use this checkout** to put the working copy into
the Project draft. Station uses the repository name for an untouched name field.
Create the Project and select its starter through the usual form. At creation,
Station rechecks the checkout's origin, commit and unchanged files, then retains
the acquisition source and exact commit on the Project. If files changed, Station
preserves them and asks you to reacquire or deliberately choose the folder.

Acquisition uses this host's Git credentials and currently requires the Station
operator. URLs containing HTTPS user information, passwords, query strings or
fragments are refused. An absolute local mirror path is also supported.
Station verifies the clone's origin, resolves its commit and checks it out in
detached state. For a monorepo, the selected subdirectory becomes the Project
working directory while the receipt retains the repository root and exact commit.
The directory must exist inside the checkout; traversal, Git metadata directories
and symlink redirects are refused and rechecked at Project creation. It does not install dependencies or execute repository setup.

**Choose from GitHub** and **Choose from GitLab** list accessible public/private
repositories through this host's signed-in `gh` or `glab` account. A page holds
at most 30 entries and shows the observed account, visibility and default branch.
Choose HTTPS or SSH explicitly; selection fills editable URL/ref fields using
the provider's returned clone transport. It does not clone automatically or
establish that the host's separate Git credentials can access that repository.
Discovery checks the account before and after listing, withholds late results
after Station authority changes, and never reads or returns provider tokens.
If the CLI or sign-in is unavailable, sign in on the host with `gh auth login`
or `glab auth login`, retry, or paste a Git URL. Self-hosted forges remain an
explicit-URL flow; the account pickers target `github.com` and `gitlab.com`.

**Find existing checkouts** lists up to 20 retained acquisitions matching the
entered repository identity, requested ref and subdirectory. These are historical
observations until **Check and reuse** rechecks the checkout's current origin,
pinned commit and unchanged files. Reuse selects the retained operation without
cloning, fetching a moved branch or overwriting edits. Drift is refused; acquire
a fresh copy or deliberately choose an existing folder instead. The displayed
commit is the version being reused, not a new remote-branch observation.

The browser retains the operation ID in session storage, partitioned by Station
and account. Reopening the form checks that operation; a lost response does not
automatically clone again. **Check operation** reads the recorded result.
**Retry acquisition** explicitly starts a new attempt in a different owned
directory, preserving earlier attempts and their edits. An interrupted operation
can remain acquiring until inspected, cancelled or explicitly retried.
**Cancel acquisition** durably prevents that operation from producing a usable
checkout; retries of its ID remain cancelled. Files are preserved. An in-flight
Git command may finish within its existing deadline; cancellation does not claim
that the remote command was terminated. A completed verified checkout cannot be
cancelled. **Choose another source** clears the browser selection; it does not
delete a working copy.

For the Station operator, **Create** also saves the immutable Project draft and
selected starter before sending. Reopening New Project, including after a page
reload, checks the same server request. **Continue creation** resumes an
unrecorded request; **Retry layout** retains the saved starter and checks for an
already-applied layout before an explicit retry. **Check setup** only inspects.
An unknown creation outcome stays held. An unavailable/deleted result is not
silently replaced. **Set aside this setup** clears only the browser selection;
it keeps Projects, checkouts and server receipts. The chosen start intent is
retained with this browser setup, so a knowledge start still opens Sources after
reload rather than switching to repository setup. Recovery is partitioned by
Station/account and requires current request authority at every action.
Other callers keep the existing creation path; this durable flow currently
requires the operator. Unreadable browser storage prevents dispatch.

Acquisition rechecks current operator and request authority after lock waits and
asynchronous preparation, immediately before Git launch after credential configuration,
before publishing its receipt, and before releasing the response. If authority ends
after work has started, the retained outcome can remain uncertain; a refusal does not
prove that an already launched Git process stopped. Inspect the saved operation under
current authority before explicitly retrying.

The receipt records a completed acquisition, not continuing checkout integrity,
build readiness or a successful Agent turn. Project creation separately rechecks
the receipt and records historical provenance; later checkout changes still need
the normal workspace checks. Operator-assisted import uses host Git credentials.
Provider OAuth, Project-scoped forge grants and collaboration onboarding are
tracked separately in [the authorization epic](https://github.com/kontourai/station/issues/4068);
importing a repository does not grant an Agent remote credentials.
Project Settings → Sources combines repository repair with knowledge-store
registration, refresh and disconnect. A repository repair row offers the same
acquisition and retained-checkout picker. **Use this checkout** fills the repair
path; the separate bind action verifies the current declared resource before
recording its location. Selection does not change the primary resource. See [knowledge sources](knowledge.md#project-settings--sources).
**Add a repository** also works for blank and knowledge-first Projects. Acquire
or reuse a copy, choose **Use this checkout**, then confirm **Attach repository**.
The existing primary resource, working directory and knowledge configuration are
preserved. The optional **Use this repository for code work in this Project**
checkbox explicitly selects its verified repository-relative execution root;
it is unchecked initially and does not promote or remove an existing primary resource.
An identity with no existing resources requires an explicit code-work choice,
because its first repository would otherwise become the execution fallback.
Changing where Agent work starts affects new Sessions. An existing qualified
Session keeps its original directory while that directory remains a verified
resource of the same Project incarnation. Detaching or changing that resource,
replacing its directory with a symlink, or replacing the Project can prevent
continuation; Station does not silently move the chat to the new default.
Older Sessions without verified Project identity cannot gain that authority
from the current slug.

Attachment checks the expected portable identity and immutable local Project ID.
A changed Project or binding is refused instead of overwriting it. If the
response is lost, **Retry saved attachment** repeats the same selection. A
binding can be recorded before manifest publication; inspect Sources after an
uncertain result. Retrying the same intent recovers it without another clone.
This attaches repository resources; it does not run setup or grant remote Git
credentials to an Agent.

See the [API contract](../reference/api.md#repository-acquisition).

## Review local repository setup

Repository acquisition and attachment run no setup. After creating the Project,
open **Project settings → Sources → Optional repository setup**, then review
setup. Enter a command you
trust, its deadline (1–600 seconds; 30 by default), and the execution-directory-relative
files that affect it. Include manifests, lockfiles and any invoked scripts.
**Preview setup** records the exact command, deadline, current execution root,
Git commit and file hashes; absent declared inputs are recorded too. Nothing
runs at preview. Check these facts, then select **I authorize this exact command
on this Station** and **Run reviewed setup**.

This is an operator action using this host account, network and credentials.
Do not put secrets in command text. It is not a sandbox, collaborator grant or
portable recipe. Reviewed setup currently requires POSIX process groups;
Windows operators can use their terminal. Output is bounded to 1 MiB per stream
and is not retained. On the reviewed deadline, the runner stops the process
group. When the shell exits it also retires same-group background children.
Processes that deliberately leave that group are outside this control.

Station retains an operation before starting the command. **Check setup outcome**
reads it; reload or a lost response does not run it again. A failed command can
leave partial effects. After an abrupt server exit, the outcome is **uncertain**
and a command may still be running: inspect the workspace and processes before
explicitly starting a new preview. The live runner's deadline does not survive
a forcibly killed server. Station never rolls back files or retries a started
operation automatically.

Changed declared inputs, Git HEAD or execution root make a preview stale; a
successful receipt also becomes stale when its observed post-command inputs
change. Existing Agent edits are preserved. The check does not track environment,
remote dependencies or undeclared files, and cannot fence a concurrent writer
after inspection. A successful exit certifies only that command's observed
outcome, not build/test readiness or protected execution. Each input is a regular
file of at most 1 MiB, with 32 files and 8 MiB total per preview. Receipts have a
64 KiB serialized limit, including reserved outcome space; history is limited to
1,000 operations per Station. The browser retains its setup selection by Station
and account. Portable preparation and reproducible recipes remain owned by
[#2875](https://github.com/kontourai/station/issues/2875) and
[#3759](https://github.com/kontourai/station/issues/3759).

## Developer services and computers

Connections has one clear home for each relationship:

- **Computers** combines saved Station and SSH relationships. Its rows distinguish
  authorization from observed reachability. **Add computer** asks whether to
  invite a device, connect another Station, or run work over SSH. Connecting a
  Station opens the same destination and independent-access journey as
  **Connect a Station** in the Station manager.
- **Tools** manages MCP tool-server integrations and their prerequisites.
  Installing a CLI or saving an integration does not by itself prove its login
  or tool availability.
  For a saved integration configured to use personal accounts, **Your account**
  shows whether tools use your account, a Project-specific account, an explicitly
  allowed shared account, or no account. Choose **Connect your account**, then
  **Open sign-in page**. Complete consent and paste the full redirected localhost
  URL into **Redirected URL**, even if that localhost page does not load. Choose
  **Finish sign-in** to submit it through Station's authenticated callback route.
  The field clears on submission. **Disconnect your account** removes your
  account for this integration without deleting the integration or another
  person's account. Save definition changes before managing the account.
  These controls expose the existing remote manual OAuth flow; they do not add
  hosted, unattended or membership-revocation support to personal credentials.
- **Knowledge** manages Knowledge sources; see the [Knowledge guide](knowledge.md).
- When an agent tool depends on a disconnected tool server, **Repair
  connection** opens that exact server. Station does not label the tool
  available or ask the user to add it first.
- A stdio MCP integration can bind a named child environment variable to a
  local Datum reference. The binding is granted to that exact integration and
  materialized only while a fresh child is established; Station-control and
  non-stdio transports reject authored bindings. A stored legacy credential is
  removed only after a fresh bound child succeeds.
  Native foreground invocations select Project-narrowed credentials using the
  trusted invocation's active Project, including for a global Agent whose tools
  were already loaded. The authored Agent's Project ownership is unchanged.
  Calls without that foreground context retain the authored-Project fallback;
  global background/scheduled Project credential context is not established by
  this path. Disconnect is checked again by subsequent retained-tool calls.

## Pairing scopes on this computer

Device-pairing scopes apply to protected HTTP requests even when a desktop app
or CLI talks to Station on the same computer. A **Read-only** Device can view
and stream permitted state, but cannot mutate resources. Remote terminal
WebSockets additionally require `terminal:operate`; **Standard** includes that
scope along with read and operate. The operator changes an existing Device's
scope in place with **Paired devices** → the Device → **Change access**, or on
the Station host with `station environment access scope`; `access:manage` is
never granted this way. A phone or browser that uses Station's **Request
access** screen asks for full device access: Standard plus **Run commands**
and **Skip approval prompts**. Whoever approves sees "asks for full device
access" and approves it as asked, or opens **Limit access** to untick
permissions first; only the operator can approve the two elevated ones. In
**Needs attention** the request is one line with **Review**, which opens the
details. (The share prompt's **Request pairing for this browser** still
asks for the full default grant; it says so on screen.) A Device paired by an older Station may still hold
`access:manage` from the historical default grant; its first access change, in
either place, removes it for good and says so.

An operator can separately grant **Manage device access** (`access:devices`)
to an already-paired Device. Its CLI and Paired devices panel can then list,
change scopes, revoke and remove revoked records remotely, using that Device's
own credential. Only the operator may grant or remove `access:devices`; it
never comes from pairing defaults, legacy `access:manage` or permission to use
full access. A person-bound Device also needs the Admin group ceiling. Account
sign-in and transport admission remain independent requirements. See the
[CLI setup](../reference/cli.md#environment).

An operator can separately grant **Approve pairing requests** (`access:approve`).
This allows that Device to list, approve, or deny pending requests, without
Device-management access. A Device tied to a person keeps it only while that
person's Station group is Admin (#3557). A pairing notification opens the exact request in
**Notifications**; opening it does not approve it. Devices without approval
authority see the trusted-Station remedy instead of decision controls.

The current terminal and voice listeners retain a separate direct-loopback
path without credential verification. Browser-shaped upgrades on that path
must use an allowed Station Origin; this check is not a Device-scope check.
A read-only pairing is therefore not a sandbox against a local process. See
the [current transport matrix](../security/remote-access-threat-model.md#surface-matrix)
and the HTTP-scope rationale in
[the peer-pairing design decision](../design/station-peer-pairing.md#loopback-scopes-are-not-an-exception-station1198).

## Simplified setup program

Connections owns Models, Engines, Tools, Knowledge, and Computers. Settings
explains where settings live and routes setup to those owners. The
[shortcut editor](keyboard-shortcuts.md) remains a separate Settings task.
The original setup work was tracked in #1349–#1354; this historical sequence
does not define today's navigation or establish live provider compatibility.

---

## Route aliases

The Connections, Guidance and Tool-server URLs have a single canonical route per concept; the previously-shipped URLs listed below still work because navigation-store ingestion rewrites them to the canonical route via `getLegacyPathRedirect` (see `src-ui/src/app-shell/routing.ts`) before view resolution. Aliasing covers the paths in this table, not every historical URL (e.g. the pre-rename `/connections/runtimes` is not resolved).

| Concept | Canonical route | Aliases (still work) |
|---|---|---|
| Model connections | `/connections/models` | `/connections/providers`, `/manage/providers` |
| Engines, including custom local commands | `/connections/engines` | `/connections/acp`, `/connections/agent-apps`, `/connections/agents` |
| Skills | `/guidance?tab=skills` | `/skills`, and the retired `/playbooks`, `/prompts`, `/manage/prompts` |
| Tool servers | `/connections/tools` | `/integrations`, `/tools`, `/manage/integrations` |
| Registry | `/registry` (optionally `/registry/:tab` for `agents`\|`skills`\|`integrations`\|`plugins`\|`layouts`\|`kits`) | — |

The connection section registry and `getPathForView` emit canonical routes.
Navigation ingestion also normalizes the listed aliases, including old deep
links. See the [section registry](../../src-ui/src/views/connections-hub/connection-sections.ts)
and [routing owner](../../src-ui/src/app-shell/routing.ts).

The invitation intake controller loads only on iOS and still waits for launch
delivery handling before starting protected roots. No-expiry links have no local
expiry timer. Longer finite deadlines are checked in bounded timer intervals,
so browser timer overflow cannot close a valid link early.
