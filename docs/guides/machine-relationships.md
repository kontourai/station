# Computer relationships: pairing vs. remote work

Station's Connections hub has one **Add computer** entry point. It routes to
device invitations, a Station connection, remote work over SSH, or native
saved broker-route preparation based on what the user wants to do. The flows differ in **direction**
(who reaches whom), **trust model**, and **what becomes possible afterward**.
This guide explains those relationships; [Connections](connections.md) owns the
current setup steps.

For the pairing protocol itself (offers, credentials, revocation), see
[docs/reference/connect.md](../reference/connect.md). This guide is about the
relationship model, not the wire protocol.

For the topology vocabulary that keeps a physical machine, Station instance,
Device, Project binding, room authority, and execution offer separate, see
[Station topology](../design/station-topology.md).

## Device access and remote work

**Connect another Station** identifies one destination, then lets you request
Device access, Station peer access, or both. The grants have different holders
and independent approval. Saving Device access preserves an existing selected
Station; peer enrollment stores its credential only on the controlling server.
The peer ceremony requires that server's operator authority and the receiver's
trusted approval. It does not elevate an ordinary paired device.

**Pair a device** — device reaches Station. Another device (a phone, a
browser, a CLI) is granted a scoped credential and drives **this** Station.
You go work *on* this Station from that device: full interactivity, limited
to the access you grant. Station never stores the other device's private
key material. Revocation prevents future credential use; it does not undo
already-completed effects or prove an active remote job was cancelled.

**Add a remote computer** — this Station reaches another Station and can
**delegate execution** there. Enrolled peers use a scoped outbound credential;
an SSH tunnel is another transport for those authenticated requests.
Delegating a task posts the canonical Environment + Agent target to the remote
Station's delegation API over the selected authenticated route — the work runs on that machine, with *that machine's*
own agents, credentials, and workspace, and it persists in *that machine's*
own event store. The remote Agent can use tools and change its workspace
within that Station's grants, confinement, and approval policy.

The remote sessions that show up in the home work list are a **read-only
visibility layer** over the second relationship — not a third kind of
access. The list does not control the work. The remote Station owns execution
and applies its own policy to the delegated request.

The current SSH creator calls the server's environment probe and create APIs.
It saves an SSH host alias, remote project path, and optional remote Station
port. SSH user, SSH port, and key selection come from the server machine's
OpenSSH configuration. This works through the server; it is not the retained
native SSH-launcher API. An ordinary saved Station address is a connection
profile, not an SSH execution environment or a new grant.

**Save an encrypted broker route** — in a native shell, **Add computer** can
save a Station address, broker address, and exact Station enrollment. A separate
invitation and out-of-band comparison can approve the Station signing key.
Neither action connects the route, signs in, pairs a Device, or grants Project
or compute access. After the separate Device setup, **Use this Station** selects
a configured route for account sign-in and bounded health and member Project
reads. Operator Workspace resources and contribution writes remain unsupported;
the CLI still excludes native broker routes from defaults and explicit targets.
See [Connections](connections.md) for the setup steps and the separate fresh,
public application, physical-device and release qualification limits.

### What a paired device may do, and full access

A paired device holds scopes: `orchestration:read`, `orchestration:operate`,
`terminal:operate`, and the elevated ones the operator adds to an
already-paired device, or keeps when approving a request that asked for
`coding:exec` or `approval:full-access`, as the Station app does (**Limit
access** leaves them out; `station environment access scopes` lists them all
with their meanings). The operator can change them per device on the Station's
own host, or explicitly grant `access:devices` to an already-paired administrator.
That device can use the same commands remotely with `--station=<name>` and its
own credential. Without a global install, prefix these with
`npx @kontourai/station-cli@<tag>` (`nightly` for a nightly Station, otherwise
`latest`); a full-access refusal's command already includes the prefix. A
device paired by an older Station may also hold `access:manage`, which no device
can be granted again; the first change removes it and says so:

```bash
station environment access devices
station environment access scope <device> --add approval:full-access
station environment access scope <device> --remove approval:full-access
```

