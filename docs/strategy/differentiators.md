# Differentiators

This document defines Station's durable differentiation and the evidence
boundaries for product claims. It deliberately does not mirror issue status or
name a feature as “next”; query GitHub and current source for live state.

These are product priorities and constraints. The linked implementation and
evidence routes establish which parts a particular feature currently delivers.

## The One-Line Differentiation

**Station keeps coding work attached to a Task across agents, Sessions, and
paired devices.** An individual developer can return to the same work from
another paired device. The team vision is an interactive room for that Task:
people and agents share knowledge, converse, and inspect activity and results
within explicit permissions. Plugins adapt the workspace to personal and
organizational workflows.

The product hypothesis is less effort reconstructing context and coordinating
work. Evidence and receipts support the decision to accept a result. Qualify
the personal coding loop and the real two-person journey separately; the
existence of their components does not establish a complete experience.

The outcome line for product copy is “Know what your agents built — and why it
was allowed to ship.” It says in plain language what the
[constitution's mission](constitution.md#mission) promises: evidence and
receipts that help people decide what to accept. The “why” is the checks,
evidence and receipts attached to the work, not a verdict Station invents. Use
the line where those receipts are visible. It does not claim that every Task
has a gate, or that a passed check is an approval.

The public promise is “Code from anywhere. On your own, or with your team.”
This sentence is its single source. The README tagline, the Pages home title,
descriptions, social tags and headline, and the `corpus.json` purpose and
tagline repeat it word for word, and `npm run docs:public:hygiene` fails when
one of them drifts. Change the wording here first. The GitHub repository
description is checked by hand, as
[Verify the change](../guides/documentation.md#verify-the-change) describes.
Use concrete supporting copy and keep current sharing limits in the owning
guides and team FAQ. This wording does not qualify a complete two-person
workflow.

## Message Hierarchy

1. **Everyday coding usefulness.** Choose an agent, move a real project Task
   forward, inspect the result, and return from another device.
2. **A shared Task room.** People and agents work from shared knowledge,
   talk with each other and the room’s available agents, and see the work
   happening. This is the team design to qualify with a two-person journey. Access to an output is separate from control
   over the agent, credentials, or compute that produced it.
3. **An adaptable workspace.** Public plugin contracts support personal
   customization and purpose-built team surfaces.
4. **Inspectable results.** Configured workflow checks, evidence, receipts,
   and visible gaps help participants decide what to accept.

“Command your Station” remains an optional brand line. “Work ships with receipts” expresses
the evidence discipline. Neither replaces the coding-workspace description or
establishes current team or verification guarantees. Public headings should
name what developers can do rather than repeat a positioning slogan.

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

- Project membership, personal paired-device access, shared Task views, shared
  agent execution, and hosted isolation are separate capabilities. Describe
  the supported path and its limits; do not infer complete team delivery from
  presence, a room, or an invitation.
- Task memory and human-reviewed promotion into Project knowledge do not prove
  automatic next-Task recall. Reusing agent output requires current access,
  relevant context, and evidence appropriate to the result.
- Plugins are a supporting adoption benefit. They do not establish enterprise
  readiness, a shared inference service, or arbitrary provider replacement.

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
- [Testing](../guides/testing.md) and [root agent instructions](../../AGENTS.md)
  — current candidate verification, merge queue and disclosure rules.
- GitHub issues and pull requests — live gaps, scope, ownership, and delivery
  state.

## Investment Heuristics

- Earn individual adoption with one coherent coding, remote-continuity, and
  review journey; make a real two-person journey the collaboration proof.
- Prefer features that help people finish, understand, or review project work.
- Keep personal setup small and reveal sharing and resource controls when needed.

- Close integrity gaps before increasing trust rhetoric.
- Prefer user jobs that reuse the Task, gate, evidence, and receipt loop over
  generic feature breadth.
- Keep advanced transport and protocol detail available for diagnosis without
  making it the primary product vocabulary.
- Extract a subsystem only when another consumer and a stable public contract
  justify independent ownership.
- Preserve the ratified Station/Console split unless new evidence changes the
  decision.

## Keep Public Messaging Aligned

The [constitution](constitution.md) owns audience and durable product direction.
Implementation, owning guides, and release evidence establish availability.
The README and public sites translate those sources for their readers.

For a material claim, record its scope, owning source revision, limitations,
and review date in the existing documentation or marketing claim inventory.
Use the documentation impact and review-ledger checks when those sources change.
Re-review affected public copy before refreshing a claim; a package-version
change or unchanged source hash is not a semantic review. Keep engine, device,
and two-person acceptance evidence separate from source inspection. This is the
maintenance contract; cross-repository automatic claim synchronization requires
separate implementation and must not be described as already enforced.

## Explicit De-Emphasis

| Capability | Disposition |
| --- | --- |
| Generic “open agent platform for everyone” positioning | Retired. Extensibility is an architecture property; trustworthy agent work is the product claim. |
| Layout flexibility by itself | Table stakes. Invest where a vertical proves a user job and reuses the trust loop. |
| Scheduler, generic retrieval, notifications, and voice | Supporting capabilities, not the primary differentiation. |
| Console/Station UI merger | Preserve the ratified product split unless its decision triggers are met. |
