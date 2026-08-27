# Computer relationships: pairing vs. remote work

Station's Connections hub has one **Add computer** entry point. It routes to
device pairing or remote work over SSH based on what the user wants to do.
The flows are not interchangeable — they differ in **direction**
(who reaches whom), **trust model**, and **what becomes possible afterward**.
This guide is the reference those three surfaces link back to.

For the pairing protocol itself (offers, credentials, revocation), see
[docs/reference/connect.md](../reference/connect.md). This guide is about the
relationship model, not the wire protocol.

## The two relationships

**Pair a device** — client reaches server. Another device (a phone, a
browser, a CLI) is granted a scoped credential and drives **this** Station.
You go work *on* this Station from that device: full interactivity, limited
to the access you grant. Station never stores the other device's private
key material; revoking the credential ends the relationship immediately.

**Add a remote computer** — server reaches server. This Station reaches
*another* Station over an SSH tunnel and can **delegate execution** there.
Delegating a task posts the canonical Environment + Agent target to the remote
Station's delegation API over the tunnel — the work runs on that machine, with *that machine's*
own agents, credentials, and workspace, and it persists in *that machine's*
own event store. This is genuine read-write execution, not a read-only
window onto it.

The remote sessions that show up in the home work list are a **read-only
visibility layer** over the second relationship — not a third kind of
access. The read-only-ness belongs to the view, not to the delegation
itself; a delegated task is exactly as read-write as running it locally
would be, it just runs somewhere else.

## Relationship table

| | Direction | Trust model | What it unlocks | Persistence |
|---|---|---|---|---|
| **Paired device** | Client → this Station (the other device drives this Station) | A scoped, revocable device credential. Station never stores the device's private key. | That device can control this Station, within the scope it was granted (interactive, full or read-only preset). | State lives on this Station. The paired device is a client of it, not a copy of it. |
| **Remote computer (SSH)** | This Station → remote Station (delegated execution) | SSH access is the trust — Station uses your system SSH agent and never stores a private key. | This Station can run delegated tasks on that machine, using that machine's own agents, credentials, and workspace. | Execution and its event-store record live on the **remote** machine — persistence follows execution, not the Station that requested it. |
| **Remote session (home work list)** | Read-only view of an SSH-delegated session | Same SSH environment trust as above; no separate credential. | Visibility into work already running remotely — not a way to start or drive it from here. | The session's authoritative record stays on the remote machine; the home list reflects it, it does not hold a second copy. |

## A third thing that is not delegation: fleet inference

Station#1398 adds a relationship that looks like delegation and is
deliberately the opposite of it. If you mark a local model connection as
**contributed to your fleet**, another Station of yours holding an
`inference:invoke` credential can ask this machine to generate tokens on that
model.

The distinction is exactly the one the table above draws, inverted:

| | Where the agent loop runs | Where the tools run | Where the record lives |
|---|---|---|---|
| **Delegated task** (SSH remote computer) | On the remote machine | The remote machine's tools, credentials, workspace | The remote machine's event store |
| **Fleet inference** | On the *asking* machine | The asking machine's tools, files, workspace | The asking machine — the serving machine keeps only its own serve-side record of what it generated |

Only token generation moves. The serving Station never creates a session,
never runs a tool, never touches a file, and never sees your workspace — the
route accepts a list of messages and returns text. "Let my laptop use my
workstation's GPU" is the whole of it, which is why it has its own pairing
scope (`inference:invoke`) rather than riding `orchestration:operate`: that
scope would let the borrowing machine run agents here, and borrowing a GPU
must not imply that.

Both sides are opt-in, separately. Nothing is contributed until the serving
machine's operator turns contribution on *and* names the connections; no
credential can invoke until someone mints a grant with the `inference`
preset. Neither happens by upgrading. See
[docs/design/inference-fleet.md](../design/inference-fleet.md) for the design
and [docs/reference/api.md](../reference/api.md#fleet-inference) for the
route contract.

## Why "delegated work is read-only" is a common but wrong conclusion

The home work list's remote-session cards are read-only by design — they're
a dashboard, not a remote control. It's easy to generalize that into
"delegating work only gives you a read-only view," but that's backwards: the
delegated work itself is full read-write execution on the target machine.
The list is read-only; the execution it is showing you is not.

## See also

- [docs/reference/connect.md](../reference/connect.md) — device pairing protocol, offers, credentials, revocation.
- Connections hub → **Add computer** — the single entry point that asks which
  relationship you want, then opens the matching flow.
