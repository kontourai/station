---
status: current
subject: GitHub Copilot as a vendor-native engine through the Copilot SDK, run on the person's own Copilot CLI, behind a Feature Preview
decided: 2026-11-13
evidence:
  - kind: doc
    ref: src-server/providers/adapters/copilot-sdk-adapter.ts
  - kind: doc
    ref: src-server/providers/adapters/copilot-sdk-port.ts
  - kind: doc
    ref: src-server/providers/adapters/copilot-sdk-approval.ts
  - kind: doc
    ref: src-server/providers/adapters/copilot-sdk-events.ts
  - kind: doc
    ref: src-server/providers/__tests__/copilot-sdk-adapter.test.ts
  - kind: doc
    ref: pnpm-workspace.yaml
---

# GitHub Copilot through the Copilot SDK

## Decision

Station adds a vendor-native GitHub Copilot engine, `copilot-sdk`, built on
the Copilot SDK (`@github/copilot-sdk`, pinned exactly). It ships behind the
`copilot-sdk-engine` Feature Preview, off by default. The ACP built-in
(`copilot --acp`) is a separate connection and is unchanged.

### What the SDK is

The SDK is an MIT JavaScript client. It spawns a Copilot CLI as
`<cli> --headless --no-auto-update --stdio` and speaks JSON-RPC to it, after
negotiating a protocol version range. An experimental in-process transport
loads the runtime over FFI (`koffi`) instead; Station never uses it.

The SDK's eight optional `@github/copilot-sdk-<platform>` packages are labelled
MIT, but they contain the Copilot CLI runtime itself (`runtime.node`,
`copilot-runtime`), which GitHub publishes separately under the proprietary
GitHub Copilot CLI License. They also contain Microsoft's `OneAuthInterop`
binary, whose Microsoft Software License Terms (section 3e) forbid
distributing it. The packages carry neither license's own text for the CLI.
Inspected: the 1.0.33 `win32-x64` package, 2026-11-13.

### How Station runs it

- **The person's own CLI, not a bundled one.** Station resolves `copilot` the
  way it resolves other engine CLIs (a managed policy's pinned binary first,
  then PATH) and hands that path to the SDK. On Windows an npm `copilot.cmd`
  shim is mapped to the package's `npm-loader.js`, which the SDK runs with
  Node.
- **No proprietary package installed or shipped.** `pnpm-workspace.yaml`
  lists all eight platform packages in `ignoredOptionalDependencies`, so no
  install, lockfile, or Station build contains them. The SDK's `koffi` pin is
  overridden to the `koffi` Station already reviewed, since only the unused
  in-process transport loads it.
