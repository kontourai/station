# Computer relationships: pairing vs. remote work

Station's Connections hub has one **Add computer** entry point. It routes to
device pairing, an ordinary Station address, remote work over SSH, or native
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
already-paired device (`station environment access scopes` lists them all with
their meanings). The operator changes them per device on the Station's own
host:

```bash
station environment access devices
station environment access scope <device> --add approval:full-access
station environment access scope <device> --remove approval:full-access
```

The **Paired devices** panel (Station name, top right → **Paired devices** →
the device → **Change access**) does not apply the change from the desktop
app: the app holds a device credential, not the operator credential, and the
route refuses it. Use the host CLI above. Remote operator access is
[a proposal](../design/operator-device-access.md) (#2894).

**Full access** (`approval:full-access`) is the scope that lets a device put a
chat, or an Agent's default, at approval mode `never`: the agent runs with no
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

Shared editing and execution are separate capabilities. The broader target
includes discuss/edit/run/approval/admin participation and approved execution
offers; viewing a shared Task does not open the owner's fleet or private work.

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
