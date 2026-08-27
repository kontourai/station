# Project Constitution

> This document defines what Station is, what it believes, and what it will not compromise on. It is the identity layer that persists even as features, priorities, and competitors change. Changes to this document require human approval.

*Last updated: 2026-08-27*
*Origin: Station began as a personal side project — exploring what a UI-based workspace could be with the power of a CLI underneath — and grew into an agentic testing ground as MCP, ACP, and the surrounding standards emerged. This constitution reframes that foundation around Kontour's trust primitives.*

---

## Mission

**Station is the agent workspace where work ships with receipts.**

It is Kontour's reference agent workspace: the interactive surface where agentic work is run, observed, evidence-gated, and proven. Every other Kontour product makes AI work inspectable after the fact — Station is where that work *happens*, with the inspection built into the room.

It is not a chat wrapper. It is not an IDE. It is not another agent workbench competing on features. It is the place where "the agent says it's done" becomes "the run's gates passed, and here is the evidence."

---

## Why Station exists (the founding bet)

The agent-workbench category is saturated — flexible UIs, multi-provider chat, MCP integration are commodities being absorbed by the harness vendors themselves. Competing there on features is unwinnable.

What no workbench offers is **trust infrastructure**: enterprises cannot adopt agents without audit trails, and every tool's answer to "is this work actually done?" is usually the agent's own confidence. Kontour built the substrate that answers this — Surface (claims + evidence), Flow (evidence-gated process), Veritas (repo standards + merge readiness), Survey (review chains), Flow Agents (process discipline). What Kontour lacked was a workspace it controls end-to-end.

Station is both halves joined: a workspace foundation built up through years of hands-on exploration, repositioned on Kontour's primitives. The moat is not the UI — UIs are copyable. The moat is the evidence substrate underneath it, which a competitor would have to rebuild from scratch to follow.

---

## Core Beliefs

### 1. Evidence over confidence

An agent's claim of completion is an assertion, not a fact. Work in Station ends in one of three states: gates passed with fresh evidence, an exception explicitly accepted by a human, or `NOT_VERIFIED` stated plainly. There is no fourth state where confident prose substitutes for receipts. This is the Kontour ethos (assert → observe → resolve) applied to live agent sessions.

### 2. Primitives stay portable; Station is a consumer, not the authority

Surface, Flow, Veritas, Survey, and Flow Agents are standalone products with public contracts. Station consumes them through those contracts — the same npm packages, MCP servers, and file formats available to anyone. Station never forks a primitive, never holds privileged APIs into one, and never becomes the place where a primitive's semantics live. If Station needs a capability a primitive lacks, the capability is proposed upstream where every consumer benefits. The inverse also holds: when a Station subsystem proves itself as a portable primitive, it is extracted into its own product (see Belief 6).

### 3. Plugins are the product, core is the foundation

A founding belief, sharpened by the pivot. The core provides runtime, streaming, routing, and a provider registry with zero domain logic. Vertical surfaces — a gated coding workspace, a Survey review workbench, a release-readiness console — are plugins built on the SDK. The flagship plugins are now evidence-shaped: the proof that "any vertical is a plugin" comes from shipping Kontour's own verticals as plugins first.

### 4. Any engine, one gate

Station agents and External agents run through one orchestration layer with a unified event model (`CanonicalRuntimeEvent`). Process discipline applies at the common lifecycle seam while deeper prompt and tool enforcement follows the engine boundary Station actually owns. Station declares that depth instead of presenting every engine as uniformly controllable.

### 5. Local-first, user owns their data

All runtime data lives in the user's home directory. No cloud account required. No telemetry without consent. Evidence, runs, and reports are files the user can version-control. This is shared DNA with every Kontour product — local-first, file-backed, zero lock-in — and is non-negotiable for the compliance-sensitive teams Station serves.

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

## What Station Is NOT

- **Not another agent workbench.** Chat, layouts, and multi-provider support are table stakes Station inherits, not the value proposition. The value is the trust layer no workbench has.

- **Not the authority over Kontour primitives.** Like Console, Station renders and exercises the primitives without owning their semantics. Flow's gate verdicts, Veritas's readiness derivations, and Surface's trust state are computed by those products.

- **Not a replacement for Claude Code, Codex, or Kiro.** Those agent apps remain first-class Flow Agents targets and first-class engines *inside* Station. Station is where their work gets orchestrated and gated, not a bid to replace them.

- **Not an IDE.** Station can host IDE-like layouts, but it is a platform. The gated coding layout is one vertical among many.

- **Not locked to any model provider, and not a closed ecosystem.** Providers for Bedrock, Claude Code, Codex, Ollama, and command-backed engines; MIT-licensed plugins by convention; portable configuration.

---

## Target Users

1. **Kontour itself (first and always).** Station is dogfooded on Kontour's own repos. If shipping Kontour changes through evidence-gated Station runs doesn't feel indispensable to us, we have no business selling it to anyone else.

2. **Teams shipping agent-authored work under standards.** They already feel the pain Flow and Veritas address; Station gives them the one workspace where agents run *inside* the discipline instead of being chased by it.

3. **Enterprises adopting agents under compliance pressure.** White-label providers, SSO, local-first data, and audit-ready run reports make Station deployable where "the agent did something, we think" is disqualifying.

The plugin system is what serves all three: Kontour dogfoods with the default set, teams add shared plugins, enterprises replace providers entirely.
