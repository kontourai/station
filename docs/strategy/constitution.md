# Project Constitution

> This document defines what Station is, what it believes, and what it will not compromise on. It is the identity layer that persists even as features, priorities, and competitors change. Changes to this document require human approval.

*Positioning updated: 2026-11-04, following the owner's personal-first coding,
collaboration, remote-continuity, and extensibility direction.*
*Origin: Station began as a personal workspace with the power of a CLI underneath.
Its direction joins that everyday usefulness with durable shared work and
Kontour's evidence infrastructure.*

---

## Mission

**Station is an open-source coding workspace that grows with you.**

People choose it for their own coding work: use preferred agents, keep project
context and results together, inspect changes and checks, and continue from a
computer or phone. As their work grows, they should be able to invite teammates
into selected Projects and Tasks with clear control over participation and
resources. Plugins let individuals and organizations shape the workspace around
their work through public extension contracts.

Plans, conversations, decisions, changes, and checks belong with the work so the
next person or agent can understand and contribute without reconstructing the
whole conversation. Evidence and receipts help people decide what to accept.
A completed turn, Task status, passed review, and passed gate remain separate
facts. Configured workflows supply the gates and evidence they actually own.

This is product direction, not a declaration that every journey is qualified.
Current implementation and operating limits belong in the owning guides and
release evidence. In particular, paired devices do not prove two-person
collaboration, and plugin support does not establish enterprise readiness.

---

## Why Station exists (the founding bet)

An individual developer must find Station useful before asking anyone else to
join. Coding, remote access, continuity, recovery, and review must form a
coherent everyday experience. A useful Task or result then gives an invitation
a purpose: clarify a plan, review a change, contribute a decision, or continue
work together.

The product hypothesis is that keeping context, attributable activity, and
review evidence together reduces the effort of coordinating agent-assisted
work. Test that with complete personal and two-person coding journeys. Do not
advertise reduced review effort, fewer defects, or lower inference cost without
measuring those outcomes.

Kontour's published primitives provide claims and evidence, process gates,
repository readiness, and review contracts. Station makes those capabilities
useful where people and agents do the work, while each primitive retains its
own semantics and remains independently adoptable.

---

## Core Beliefs

### 1. Evidence over confidence

An agent's claim of completion is an assertion. A verification claim requires
the corresponding current evidence and verdict; a recorded exception must keep
its authority and missing evidence visible. If a claim has not been checked,
state `NOT_VERIFIED`. Ordinary chat and Task lifecycle state do not become
verification claims. Confident prose never substitutes for receipts.

### 2. Primitives stay portable; Station is a consumer, not the authority

Surface, Flow, Veritas, Survey, and Flow Agents are standalone products with public contracts. Station consumes them through those contracts — the same npm packages, MCP servers, and file formats available to anyone. Station never forks a primitive, never holds privileged APIs into one, and never becomes the place where a primitive's semantics live. If Station needs a capability a primitive lacks, the capability is proposed upstream where every consumer benefits. The inverse also holds: when a Station subsystem proves itself as a portable primitive, it is extracted into its own product (see Belief 6).

### 3. A useful workspace, extended through public contracts

The included coding experience must be useful on its own. Core owns work
identity, execution, continuity, authorization, and composition. Plugins add
layouts, agents, tools, knowledge, connections, skills, and purpose-built work
surfaces through the public SDK. They can tailor a personal workflow or an
organization's experience. Supported extension points and their limits belong
in the plugin guide; describe built-in-to-plugin migration at its actual scope.

### 4. Engine choice with explicit capabilities

Station agents and External agents run through one orchestration layer with a unified event model (`CanonicalRuntimeEvent`). Process discipline applies at the common lifecycle seam while deeper prompt and tool enforcement follows the engine boundary Station actually owns. Station declares that depth instead of presenting every engine as uniformly controllable.

### 5. Local-first, user owns their data

All runtime data lives in the user's home directory. No cloud account required. No identifying telemetry without consent. Station may send anonymous, identifier-free aggregate counts to a publisher with clear notice and an always-available off switch; anything keyed to an installation requires explicit opt-in. DO_NOT_TRACK is honored. Evidence, runs, and reports are files the user can version-control. This is shared DNA with every Kontour product — local-first, file-backed, zero lock-in — and is non-negotiable for the compliance-sensitive teams Station serves.

