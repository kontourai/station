# Live surface input safety: requirements for a spec-first redesign

> **Reading status: proposal, not implemented.** Current behaviour lives in the
> [module map](../architecture/module-map.md#shared-live-surface) and
> [Browser and devices](../reference/browser-and-devices.md). This note records
> what an attempted redesign learned, as requirements for a specification
> written before any code.

## Why this exists

A viewer of a live surface (a Browser page, a device screen) sends pointer,
touch and key input over HTTP while a frame stream shows the result, and
control can pass between people, devices and Agents at any moment. An attempt
to make that input path safe grew, round by round, into control lineage,
server-issued viewer identities, attested epoch causes, a server-owned release
loop and a stuck-surface state. Nine review rounds each found new failures in
the previous round's mechanism. It was withdrawn so the surrounding work could
ship; the shipped path is the earlier, simpler model.

The lesson is about method: every fix answered one observed failure, and the
interactions between fixes produced the next ones. The redesign must start
from a written model of the states below, with each requirement traced to a
test that reaches the real registry, routes, viewer and producers.

## Failure classes observed

1. **Cross-control replay.** Input created while one controller held the
   surface was sent after control changed hands: queued input, a held-back
   touch press, a kept gesture offered for Retry, or a release whose press
   belonged to the previous holder (a release sent then is fresh input that
   takes control back).
2. **Causality attribution.** The viewer could not tell its own takeover from
   someone else's: a second tab of the same person and device, a claim
   answered late, an answer from an older Station behind the same address, or
   a forged or replayed identifier. Inferring causality on the client from
   epochs and arrival order failed in each case; attestation by the server had
   to be atomic with the lease it describes.
3. **Lost acknowledgements.** An answer can be lost after the host applied the
   input. Retrying it applies it twice; dropping it loses a release. A lost
   answer is indeterminate, never success or failure.
4. **Stuck keys and buttons.** A key-up or touch lift can fail, time out or be
   refused while the press stays down on the surface. Any account of what is
   held that forgets a release before the producer confirmed it (in the
   registry or in a producer) lets the next controller type through a held
   modifier.
5. **Release ordering.** A release request that is retried, delayed, or
   arrives after the same key was pressed again must not release the newer
   press. Identity of a press must be carried on the wire; a controller
   identity alone cannot tell two holds by the same controller apart.
6. **Carry-over custody.** Held input must have one owner across a change of
   control, a viewer disconnecting and reconnecting, a stream replaced for new
   parameters, a target change, unmount, and the surface being unregistered and
   registered again. Cleanup owned by a viewer is lost when that viewer leaves;
   cleanup owned by a surface is lost when the surface is replaced.
7. **Readiness versus failure.** "Not yet released", "release failing for a
   while" and "release will not succeed without a reset" are different states
   with different remedies (wait, keep refusing, reset). Waiting forever on a
   permanently failing producer locks out every later controller; giving up
   silently forgets a held key.

## Requirements for the spec

- Define the state machine for one surface's input: holder, epoch, fence,
  what is held (per controller and per press), and the pending, failing and
  needs-reset states of releasing it. Name only states something computes.
- The server is the single account of what is held. A press counts from when
  it is sent; a release only once the producer confirms delivery. Producers
  follow the same rule for their own state.
- Every message that can arrive late or twice (input, claim, release, and
  their answers) names what it is about, so a late or repeated one can act
  only on what it was issued for.
- Who caused an epoch is attested by the server, read at the same point as the
  lease it describes, and told only to the viewer it concerns.
- Cleanup has an owner that outlives viewers and survives a surface being
  replaced, with bounded retries, a terminal state, and a reset path that
  confirms what was held is released before input is taken again.
- Input is refused while a release is owed, and the refusal says which of the
  states above applies; the order of refusals (stale view, lost control,
  release owed) is part of the contract.
- The protocol is versioned behind a capability, and both directions of
  version skew (newer viewer, older host and the reverse) are specified.
- Every requirement has a test through the real seams, and fault injection
  proves each one fails when its behaviour is reverted.
