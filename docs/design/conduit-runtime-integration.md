# Conduit runtime integration

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
Tool blocking and before-tool observation are native. Strands provides native
after-tool observation. VoltAgent is declared approximated because Station's
existing `afterToolCall` callback currently runs from `onToolStart`, before the
tool result is available. Invocation completion is an approximated `stop`
projection for both frameworks.

The committed [JSON evidence](../conformance/station-runtime-conformance.json)
and [generated matrix](../conformance/station-runtime-conformance.md) are
host-bound to exact framework versions in `package-lock.json`. Run
`npm run conduit:conformance:generate` after changing Conduit or a framework.
`npm run verify:static` fails when the evidence is stale.

## Telemetry

No new metric is introduced. This integration adds no runtime decision,
fallback, retry, or user-visible behavior; it projects existing hook calls
without changing Station's established lifecycle and policy instrumentation.
The conformance report is executable evidence for this compatibility seam.
