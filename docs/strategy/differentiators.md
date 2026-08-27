# Differentiators

This document defines Station's durable differentiation and the evidence
boundaries for product claims. It deliberately does not mirror issue status or
name a feature as “next”; query GitHub and current source for live state.

## The One-Line Differentiation

Station is the agent workspace where the work and the reason it is allowed to
advance stay together: Task context, engine events, gates, evidence,
route-backs, exceptions, readiness, and receipts.

That is narrower and more defensible than “one UI for every agent.” Supporting
multiple engines matters because it gives the trust loop a common workspace;
the differentiator is the visible, testable trust loop itself.

## Durable Advantages

1. **Trust state is part of the work surface.** Gate outcomes, missing
   evidence, route-backs, exceptions, and readiness do not have to be
   reconstructed from a transcript or CI badge.
2. **The engine abstraction has an enforcement purpose.** Station applies
   lifecycle policy at the common seam it owns and declares where an external
   engine keeps deeper control.
3. **Tasks preserve work identity.** Project binding, Sessions, files,
   artifacts, evidence, and receipts can remain correlated across execution
   episodes.
4. **Plugins reuse one trustworthy chassis.** Purpose-built work surfaces can
   share Projects, agents, Providers, trust UI, and receipts without copying
   the contracts owned by other Kontour products.
5. **Local-first is an operating property.** Data roots, Provider connections,
   temporary homes, pairing grants, and optional export endpoints are explicit
   product contracts.

## Claim Boundaries

- A Session attached to a gate or workflow is not automatically proof that its
  receipts are current. Fresh evidence and a current verdict remain required.
- External engines own their own prompt assembly and tool loop. Station must
  describe enforcement depth honestly instead of implying uniform
  pre-execution control.
- Station composes published Kontour contracts. It does not become a second
  authority for Flow gates, Surface trust state, Veritas readiness, Knowledge
  records, Survey review, or Console projections.
- A plugin example, draft branch, issue, or historical dogfood report is not a
  claim that the corresponding end-user experience is currently shipped.
- Local verification does not prove hosted CI, release publication, or a Pages
  deployment.

## Evidence Routes

Use the owning evidence rather than copying status into this document:

- [Kontour integration surface](kontour-integration-surface.md) — published
  contracts Station consumes.
- [Agent and engine design](../design/agent-engine-unification.md) — current
  ownership and capability model, including declared policy depth by engine
  seam.
- [Module map](../architecture/module-map.md) — implementation ownership and
  focused proof routes.
- [Local merge readiness](local-merge-readiness.md) — candidate verification
  and disclosure rules.
- GitHub issues and pull requests — live gaps, scope, ownership, and delivery
  state.

## Investment Heuristics

- Close integrity gaps before increasing trust rhetoric.
- Prefer user jobs that reuse the Task, gate, evidence, and receipt loop over
  generic feature breadth.
- Keep advanced transport and protocol detail available for diagnosis without
  making it the primary product vocabulary.
- Extract a subsystem only when another consumer and a stable public contract
  justify independent ownership.
- Preserve the ratified Station/Console split unless new evidence changes the
  decision.

## Explicit De-Emphasis

| Capability | Disposition |
| --- | --- |
| Generic “open agent platform for everyone” positioning | Retired. Extensibility is an architecture property; trustworthy agent work is the product claim. |
| Layout flexibility by itself | Table stakes. Invest where a vertical proves a user job and reuses the trust loop. |
| Scheduler, generic retrieval, notifications, and voice | Supporting capabilities, not the primary differentiation. |
| Console/Station UI merger | Preserve the ratified product split unless its decision triggers are met. |
