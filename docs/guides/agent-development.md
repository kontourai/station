# Develop Agents and applications that use Station

Use `@kontourai/station-sdk/agent` to author Agent definitions and execute work
from a headless application or a plug-in. Use the SDK root and UI subpaths to
build the plug-in's Pane. Both use the same Station contracts and runtime;
see [ADR 0021](../adr/0021-separate-plugin-and-agent-sdk-surfaces.md).

This entry is present in this source checkout. A published SDK must include
`./agent` in its export map before these imports work. The SDK distributes
TypeScript source: use a TypeScript-aware runner or bundle it, as the
[headless example](../../examples/headless-agent/README.md) does.

## Choose what to build

| Goal | Authoring route |
| --- | --- |
| Define a specialist with prompts, Skills, MCP, and an engine binding | Existing `AgentSpec` and Agent configuration; an SDK dependency is optional |
| Distribute that specialist | [Agent Plugins contract](../reference/agent-plugins.md) and [Portable Author Kit](../../examples/portable-author-kit/README.md) |
| Run or coordinate work from code | `@kontourai/station-sdk/agent` |
| Add a workspace Pane, UI hooks, or host contributions | [Plug-in guide](plugins.md) and SDK root/owning UI subpaths |
| Integrate a custom engine loop | [Agent runtime context](../contexts/agent-runtime/CONTEXT.md) and its engine adapter owners |

## Author a definition

An Agent is a working identity; its engine executes it. Import the existing
contract instead of creating a second Agent schema:

```ts
import type { AgentSpec } from '@kontourai/station-sdk/agent';

const spec = {
  name: 'Review specialist',
  prompt: 'Review the requested change and report findings with evidence.',
  skills: ['review-change'],
} satisfies AgentSpec;
```

This object is configuration, not registration or permission. The existing
Agent APIs and plug-in manifest owners validate persisted definitions. Engine
capabilities determine which prompts, Skills, tools, and policy can be delivered.
`createAgentDetailed` preserves save warnings; saving a definition does not
prove it is launchable. A plug-in declares its Agent source through the existing
Station namespace; it does not supply a runtime object or gain execution rights
by being installed.

## Execute through a selected Station

The entry re-exports canonical client operations with their existing signatures:
`operation(apiBase, input, options)` (some operations also take an ID). Pass an
explicit selected Station URL and the request authority needed for each call.
There is no SDK-owned default Station or cached credential.

```ts
import {
  agentId,
  delegateTask,
  type ClientRequestOptions,
  type ExecutionTarget,
} from '@kontourai/station-sdk/agent';

const apiBase = 'https://station.example.com';
const target: ExecutionTarget = {
  environment: { kind: 'current' },
  agent: agentId('review-specialist'),
  workspace: { kind: 'project', projectSlug: 'example-project' },
};
// Obtain this from your authorized host or credential mechanism; never a manifest.
const options: ClientRequestOptions = {
  credential: process.env.STATION_AGENT_TOKEN,
  credentialOrigin: new URL(apiBase).origin,
  requireCredential: true,
};
const handle = await delegateTask(apiBase, {
  target,
  prompt: 'Review the current diff.',
}, options);
```

`current` means the Station receiving the request. A saved Environment target
uses an identity learned from Station discovery; the target Station resolves
its own Agent/engine binding. An API URL and a Project slug are not credentials
or grants. The caller needs access to the Project and requested operation.
Read [the API reference](../reference/api.md) for the
actual supported credential mechanism.

In a mounted plug-in, use host-issued `apiBase` and request scope through the
existing SDK context. The builder externalizes `/agent`, and the host resolves
it before loading a bundle. Its functions share the same transport as `/client`;
header attribution remains distinct from authorization. Never copy a browser
credential into a plug-in package. The development preview's mock SDK is not
proof of authenticated Agent execution.

## Observe, continue, and handle uncertainty

Keep the server's `conversationId`, `sessionId`, Environment identity, and
receipts. A delegation create returns accepted work, not a completed answer.
`observeDelegatedTask` returns current status, pending input, and capability
delivery. `observeDelegatedTaskEvents` returns bounded pages with an opaque
`nextCursor`; carry that cursor to the next read instead of treating it as a
sequence number. Follow-up uses `continueDelegatedTask` and the durable
conversation identity. Read outputs using the returned Session identity.

Foreground conversations use `sendExecutionMessage` and
`continueExecutionMessage`. Session reads and event windows remain canonical
orchestration reads. `respondToDelegatedTaskRequest` and `respondToRequest`
submit explicit decisions; do not automatically accept pending requests.
`interruptDelegatedTask` and `interruptTurn` send lifecycle commands. Aborting
an HTTP request cancels that request, not necessarily provider execution.

Inspect `DelegationApiError` and `ForegroundMessageIndeterminateError` when an
operation may already have started. A request timeout, lost response, or unknown
attempt is not permission to resend a create. Attempt claims are opt-in and
require the receiver's advertised capability. See
[delegation attempt claims](delegation-attempt-claims.md) and the
[Session API](../reference/session-api.md). Completion status and produced
outputs do not independently establish that a business task or review passed.

## Verification and package boundaries

The [resolved bundle test](../../packages/sdk/src/__tests__/browser-entry-bundles.test.ts)
checks the public export map on Node and browser targets and rejects UI or
Station application dependencies. The headless example is type-checked and
buildable without a Pane. The existing plug-in build and shared-runtime tests
cover host externalization and shared client function identity.

The SDK package still declares its existing React peers and source distribution.
This import boundary does not claim separately installable packages, a new
engine implementation, live provider compatibility, hosting, or payment support.
See the [SDK reference](../reference/sdk.md#agent-development-entry) for the
public operation groups.
