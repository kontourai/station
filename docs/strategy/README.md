# Station Strategy

> **For AI agents:** Read [constitution.md](constitution.md) for durable identity
> and [AGENTS.md](../../AGENTS.md) for current execution rules. Query GitHub
> issues and pull requests before selecting work; this directory is not a live
> backlog.

> **For humans:** This directory contains Station's durable strategy — what it
> is, what makes it different, and how work ships. Live state (issues,
> priorities, ownership) belongs in GitHub, not here.

---

## Documents

| Document | Purpose | When to read |
|----------|---------|-------------|
| [constitution.md](constitution.md) | Project identity, core beliefs, non-negotiables | First. Always. |
| [differentiators.md](differentiators.md) | Durable differentiation and proof boundaries | When evaluating features or positioning |
| [kontour-integration-surface.md](kontour-integration-surface.md) | Verified public contracts of the Kontour products Station consumes | Before implementing against any `@kontourai/*` package |
| [local-merge-readiness.md](local-merge-readiness.md) | The merge evidence basis and verification protocol | Before merging anything |
| [multi-agent-delivery-protocol.md](multi-agent-delivery-protocol.md) | How agents deliver into this repo (layered review, fault injection, batch merges) | Before delivering a substantive change |
| [vision/ai-ui-bridge.md](vision/ai-ui-bridge.md) | The AI ↔ UI bridge north star | When working on bridge-related features |
| [acp-extension-upstream-proposal.md](acp-extension-upstream-proposal.md) | Proposed ACP extensions, staged for upstream | When touching ACP integration surface |

## How These Docs Work

- **Anyone can update** (AI or human) — except `constitution.md`, which requires
  human approval.
- **Note your reasoning** — when changing strategy, briefly explain why.
- **Keep it honest** — if a durable claim no longer matches reality, update the
  owning document.
- **Keep live state out** — issue status, assignees, priority, and merge state
  belong in GitHub, not in a strategy snapshot.

## For AI Agents: Quick Start

```
1. Read constitution.md     → Understand identity and constraints
2. Read AGENTS.md (root)    → Technical conventions and CI gates
3. Query GitHub             → Find current, unclaimed work
4. Recheck worktrees/processes → Avoid overlapping an active lane
5. Create a branch, implement, verify, and report exact evidence
```
