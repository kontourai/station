---
status: current
subject: Bound agents control local device live surfaces through the shared lease
decided: 2026-10-17
evidence:
  - kind: adr
    ref: docs/adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md
  - kind: url
    ref: https://github.com/kontourai/station/blob/main/src-server/services/devices/device-agent-authority.ts
  - kind: url
    ref: https://github.com/kontourai/station/blob/main/src-server/services/devices/device-automation.ts
---

# Agent control of local device live surfaces

Device live surfaces now admit an Agent principal through an in-process grant
minted from the verified station-control caller. Bare principal strings and
caller-supplied grant objects remain insufficient. The caller needs bound
assurance, a recorded Session owner and Project, and current operator or active
Project admin/owner standing. Project admins remain restricted to the operator's
host-qualified device shares; Android serials resolve to current AVD identity.
Membership, caller credentials and shares are rechecked at the authorization seam.

The existing shared lease remains the authority for input: agents may claim an
unclaimed lease or renew their own, never preempt a human or another agent.
Human takeover advances the fence, interrupts queued events and stops producer
sends. Screenshot/accessibility publication also checks its fence after the
observation completes. Input uses the existing allowlisted device-hub transport,
not arbitrary shell commands. Captures retain the existing 8 MiB PNG bound.

The first slice supports local simulator/emulator devices. Opening a stream
makes it available in Device but does not automatically reveal the pane; the
tool reports that limitation. Closing is limited to sessions created by the
same principal, Project and conversation, leaves the device running, and respects
the lease. Shutdown, remote agent hosting and automatic pane reveal are deferred.
The toolchain Agent access setting does not grant this authority. Codex/ACP
credentials with weaker custody remain refused; tool visibility grants nothing.

This changes the human-request-only posture documented for the earlier Device
slice. The guide is the current operating contract. Service-double tests cover
caller admission, revocation, takeover and tool-to-producer delivery; live iOS,
Android, provider, desktop and release qualification require separate receipts.

Related: [#1967](https://github.com/kontourai/station/issues/1967),
[#1970](https://github.com/kontourai/station/issues/1970),
[#1971](https://github.com/kontourai/station/issues/1971),
[#2373](https://github.com/kontourai/station/issues/2373),
[#2376](https://github.com/kontourai/station/issues/2376),
[#2377](https://github.com/kontourai/station/issues/2377).
