# Conduit runtime integration

> **Reading status: current Station-engine hook projection.** The
> [Conduit adapter](../../src-server/runtime/frameworks/conduit-framework-adapter.ts),
> [VoltAgent caller](../../src-server/runtime/frameworks/voltagent-adapter.ts),
> and [Strands caller](../../src-server/runtime/frameworks/strands-adapter.ts)
> own this composition. This is separate from Codex, Claude Code, or other
> external engine policy delivery; see the [tool-policy matrix](../conformance/tool-policy-delivery.md).

Station projects its existing `IAgentHooks` lifecycle through Conduit's public
agent-host contract for both Station engine implementations. Conduit does not
register hooks with either framework. `VoltAgentFramework` continues to use its
existing `createHooks` callbacks and `StrandsFramework` continues to use
`wireStrandsAgentHooks`; both receive a thin Conduit-conformed view of the same
Station-owned hook object.

The projection is behavior-preserving:

- Station evaluates tool approval and policy before Conduit projects allow or
  deny onto the host capability.
- Station records tool results, usage, memory, orchestration state, canonical
  events, and telemetry through its existing services.
- Conduit owns only capability characterization and portable conformance
  evidence. It does not own Station policy or framework objects.
- When no `IAgentHooks` object is configured, the adapter receives `undefined`
  exactly as before; direct framework behavior is unchanged.

Station's hook seam is narrower than either framework's entire public API. It
does not expose session-start or before-model callbacks, framework asset
installation, or dynamic context injection. Those capabilities are declared
`unavailable`, even where a framework could support them through another API.
Tool blocking and before-tool observation are native. After-tool observation
is now native for both frameworks: VoltAgent calls Station's `afterToolCall`
from `onToolEnd` with the output and error; Strands forwards its after-tool
event. Invocation completion is an approximated `stop` projection for both
frameworks. These are capability classifications for this hook seam, not proof
of every provider's execution or cancellation behavior.

The committed [JSON evidence](../conformance/station-runtime-conformance.json)
and [generated matrix](../conformance/station-runtime-conformance.md) are
labelled host-bound to exact framework versions in `pnpm-lock.yaml`. These
portable probes exercise the Station projection and record the lockfile's host
identities; they do not connect a model provider or execute an entire framework
invocation. The
[generator](../../scripts/generate-runtime-conformance.mjs) reads the root
importer's locked versions. Run
`npm run conduit:conformance:generate` after changing Conduit or a framework.
`npm run verify:static` fails when the evidence is stale.

## Telemetry

No new metric is introduced. This integration adds no runtime decision,
fallback, retry, or user-visible behavior; it projects existing hook calls
without changing Station's established lifecycle and policy instrumentation.
The conformance report is executable evidence for this compatibility seam.
