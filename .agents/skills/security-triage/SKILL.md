---
name: security-triage
description: Triage a dependency advisory, CodeQL SARIF finding, or secret-scanner hit. Reproduce, assess against the named threat model, and record a disposition with rationale. Do not fix without naming the threat model the fix serves.
---

# Security triage

Own the disposition of one finding end to end. Advisory-only posture ends
where you can reproduce; dispositions are maintainer judgment when the fix
changes a public contract or a trust boundary.

## Procedure

1. **Reproduce or bound.** Reach the finding through its real entry point
   where feasible; when you cannot, say exactly what bounds the claim
   (version ranges, SARIF rule, reachability evidence). A scanner verdict is a
   lead, not a disposition.
2. **Name the threat model.** State who the defense is against and what it
   cannot defend. A same-user actor, an operator, and a remote unauthenticated
   caller are different models; a finding that only matters to one of them is
   not hardened by gates aimed at another.
3. **Assess exploitability against that model.** Prefer the least restrictive
   effective safeguard. Security is a tradeoff, not a maximum: name what a
   fix costs in capability or lockout risk.
4. **Disposition with rationale.** Fix (owning seam, not a symptom guard),
   accept-with-rationale (disclosed gap, named follow-up), or escalate to a
   maintainer decision. Record the evidence in the issue; a scanner count is
   not evidence.

## Boundaries

- Do not widen an allowlist, silence a scanner, or edit a baseline to make a
  finding go away; those are owner decisions with attestation.
- Do not paste secret values into issues, logs, or PRs; describe shape and
  location, and rotate through the owning channel.
- Dependency bumps and baseline changes that alter trust surfaces are
  maintainer-gated even when the reproduction is yours.
