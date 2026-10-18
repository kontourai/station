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
Membership, caller credentials, the operator Agent access opt-in, and shares are
rechecked at each surface authorization. Input rechecks the grant before every
event in a batch; a single text event retains the producer's per-send lease
fencing and bounded dispatch.

The existing shared lease remains the authority for input: agents may claim an
unclaimed lease or renew their own, never preempt a human or another agent.
Operations reserve a per-device, per-agent in-flight count before authorization.
Overlapping calls by the same agent share control; only the last completing call
releases the recorded fences in `finally`. Old fences cannot release a human or
newer controller. An idle agent does not retain the lease for its TTL. Responses
report the lease after that completion/release, which may still name the agent
when another operation remains active. Human takeover advances the fence,
interrupts queued events and stops producer sends. Screenshot/accessibility
publication also checks its fence after the observation completes. Input uses the existing allowlisted device-hub transport,
not arbitrary shell commands. Captures retain the existing 8 MiB PNG bound.

Pointer and key gestures must be complete within one `device_input` batch: send
down/move/up or key down/up together. Unmatched down or up returns
`incomplete-gesture` with zero events delivered, including any earlier events in
that batch. Concurrent input batches are serialized per device, while observations remain
concurrent. A dispatch failure releases its fence immediately to cancel uncertain
held input; overlapping operations on that fence may then report `interrupted`.
Cross-call holds, drags and held keys are unsupported; there is no
wait/duration event for a long press. This deliberately avoids retaining a lease
and hidden held input between calls. Before dispatch, the entire batch's kinds
are checked against the producer's declared capabilities; an unsupported kind
returns `unsupported-input` before any event is sent. Platform-specific failures
can still occur during dispatch and report the accepted count.

The first slice supports local simulator/emulator devices. Opening a stream
makes it available in Device but does not automatically reveal the pane; the
tool reports that limitation. Closing is limited to sessions created by the
same principal, Project and conversation, requires current operator standing,
leaves the device running, and respects the lease. Operator standing is checked
before claiming control or renewing idle grace. Close ends the shared session
for everyone, matching the operator-only human DELETE route; Project admins may
observe and drive shared devices but may not end their shared session. Shutdown,
remote agent hosting and automatic pane reveal are deferred.
The existing operator-controlled toolchain **Agent access** setting is the
explicit opt-in for these live tools as well as managed agent-device tooling.
It defaults off and is re-read on each call and surface authorization. Shared
station-control registration alone grants no access; disabling the setting
refuses later events and suppresses in-flight observation publication. This
uses a host-wide operator opt-in rather than a new per-agent switch. Codex/ACP
credentials with weaker custody remain refused; tool visibility grants nothing.

Accessibility uses the same DeviceToolsService read and 500-element/256-KiB
truncation as the human Tools drawer. Keeping one bounded observation owner
avoids contradictory screen representations and unbounded agent responses;
truncated output is explicit and does not imply a complete hierarchy.

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
