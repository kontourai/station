# Strands Agents SDK Migration

> **Historical migration assessment.** The parity table and SDK limitations
> below record the migration assessment; they are not a current compatibility
> guarantee. For runtime selection, use the [configuration reference](reference/config.md).
> Verify behavior against the [Strands adapter](../src-server/runtime/frameworks/strands-adapter.ts)
> and its tests before relying on a capability or gap described here.

## How to Test

```bash
./station start --build --features=strands-runtime
```

No config file changes needed. The `--features` flag sets `STATION_FEATURES` env var, and the runtime applies `strands-runtime` to override `appConfig.runtime`.

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
CLI: --features=strands-runtime
  → env STATION_FEATURES=strands-runtime
  → runtime.initialize() reads env, sets appConfig.runtime = 'strands'
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

## Files Changed

- `src-server/runtime/strands-adapter.ts` — All adapter fixes
- `packages/cli/src/cli.ts` — `--features` flag parsing
- `packages/cli/src/commands/lifecycle.ts` — Pass `STATION_FEATURES` env var
- `src-server/runtime/station-runtime.ts` — Apply feature flags in initialize()
