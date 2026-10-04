# ADR 0021 — Separate plug-in and Agent SDK surfaces

**Status:** Accepted direction, 2026-09-30. The Agent entry point is implemented
in this source change; availability in a published package requires a release
containing it.

## Context

Plug-in authors extend Station's workspace and host contribution system. Agent
application authors define working identities and execute or coordinate work.
A headless caller should not need React, CSS, a mounted SDK provider, or imports
from Station's application internals. A plug-in can distribute an Agent and
provide a Pane that invokes it; distribution does not own the Agent's loop.

Station already has canonical React-free clients for these operations and
shared domain contracts. Creating another execution service or wrapping every
operation in a new lifecycle would duplicate ownership and failure handling.

## Decision

Keep one published `@kontourai/station-sdk` package with distinct entry points:

- The root and documented UI subpaths serve plug-in UI and host integration.
- `/agent` serves headless Agent authoring, discovery, foreground execution,
  durable delegation, observation, approval decisions, interruption, and outputs.
- `/client` remains the broader React-free Station API surface for compatibility
  and operations outside the Agent journey.

Plugin UI command effects use the explicit
[`/client/plugin-command-effects`](../../packages/sdk/src/client/plugin-command-effects.ts)
subpath. The palette uses it to admit and settle its local effect with Station;
that is host integration, not Agent work execution or a plug-in-owned grant.
Station validates the installed declaration and caller scope, then owns
withdrawal status until the browser document proves settlement. See the
[HTTP contract](../reference/api.md#plugin-command-effects).

The [Agent entry](../../packages/sdk/src/agent/index.ts) explicitly re-exports
canonical clients and contract types. Each operation retains its explicit
`apiBase` and per-call `ClientRequestOptions`. It must not capture a global
Station URL or credential, invent an automatic retry policy, conceal uncertain
execution, or load UI or engine implementation code. The plug-in builder and
host bridge share this entry rather than bundling a second transport instance.

Agent definitions use the existing `AgentSpec`. Station resolves the selected
Agent's engine and authorizes each operation. A custom engine loop belongs to
the engine adapter boundary, not this SDK. Portable Skills and MCP plus
Station Agent declarations keep the existing Agent Plugins format; the SDK
adds no package manifest or permission system.

## Rules for subsequent changes

Put an operation on `/agent` when it serves Agent authoring or work execution
and can delegate to an existing public client owner. UI hooks, renderers,
navigation, installation, billing, and host administration belong elsewhere.
Review additions as explicit exports; do not wildcard-export the client barrel.
Update the [authoring guide](../guides/agent-development.md), public reference,
and executable example with each change to that journey.

The resolved bundle test must keep every export live and fail when UI or
application internals enter the graph. Canonical client tests own HTTP and
lifecycle behavior; the plug-in build and host bridge tests own composition.
An installed plug-in's identity or headers never substitute for authorization.

## Delivery and later extraction

This change establishes the public entry, host composition, a headless example,
and boundary evidence. Existing imports stay supported; consumers can migrate
when touching their Agent execution code, rather than through a repository-wide
rename. Data-only specialists may use manifests without importing an SDK.

Split publication into separate packages only when real consumers require
independent runtime dependencies, compatibility ranges, or release cadence.
Import isolation now does not remove the package's existing React peer metadata.
Do not promise engine-independent control of tools an external engine owns.
Future convenience APIs must preserve request authority, server-returned
identities, continuation, cancellation, and indeterminate results.
