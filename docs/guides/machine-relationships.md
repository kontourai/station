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

**Save an encrypted broker route** — on native Desktop, **Add computer** can
save a Station address, broker address, and exact Station enrollment. A separate
invitation and out-of-band comparison can approve the Station signing key.
Neither action connects the route, signs in, pairs a Device, or grants Project
or compute access. Native application-route selection remains unavailable;
the saved route cannot serve as an ordinary connection or CLI default yet.
See [Connections](connections.md) for route storage, key approval, and the
remaining native transport boundary.

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
the appropriate current membership plus a separately approved Device operate
scope; the UI does not confer either. Base Project views remain metadata-only
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
  — remote target admission and authenticated request forwarding.
- [Fleet completion service](../../src-server/services/inference/fleet-inference-service.ts),
  [routes and receipt policy](../../src-server/routes/inference/fleet-inference.ts),
  and [runtime composition](../../src-server/runtime/routes/runtime-routes.ts)
  — generation without tools and the separately stored serve receipt.
- [docs/reference/connect.md](../reference/connect.md) — device pairing protocol, offers, credentials, revocation.
- Connections hub → **Add computer** — the single entry point that asks which
  relationship you want, then opens the matching flow.