The **Paired devices** panel (Station name, top right → **Paired devices** →
the device → **Change access**) uses its authenticated credential. A client with
**Manage device access** (`access:devices`) can administer devices remotely.
Only the operator can grant or remove that permission; **Skip approval prompts**
(`approval:full-access`) alone cannot change device grants. Operator passkey
sign-in adds read-only inventory access in S3; per-action step-up remains
[a separate S4 proposal](../design/operator-device-access.md) (#3257).

A device tied to a person (a verified Tailscale identity or an account) is
also capped by that person's **Station group** (#3557). In **Member**, the
default, it may use only Standard (`orchestration:read orchestration:operate
terminal:operate`), whatever else it was granted; in **Admin** it may also
use `coding:exec`, `approval:full-access`, `access:approve`, `access:devices` and
`consent:decide`. The stored grant is never rewritten, so moving the person
back to Admin restores it. Moving a person to Member re-authenticates their
devices' live terminal and voice connections and takes back any full access
they had given, as removing the scope does. The operator changes a group
on the People page (Settings, then Devices) or with
`PUT /api/pairing/people/:principalId/group`; there is no CLI command for it
yet. When a Member's device asks for full access, the refusal says the group
is what stops it and points the operator at People, adding the device's own
`--add approval:full-access` command only if its grant lacks it too.

Account-bound guest principals remain restricted by their separate route
allowlist: it excludes device administration even with an Admin group and an
`access:devices` grant. Use an operator-approved personal Device or the host
operator channel. The CLI reports this policy refusal distinctly.

**Full access** (`approval:full-access`) is the scope that lets a device put a
chat, an Agent's default, or a Project's new-chat approval mode at approval mode
`never`: the agent runs with no
sandbox and no approval prompts, as the operator. A device without it that
asks for full access is refused (`approval-full-access-not-granted`). The
refusal names the device (its short id, and its name shown as plain text),
the Station that refused, and the exact command above, and it separates what
the caller asked for from what only the operator can grant. In a chat the
message is not sent and the chat is not marked failed: the draft returns to
the composer, with an explicit choice to send it at the chat's current mode. An Agent never gets full access through any
grant; a person has to choose it. Nothing is retried at another approval mode.

Removing the scope, whether with `--remove`, `--set` or in the desktop app,
takes back the full access that device had already given (owner decision,
#1796). Revoking the whole device does the same. For every conversation the
device had put at full access (its own full-access decision, its Auto
decision on a session it had unconfined, or a session it started at full
access), Station records a new decision of **Ask**, attributed to the
operator's revocation. Nothing is deleted from the conversation's history.

The sessions its grant had unconfined also run confined again (inside the
workspace), from their next turn, without restarting the engine. Station
checks the grant each time it hands the engine a posture: at every turn while
a decision stands, at the session's next start, and on the first turns after
the grant was taken back even when no decision stands (for example a session
at full access only because of its Agent's or the Station's default). A turn
already running finishes, but it cannot be given new instructions by steering:
Station refuses the steer and keeps the message for the next turn, which is
confined.

The command lists each session whose engine is still running unconfined as
"still unconfined" until its next turn, and a conversation whose sessions are
stopped or have already taken a confined turn as re-confined. The desktop app's notice offers **Stop now** on each running
session, which stops its engine at once; its next start is confined.

Some conversations stay at full access, and the command lists them without
changing them:

- a full-access decision the operator or another device made;
- another person's session whose full access comes only from its Agent's or
  the Station's default;
- a decision recorded before Station kept track of who made it;
- a live session started at full access before Station recorded who granted
  it ("unattributed host start"). At most 50 of these are listed, with the
  total.

The scope command prints both lists, and the desktop app shows the same after
the change.

Only the operator in person or a paired device can give a session full access
when it starts. A caller that may choose full access but is neither (for
example an account session that holds the scope) now starts its new sessions
confined. They run at full access only if a full-access decision is recorded
for the conversation, and that decision's actor is recorded as unknown, not
as a device, so revoking a device does not reset it.

### People, groups and access tokens

A device approved with a person's verified identity or account is tied to that
person (#3557). **Settings → Devices → People**, shown only to the operator,
lists everyone with a tied device, a group or a token, what each tied device
may use, and their personal access tokens.

A person's **group** caps every device tied to them. **Member**, the default,
allows Read, Operate and Terminal. **Admin** also allows `coding:exec`, full
access, approving other devices and deciding consent requests. A device keeps
what it was granted; when its person's group removes part of it, People shows
the device as **Limited by Member group**. Changing a group needs the operator
credential: the desktop app's local grant can view People but its changes are
refused.

When a Member's device asks for full access, the refusal says the Member group
stops it. The remedy has two steps, not two options: the operator makes the
person Admin on People, then, if the device's own grant lacks
`approval:full-access`, runs the host command the refusal prints.

A **personal access token** (`stp_…`) lets a script or integration act as a
person, with Read or Read & operate, expiring after 30 days, 90 days, a year, or
never. It never exceeds what the person's group allows. The operator makes and
revokes anyone's tokens on People; a person manages their own under **Settings
→ Devices → Pairing → Your access tokens**, from a device tied to them (the
panel does not appear on other devices). The secret is shown once, when the
token is made. A person tied by a Station local account can hold tokens too
(#3586): the token acts as the account without a browser session, sees only
the Projects the account is a member of, and stops working when the account
is disabled, signed out everywhere or deleted; re-enabling the account does
not bring back tokens made before it was disabled. No token opens a terminal
or voice session. With any other sign-in provider,
account-tied people cannot hold tokens. See the [API reference](../reference/api.md#people-and-station-groups).

## Relationship table

| | Direction | Trust model | What it unlocks | Persistence |
|---|---|---|---|---|
| **Paired device** | Device → this Station (the other device drives this Station) | A scoped, revocable device credential. Station never stores the device's private key. | That device can control this Station, within its actual granted scopes. | State lives on this Station. The paired device reaches it; it is not a copy of it. |
| **Remote computer (SSH)** | This Station → remote Station (delegated execution) | OpenSSH uses the configured agent or key file to authenticate the tunnel; protected Station APIs still require a separately enrolled scoped credential. | This Station can run delegated tasks on that machine, using that machine's own agents, credentials, and workspace. | Execution and its event-store record live on the **remote** machine — persistence follows execution, not the Station that requested it. |
| **Remote session (home work list)** | Read-only view of sessions on a connected remote Station, including work started there independently | The same authenticated peer credential over the connected SSH tunnel; forwarding alone grants no read authority. | Visibility into remote work; this list does not start or control it. | The session's authoritative record stays on the remote machine; the home list reflects it. |

## A third thing that is not delegation: fleet inference

Fleet inference, introduced in archive#1398, shares a contributed model
connection. That connection can use a local or hosted provider. Another
Station holding an
`inference:invoke` credential can ask this machine to generate tokens on that
model.

The distinction is exactly the one the table above draws, inverted:

| | Where the agent loop runs | Where the tools run | Where the record lives |
|---|---|---|---|
| **Delegated task** (enrolled remote Station) | On the remote machine | The remote machine's tools, credentials, workspace | The remote machine's event store |
| **Fleet inference** | On the *asking* machine | The asking machine's tools, files, workspace | The asking machine — the serving machine keeps only its own serve-side record of what it generated |

Only text generation moves. The serving path does not create an Agent Session
or run tools, and it does not receive filesystem access to the caller's
workspace. It does receive the submitted message text, which can contain code
or other workspace content; the configured provider processes that text. The
serving Station also writes a bounded serve receipt. A local GPU is one use
case, but a contributed hosted connection can incur provider charges.

The separate `inference:invoke` scope authorizes this completion API.
`orchestration:operate` alone does not, and an inference grant does not grant
Agent execution. A credential holding `inference:invoke` is refused permission
to change `fleetContribution` through the application configuration route.

Both sides are opt-in, separately. Nothing is contributed until the serving
machine's operator turns contribution on *and* names the connections; no
credential can invoke until someone mints a grant with the `inference`
preset. Neither happens by upgrading. See
[docs/design/inference-fleet.md](../design/inference-fleet.md) for the design
and [docs/reference/api.md](../reference/api.md#fleet-inference) for the
route contract.

## Why "delegated work is read-only" is a common but wrong conclusion

The home work list's remote-session cards show remote state. Delegation is a
separate request that can start an Agent and modify files on the target,
subject to its policy. Read-only presentation does not reduce that execution
authority, and the existence of a remote card does not grant it.

## Project sharing is a separate relationship

Project membership controls a person's participation, separately from the route
their Device uses. The account invitation and approved account-bound Device
flow already provides restricted Project catalogue/detail views and bounded,
read-only access to explicitly published shared Task lists, history, and
documents. Current membership and publication are rechecked through response
delivery. A collaborator does not need to contribute a computer, checkout, or
provider credentials to read that shared work.

The guest entry also mounts Project access controls. Administration requires
the appropriate current membership plus a separately approved Device
`orchestration:operate` or `relay:manage` scope; the UI does not confer either.
Base Project views remain metadata-only
and omit local paths, provider/model configuration, knowledge settings, and
layouts. See [deployment authentication](deployment-authentication.md#browser-invitation-entry)
and its linked source owners for the current guest boundaries.

Project Rooms support shared discussion, presence, revision-checked notes and
explicit Agent requests. Each action requires current Project membership and
independent transport permission. Agent execution also requires current host
execution permission and a verified Project execution root. Room participation
does not grant general Project mutation, repository setup, fleet access or
access to private work. Broader execution offers and independent-human
qualification remain separate work.

Explicit Room Agent requests capture only Task summaries already shared to the
Project, even for an operator. The immutable snapshot includes Task/share
identities, title, status and observation time, with shared-subset coverage;
it includes no private Task counts, descriptions or inferred goals. At most
16 summaries and 4 KiB of Task evidence fit within the existing context budget.
Unavailable or omitted evidence is labeled rather than treated as an empty
Project. Exact share and Task incarnations are checked before dispatch and
publication. Short owner fences coordinate TaskGraph, sharing and Room writes;
no such lock spans provider execution. Unsharing can withhold a pending answer,
but does not retroactively redact text already published in the Room.

A Device connects to a Station and authenticates as a principal. Several
Devices may represent one person through an explicitly approved binding; a
network address or device display name never establishes that relationship.
See [membership #488](https://github.com/kontourai/station/issues/488) and the
[two-human acceptance journey #497](https://github.com/kontourai/station/issues/497).
The implemented read and administration surfaces do not establish the full
independent-human journey. Physical two-person and browser/native qualification
remain separate acceptance work.

## See also

- [Add computer](../../src-ui/src/views/connections-hub/AddMachineModal.tsx)
  and [SSH creator](../../src-ui/src/views/connections-hub/SshComputerCreatorDialog.tsx)
  — the actual UI dispatch and server-owned probe/create calls.
- [Remote session reader](../../src-server/services/ssh/remote-session-reader.ts)
  — authenticated reads, two-second per-peer deadline, bounded fan-out, and
  separate unavailable/authentication-required results.
- [Delegation caller](../../src-server/tools/station-control-delegation.ts)
  — remote target admission and authenticated request forwarding. A
  station-control tool names the saved Environment to this Station's own route;
  the route forwards through the
  [remote forwarder](../../src-server/services/remote-stations/remote-station-forwarder.ts),
  which attaches the peer bearer in-process and bounds each request to the
  other Station.
- [Fleet completion service](../../src-server/services/inference/fleet-inference-service.ts),
  [routes and receipt policy](../../src-server/routes/inference/fleet-inference.ts),
  and [runtime composition](../../src-server/runtime/routes/runtime-routes.ts)
  — generation without tools and the separately stored serve receipt.
- [docs/reference/connect.md](../reference/connect.md) — device pairing protocol, offers, credentials, revocation.
- Connections hub → **Add computer** — the single entry point that asks which
  relationship you want, then opens the matching flow.