### 6. Stand-alone products are a success condition, not scope creep

When a subsystem of Station matures into something with its own users and its own contract — the runtime orchestration layer, the layout SDK, the ACP bridge — extracting it as an independent Kontour product is the *desired* outcome, mirroring how Surface was factored out beneath Survey and Veritas. Station should get thinner over time, not thicker.

### 7. Extensibility through standards, not opinions

Where standards exist (MCP for tools, ACP for agent communication, OpenTelemetry for observability, MCP-UI for rendered resources), Station adopts them. Where Kontour resource shapes exist (`apiVersion`/`kind`/`metadata`/`spec`/`status`/`proof`), Station emits them. Configuration remains portable in and out.

---

## Non-Negotiables

1. **No privileged access to Kontour primitives.** Station integrates with Surface, Flow, Veritas, Survey, and Flow Agents exclusively through their published contracts. Anything Station can do with a primitive, any third-party consumer can do.

2. **"Done" is a gate verdict, not a vibe.** Any feature that lets an agent mark work complete must route through evidence evaluation or explicitly record the absence of it. No UI affordance may present unverified agent output as verified.

3. **No hardcoded vendor dependencies in core paths.** The core runtime, SDK, and CLI work without any specific cloud or model provider. Provider-specific logic lives in adapters and plugins.

4. **Plugin authors get the same primitives as core.** The SDK is the contract. If core can do it, a plugin can do it.

5. **Every feature accessible via CLI, API, and UI.** If it's only in one surface, it's not done.

6. **CI gates are non-negotiable.** Every change passes lint, typecheck, and tests — and this repo runs under Veritas governance (`npm run veritas:shadow`, backed by `veritas readiness --working-tree` since the 0.5 migration), dogfooding the substrate it builds on.

7. **Security at boundaries.** All user input validated. External context (plugin manifests, project files, agent configs) is treated as untrusted; consequential actions derived from it require explicit approval, not content scanning (see `docs/security/remote-access-threat-model.md`). Secrets never in source.

---

## Product Boundaries

- **A focused coding entry.** Coding is the first complete journey to qualify.
  Broader agent work grows through the same work and extension contracts.

- **Not the authority over Kontour primitives.** Like Console, Station renders and exercises the primitives without owning their semantics. Flow's gate verdicts, Veritas's readiness derivations, and Surface's trust state are computed by those products.

- **Preferred agents remain useful.** Supported engines retain their own tool
  loops. Station adds context, continuity, coordination, and configured evidence
  workflows; it declares the control it actually has over each engine.

- **Collaboration follows work.** Shared plans, decisions, review, and results
  serve a Project or Task. Participation, execution permission, credentials,
  and offered compute are separate choices. Access to a shared result does
  not imply control over the agent that produced it.

- **Not locked to any model provider, and not a closed ecosystem.** Providers for Bedrock, Claude Code, Codex, Ollama, and command-backed engines; MIT-licensed plugins by convention; portable configuration.

---

## Target Users

1. **Individual developers working with coding agents.** Earn everyday use with
   a reliable coding and review experience, project continuity, and useful
   remote access. No team setup is required to get value.

2. **Small teams growing from that experience.** Invite people into selected
   work, share Project and Task knowledge, discuss and review outputs, and
   grant access to resources deliberately. Qualify a real two-person journey
   before presenting its complete delivery loop as supported.

3. **Organizations adapting Station to their workflows.** Extensibility,
   self-operation, and explicit controls support adoption. Enterprise identity,
   managed policy, shared inference, isolation, and operating guarantees each
   require their own supported contracts and evidence.

Kontour dogfoods the same public experience. The reference journey is a real
coding Task: start, delegate, leave and return, inspect changes and checks,
resolve what needs a person, and retain the accepted result. A teammate should
be able to contribute within a defined scope. Reusing reviewed discoveries is
distinct from automatic recall or unqualified reuse of an old agent answer.