- **The engine owns its sign-in.** Sessions use the CLI's own login (`copilot
  login`, the OS keychain, `gh`, or `COPILOT_GITHUB_TOKEN` and the other
  variables the CLI reads). Station holds no Copilot credential and never
  forwards one of its own, as the [engine credential
  record](engine-credential-provider.md) prefers.
- **One runtime per session,** started with Station's child environment and
  the session's own TMPDIR, and stopped with the session.

### How each capability binds

Every capability uses a seam Station already has. Nothing here is a
Copilot-only path.

| SDK capability | Station seam |
| --- | --- |
| `createSession` / `resumeSession` | `startSession`; resume cursor `{ copilotSessionId }`, scoped by `nativeResumeBindingKey` to the runtime's configuration home |
| `send({ mode: 'enqueue', clientTurnId })`, `session.idle`, `session.error` | `sendTurn`, `turn.completed` / `turn.aborted` |
| `send({ mode: 'immediate' })` | `steerTurn` (steering durability `native`) |
| `abort()` | `interruptTurn`, confirmed by the turn's own `session.idle` |
| `onPermissionRequest` | `request.opened` / `respondToRequest` (below) |
| `session.history.rewind` | `rewindSession` / `sessionContinuity` (`rewind: 'in-place'`) |
| `subagent.started` / `completed` / `failed` | `child-work.updated` upsert and settle |
| `assistant.usage` | `token-usage.updated`, one per model call (scope `per-turn`) |
| `session.mcp_servers_loaded`, `session.mcp_server_status_changed` | `engine-mcp.status` |
| `session.mcp.restartServer` | `reconnectMcpServer` |
| `session.model_change` with `source: 'automatic'` | `model.rerouted` |
| `listModels` | the adapter's model list |

### Approvals and confinement

Every session is created with `permissionMode: 'manual'`, so the runtime's own
automatic modes (`assisted`, an LLM judge, and `allow-all`) never answer for
Station. Each request reaches the SDK's `onPermissionRequest`, and Station's
approval mode answers it:

- `ask`: Station allows a read inside the working directory; everything else
  goes to a person.
- `auto`: also a write inside the working directory.
- `never` (full access): every request, but only in a `host` session.

The Copilot runtime gives Station no process sandbox to confine it with, so
full access elsewhere applies `auto`, as it does for an ACP engine. The
adapter claims no confinement provider. "Allow for this session" is
remembered by Station, never handed to the runtime as a wider rule.

Not governed: approvals a person saved in the Copilot CLI itself, such as
"approve for this location". The runtime applies them without raising a
request. A pre-tool-use hook that answered `ask` for every tool would close
that gap, but the runtime then raises a generic `hook` request without the
typed kind (`read`, `write`, `shell`, `url`), so every read would need a
person. That trade was rejected; this residual stays documented.

### The preview gate

The adapter is always registered and selects the preview again at every entry
point that starts work: `preflightStart` and `startSession` refuse with
`feature_preview_disabled`, `sendTurn` and `steerTurn` refuse, prerequisites
report the preview, and the model list is empty. Turning the preview off stops
new sessions and turns at once. Stop, interrupt and answering an open request
stay available, so nothing is stranded.

Native adoption probes the `copilot` CLI only while the preview is on, read
at each probe. The connection appears at the first adoption window after the
preview is on, which normally means the next Station start. A hosted
multi-tenant runtime never binds the preview. A managed policy that lists
allowed engines refuses `copilot-sdk`, because the policy's engine ids do not
name it.

## Not bound, and why

- **Fork** (`sessions.fork`): Station's native fork runs through
  `adoptSession`, whose adoption ledger and creation hooks this first slice
  does not implement. Continuity declares `fork: 'none'`.
- **Station Control MCP passthrough**: not wired; the matrix declares
  `toolServers: unsupported`. The engine's own MCP servers are reported and
  can be restarted.
- **Staged pre-tool policy** (`onPreToolUse`): not wired;
  `toolPolicy: unsupported`.
- **Attachments, authored system prompt** (`systemMessage`), **per-subagent
  stop**: refused or declared unsupported.
- **Account quota** (`account.getQuota`): not surfaced.
- **Host-issued credentials**: the reviewed engine-credential bindings are ACP
  wire methods only. Issuing a vault token to this engine would need a new
  credential kind and wire, so it waits for its own reviewed decision.
- **Managed pinned install**: the managed installer takes an archive and
  manifest pin and hooks into ACP descriptors only. The CLI is the person's own
  install.
- **Cloud sessions** (`SessionConfig.cloud`): never set. They leave the host.

## Limits

- No live Copilot session has been run against this adapter. Event and
  request shapes come from the pinned SDK's own types (the adapter tests use
  them as fixtures, so drift fails the typecheck), not from captured traffic.
- That a stdio runtime exits when Station dies without stopping it rests on
  stdin closing. The SDK spawns the process itself, outside Station's owned
  child registry.
- Rewind with file restore is the runtime's operation and is not crash-atomic.
  Its partial outcomes (`files-rolled-back`, `rollback-incomplete`,
  `truncation-failed`) are reported as failures with the runtime's message.
