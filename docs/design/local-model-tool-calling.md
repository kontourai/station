# Local-model (Ollama) tool calling — how to do it best

**Question:** how do we get the full tool flow (e.g. `render_component` → form renders → submit → re-entry) working end-to-end in the UI with a **local/free model** (Ollama first; OpenAI as a fallback)?

**Short answer:** don't build tool-calling into the connected `OllamaAdapter`. Use the **provider-managed** path — which already passes MCP tools to any model connection (including Ollama) and is proven to work — and make a provider-managed-Ollama agent **selectable in the UI**. Pair it with a real tool-calling model (Qwen 2.5 / Llama 3.1), not a small vision model.

## There are two Ollama paths, and they behave differently

| Path | How an agent gets it | Dispatch | Passes MCP tools? |
|------|----------------------|----------|-------------------|
| **Managed (VoltAgent) + Ollama model connection** | agent has no `__runtime:` slug; execution resolves to `provider-managed` | `useActiveChatSessionMessaging` → `streamConversationTurn` → `POST /api/agents/:slug/chat` | ✅ **yes** — ai-sdk openai-compatible sends `tools:`; **verified live** (`render_component` ran, returned the form uiBlock) |
| **Connected `__runtime:ollama-runtime`** | agent `execution.runtimeConnectionId` → an Ollama *runtime* connection | `POST /api/orchestration/commands` → `OllamaAdapter.sendTurn` | ❌ **no** — `OllamaAdapter` capabilities are `['agent-runtime','session-lifecycle']`, no `'tool-calls'`; never sends `tools:` |

Both browser dogfood runs went down the **connected** path (to make the agent selectable, they set `runtimeConnectionId: ollama-runtime`), so the model got no tools and just described the form in prose. That was the wrong path, not a fundamental gap.

## Why the managed path is already the right one

- `resolveProviderManagedExecution` (`src-ui/src/utils/execution.ts`) accepts **any** enabled `kind:'model'` LLM connection and returns `{ executionMode:'provider-managed', provider: connection.type, ... }` — i.e. it already supports `provider:'ollama'`, with an explicit `defaultLLMProvider` match or a single-provider fallback.
- `useActiveChatSessionMessaging.ts:29` routes **only `__runtime:` agents** to the orchestration/adapter path; provider-managed agents go through the managed `/chat` path (line ~109).
- The managed `/chat` path passes MCP tools to the model — **proven** against Ollama (`qwen3-vl:4b` emitted a valid `render_component` form call; the tool executed and returned the uiBlock).

So the managed runtime is the designed "tools + any model" path. The connected runtimes (`claude-runtime`, `codex-runtime`, `ollama-runtime`) exist to drive **native** CLIs/runtimes; adding a tool-dispatch loop to `OllamaAdapter` would duplicate the managed runtime's loop for a worse-aligned design.

## The blocker: UI selectability of a managed-Ollama agent

A managed agent created via `POST /agents` with just `model` + `tools` is **not selectable** in the New Chat modal:

- `canAgentStartChat` requires `execution.runtimeConnectionId` → a selectable **runtime** connection (`kind:'runtime'`, `agent-runtime`). An Ollama **model** connection (`kind:'model'`) doesn't qualify.
- So the agent falls into the `providerManaged` bucket, which the modal gates on the default managed provider (**Bedrock**) → shows "Setup required" when AWS creds are missing, even though a working Ollama model connection exists.

The fix is to make the provider-managed bucket recognize a configured **non-Bedrock** model connection as ready:

1. **Config (likely enough to unblock):** set `appConfig.defaultLLMProvider` to the Ollama model-connection id. Then `resolveGlobalProviderManagedExecution` resolves `provider:'ollama'`, the agent becomes provider-managed-selectable, and chat routes through the managed (tools-working) path.
2. **UI polish (if needed):** stop showing "Bedrock setup required" when the resolved managed provider is a ready non-Bedrock connection (single-connection or `defaultLLMProvider` match), and label the managed group by the actual provider (Ollama).

This reuses the proven tool loop — **no new tool-dispatch code**.

## Model choice matters more than the plumbing

Tool calling is the most uneven capability for local models. Use a real tool-calling **instruct** model, not a small vision model:

- **Good local choices:** Qwen 2.5 (7B for dev, 14B+ for reliability), Llama 3.1 8B, Mistral Nemo. (`qwen3-vl:4b` is a small *vision* model and only worked for a single simple tool by luck.)
- Keep the active tool count modest — several local models get confused past ~3 tools.
- Ollama exposes tools two ways: native `/api/chat` with a `tools:` param (canonical) and the OpenAI-compatible `/v1/chat/completions` (what the managed/ai-sdk path uses). The OpenAI-compatible mode is reportedly **less reliable** for tools than native — fine for a small tool set + a strong model, but it's the reason to prefer a capable model and to keep the native path in mind as a future optimization.

## OpenAI fallback

The same provider-managed path works for an OpenAI model connection (set `defaultLLMProvider` to it, pick a tool-calling model like `gpt-4o`/`gpt-4.1`). OpenAI's tool calling is more reliable than local models, so it's a good cross-check — but the goal is local-first via the route above.

## Recommendation

1. Make managed-Ollama agents selectable (config `defaultLLMProvider` → Ollama; small modal-gating fix if required). Reuses the working managed tool loop.
2. Use Qwen 2.5 / Llama 3.1 (a real tool model), modest tool count.
3. Verify end-to-end in the UI: form renders → fill → submit → tagged re-entry.
4. **Do not** add tool-calling to the connected `OllamaAdapter` — that duplicates the managed loop. Only revisit a native-`/api/chat` tool path if OpenAI-compatible reliability proves insufficient in practice.

## Sources

- [Ollama — Tool support](https://ollama.com/blog/tool-support)
- [Ollama — OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama tool calling / function execution (DeepWiki)](https://deepwiki.com/ollama/ollama/7.2-tool-calling-and-function-execution)
