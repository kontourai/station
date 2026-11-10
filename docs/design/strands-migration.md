# Strands Agents SDK Migration

The off-by-default **Crash-durable Station Agent** preview now journals native
model streams, tool outcomes and approval decisions above the existing Strands
loop. It stages identified memory writes and reconstructs entry history on
recovery. Internal tracing UUIDs are excluded from provider-input equality;
provider messages and options remain pinned. The historical buffering analysis
below describes the ordinary path, not this optional journal. Uncertain model
dispatch is surfaced without automatic resend. See the
[runtime contract](../../packages/agent-runtime/README.md) and its stated limits.

> **Status: historical migration assessment.** The parity table and SDK gaps
> below record the assessment made when the Strands runtime was added; they are
> not a current compatibility guarantee. **Successor:** the
> [configuration reference](../reference/config.md) owns the `runtime` setting,
> the only runtime selector since
> [#3909](https://github.com/kontourai/station/issues/3909) removed the
> per-process boot flag this record originally described. Verify behavior against the
> [Strands adapter](../../src-server/runtime/frameworks/strands-adapter.ts) and
> its tests before relying on a capability or gap described here.

## How to Test

```bash
./station config set runtime strands --offline
./station start --build
```

Station reads the persisted `runtime` setting once at startup and creates the
Strands framework when it is `strands`. With Station running, omit `--offline`
and restart Station after the change. Start a new home once before the offline
write: on a home with no `config/app.json`, `--offline` creates the file with
only `runtime`, so Station skips the values it seeds when it creates the file
itself (see `loadAppConfigFile` in `src-server/domain/config-loader-app.ts`).

### Moving off the removed boot flag (#3909)

Before #3909, `--features=strands-runtime` (which set
`STATION_FEATURES=strands-runtime`) switched one process to Strands without
persisting anything. The server no longer reads the variable. So that such a
caller is not moved to VoltAgent without notice, the CLI refuses a
`--features=<list>` naming `strands-runtime` on `start`, `service install` and
`service run`, and refuses a `STATION_FEATURES` value naming it when Station
starts ([`retired-features-option.ts`](../../packages/cli/src/commands/retired-features-option.ts)).
Other values never changed the runtime and are ignored.

A service installed with `--features=strands-runtime` passes it from its unit,
so it stops starting. Its reinstall command (printed by `station service
status` for stale scheduling or PATH drift, and by `station upgrade` for stale
scheduling) repeats
the recorded value and is refused the same way. To keep Strands, run
`STATION_HOME=<service home> station config set runtime strands --offline`,
then `station service install` with the same options minus `--features`.

## What's Working

| Feature | VoltAgent | Strands | Notes |
|---|---|---|---|
| Agent creation | ✅ | ✅ | Same model, prompt, tools |
| Streaming | ✅ | ✅ | Strands events mapped to IStreamChunk |
| Conversation CRUD | ✅ | ✅ | Same runtime code path |
| Tool loading (MCP) | ✅ | ✅ | FunctionTool wrappers around MCP |
| Tool denial | ✅ | ✅ | FunctionTool checks denial set |
| Usage/cost tracking | ✅ | ✅ | AfterInvocation hooks |
| Message sync (all types) | ✅ | ✅ | Text, reasoning, tool use, tool result |
| getTools() / getFullState() | ✅ | ✅ | Returns actual tools |
| destroyAgent cleanup | ✅ | ✅ | Disconnects per-agent MCP clients |
| generateObject | ✅ | ✅ | Uses structuredOutputSchema when available |
| Temp agents | ✅ | ✅ | createTempAgent works |

## Known Gaps

### 1. Message Persistence Timing (significant)

**VoltAgent**: Messages are persisted in real-time during streaming. VoltAgent's `Memory` class intercepts messages as they flow through the agent and writes them to `FileMemoryAdapter` immediately.

**Strands**: Messages are synced post-hoc in the `AfterInvocationEvent` hook — after the entire invocation completes. This means:

- Messages are **not queryable** during an active stream
- If the process **crashes mid-stream**, messages are lost
- The delta calculation (`agentMessages.slice(existing?.length || 0)`) assumes append-only ordering

**Why this can't be fixed in the adapter**: The Strands SDK doesn't expose a per-message hook during streaming. The `MessageAddedEvent` fires after tool execution completes (deferred append pattern), not during text generation. There's no hook point where we could intercept individual messages as they're generated.

**Impact**: Low for normal operation (messages appear after response completes). High for crash recovery scenarios. Users won't notice unless the server crashes mid-response.

**Potential fix**: The Strands SDK would need to add a streaming message hook, or we'd need to parse the stream events ourselves and persist incrementally (duplicating what the SDK does internally).

### 2. Model ID Resolution (blocking for testing)

The Strands `BedrockModel` requires fully-qualified model IDs (e.g., `us.anthropic.claude-3-7-sonnet-20250219-v1:0`). The VoltAgent path uses `createBedrockProvider` from `@ai-sdk/amazon-bedrock` which handles inference profile resolution internally.

The Strands adapter calls `modelCatalog.resolveModelId()` which should add the `us.` prefix, but the default agent path may not have the model catalog available, or the resolution may fail silently.

**Fix needed**: Ensure `resolveModelId` always runs before passing to `BedrockModel`, and add a fallback that prepends `us.` for known model ID patterns.

## Architecture

```
config/app.json: "runtime": "strands"
  → runtime.initialize() reads appConfig.runtime
  → StrandsFramework created instead of VoltAgentFramework

Tool Denial Flow:
  BeforeToolCallEvent callback
  → denied? add toolUseId to Set
  → FunctionTool wrapper checks Set
  → returns denial message instead of executing

Message Sync Flow:
  AfterInvocationEvent fires
  → reads agent.messages (all accumulated)
  → computes delta vs persisted messages
  → maps ALL content block types to UIMessage parts
  → calls memoryAdapter.addMessage() for each
```

## Files changed by the migration (paths as of this review)

- `src-server/runtime/frameworks/strands-adapter.ts` — All adapter fixes
- `src-server/runtime/bootstrap/runtime-initialize.ts` — Select the framework
  from the `runtime` setting in initialize()

The migration also added a CLI `--features` option that set a
`STATION_FEATURES` boot override; #3909 removed both.
