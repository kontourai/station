# Connections Guide

Connections power Station's chats and agents. A **Model connection** is a hosted service or
local model server that Station's engine runs inference on; an **Engine** is an agent app such
as Codex or Claude Code that runs its own loop. They appear under **Connections** on the
**Models** and **Engines** tabs, each with one clear readiness label and one next action.

For the precise vocabulary used below, see [docs/glossary.md](../glossary.md).

---

See the [application walkthrough](../learn/walkthroughs.md#connections) for a captured example and its evidence limits.

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

## Saved Station addresses

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
**Device configured · not selected** until you choose **Use this Station**. A
selected configured row distinguishes **account sign-in required** from
**account session active** using the current native account scope; neither
status says the workspace is connected. Sign in with the Station account only
after selecting its route. Account sign-in does not approve a Device or create
Project membership.

The selected route's **Accept account invitation** action requires that account
session. Station returns a typed Project membership receipt with the exact
Project scope and `grantsDeviceAccess: false`; the UI invalidates the Station
Project-list cache. Device approval remains separate. **Sign out of this
Station account** asks Station to revoke the account session and reports
revocation only after the host validates Station's typed confirmation. If the
response is lost or invalid, the UI reports the remote outcome as unconfirmed.
**Forget account session on this device** only clears the host-held local
continuation; it does not revoke the remote Station session.

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

1. Select a detected or supported engine, or choose the custom option.
2. For custom setup, enter a name and command. Command arguments, working directory, and other
   raw setup details stay under **Advanced**.
3. Keep the same dialog or sheet open while Station shows **Checking**.
4. Read the readiness result and its detail. If it is
   not Ready, use the offered retry, edit, or choose-another-engine action before closing.

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

---

## Route an engine through a model proxy

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

For Codex, prefer `configHome` pointing at a dedicated home whose
`config.toml` sets `model_provider` to the proxy's provider entry, so model
discovery lists what the proxy serves.

The Engine's login readiness is checked under the same `env` and `configHome`:
a proxy token such as `ANTHROPIC_AUTH_TOKEN` counts as signed in, an
empty-string value masks the inherited key, and Codex's login probe reads the
configured `CODEX_HOME`. Readiness does not apply the app-home opt-in or a
selected credential profile.

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
one. See [Agent configuration](agents.md#agent-configuration).

The chat model picker shows the resolved connection and model. Open it to
search across ready Model connections and Engines, filter by connection or
Favorites, and choose the exact model for this chat. Connections that still
need setup remain visible with their status, but cannot create an invalid
selection.

Favorites, recent choices, hidden models, and model order are saved on this
device. Manage a connection's model list from its detail page. **Use project
default**, **Use agent default**, or the other named reset shown in the picker
restores both the default connection and model.

---

## Developer services and computers

Connections has one clear home for each relationship:

- **Computers** combines saved Station and SSH relationships. Its rows distinguish
  authorization from observed reachability. **Add computer** asks whether to
  pair a device, reach another Station, or run work over SSH.
- **Tools** manages MCP tool-server integrations and their prerequisites.
  Installing a CLI or saving an integration does not by itself prove its login
  or tool availability.
- **Knowledge** manages Knowledge sources; see the [Knowledge guide](knowledge.md).
- When an agent tool depends on a disconnected tool server, **Repair
  connection** opens that exact server. Station does not label the tool
  available or ask the user to add it first.
- A stdio MCP integration can bind a named child environment variable to a
  local Datum reference. The binding is granted to that exact integration and
  materialized only while a fresh child is established; Station-control and
  non-stdio transports reject authored bindings. A stored legacy credential is
  removed only after a fresh bound child succeeds.

## Pairing scopes on this computer

Device-pairing scopes apply to protected HTTP requests even when a desktop app
or CLI talks to Station on the same computer. A **Read-only** Device can view
and stream permitted state, but cannot mutate resources. Remote terminal
WebSockets additionally require `terminal:operate`; **Standard** includes that
scope along with read and operate. The operator changes an existing Device's
scope in place with **Paired devices** → the Device → **Change access**, or on
the Station host with `station environment access scope`; `access:manage` is
never granted this way.

An operator can separately grant **Approve pairing requests** (`access:approve`).
This allows that Device to list, approve, or deny pending requests, without
Device-management access. A pairing notification opens the exact request in
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
