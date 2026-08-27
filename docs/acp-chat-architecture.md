# ACP Chat Architecture — Design Document

## Problem

Station has a single global ACP connection used for agent discovery and chat routing. This creates three issues:

1. **No concurrency** — only one active session at a time. If ChatDock is streaming and you send a message in a terminal tab, they collide.
2. **No per-project context** — the ACP process runs in the server's cwd, not the project's working directory. Agents don't see the right files.
3. **Duplicated UI** — ChatDock and the terminal ACP tab need the same chat rendering (messages, streaming, tool calls, approvals) but can't share components today.

## Implementation Status

| Phase | Status | Notes |
|---|---|---|
| Phase 1: Extract Shared Chat Components | **Partial** | ChatMessageList, MessageBubble, StreamingMessage, ToolCallDisplay extracted to `src-ui/src/components/chat/`. ChatInput and useChat not yet extracted. |
| Phase 2: ACPSessionPool Backend | **Not started** | |
| Phase 3: Chat Route Integration | **Not started** | |
| Phase 4: ACPChatPanel for Terminal Tabs | **Partial** | ACPChatPanel exists and is wired into CodingLayout. |
| Phase 5: Hardening | **Not started** | |

## Reference: the surveyed client's approach

The surveyed reference client spawns one `kiro-cli acp` process per thread. Each `AcpSessionManager` owns a child process and speaks JSON-RPC 2.0 over stdin/stdout. Key patterns:

- **Per-thread processes** — true concurrency, each thread streams independently
- **Session persistence** — `acpSessionId` stored in DB, `session/load` resumes on next message
- **Aggressive culling** — idle processes destroyed (60s unviewed, 5m viewed), transparently resumed later
- **MCP readiness gating** — waits for all MCP servers to initialize before first prompt
- **Interleaved segments** — `{type:'text'|'tool', ...}[]` array persisted to message metadata, enables page-reload seeding
- **Sub-agent spawning** — parallel child AcpSessionManager instances for `spawn_sub_agents`
- **Waiting detection** — polls output file mtime every 5s, broadcasts stale state
- **Mode toggle** — threads can convert between `chat` (native) and `chat_v2` (ACP) via dropdown

## Proposed Architecture

### Connection Topology

```
ACPManager
  │
  ├─ Discovery Connection (global, existing)
  │    └─ kiro-cli acp (no cwd context needed)
  │    └─ Purpose: agent/mode listing, slash commands
  │    └─ Lifecycle: starts on boot, stays alive, never chats
  │
  └─ Project Connection Pool
       │
       ├─ Project "default" (cwd: ~/project-a)
       │    └─ Process Pool (max 4 concurrent)
       │         ├─ Process 1: conv-abc (streaming)
       │         ├─ Process 2: conv-def (streaming)
       │         └─ Process 3: (idle, session preserved, will be culled)
       │
       └─ Project "other" (cwd: ~/project-b)
            └─ Process Pool
                 └─ Process 1: conv-xyz (streaming)
```

**Rules:**
- Discovery connection is separate from chat connections (different concerns)
- Chat connections are per-project (cwd determines agent context)
- Each active conversation gets its own process (true concurrency)
- Idle processes are culled after timeout — sessionId stored, `session/load` resumes in fresh process
- Max concurrent processes per project is bounded (4) — oldest idle culled if limit hit
- ChatDock and terminal ACP tabs for the same project share the same pool

### Session ↔ Conversation Mapping

The conversation record gains an `acpSessionId` field:

```typescript
interface ConversationRecord {
  // ... existing fields
  acpSessionId?: string;    // null for native conversations
  acpProjectSlug?: string;  // which project pool this belongs to
}
```

| Conversation type | acpSessionId | Routing |
|---|---|---|
| Native (Bedrock) | null | Direct model call (existing path) |
| ACP | "session-xyz" | Project pool → process → session/load → prompt/send |

### Process Lifecycle

```
                    ┌─────────────┐
     first message  │             │  session/new
    ───────────────►│   SPAWNING  │──────────────┐
                    │             │               │
                    └─────────────┘               ▼
                                          ┌──────────────┐
                    resume message        │              │
                    ─────────────────────►│   ACTIVE     │◄──── prompt/send
                    (session/load in      │  (streaming) │
                     fresh process)       │              │
                                          └──────┬───────┘
                                                 │ turn_end
                                                 ▼
                                          ┌──────────────┐
                                          │              │  timeout
                                          │    IDLE      │──────────┐
                                          │              │          │
                                          └──────┬───────┘          ▼
                                                 │           ┌────────────┐
                                                 │ message   │  CULLED    │
                                                 │           │ (process   │
                                                 └──────────►│  killed,   │
                                                  session/   │  sessionId │
                                                  load in    │  stored)   │
                                                  same proc  └────────────┘
```

### Culling Strategy (adapted from the surveyed client)

| State | Timeout | Action |
|---|---|---|
| Idle, user viewing the conversation | 5 minutes | Kill process, store sessionId |
| Idle, user NOT viewing | 60 seconds | Kill process, store sessionId |
| Culled, user sends message | Immediate | Spawn new process, `session/load`, `prompt/send` |
| Process pool at max (4) | Immediate | Cull oldest idle process to make room |

Culling is invisible to the user — the conversation just takes a few extra seconds on the next message while the process respawns and MCP servers initialize.

### MCP Readiness (from the surveyed client)

Before the first prompt on a new/loaded session, wait for MCP servers:

1. `session/new` or `session/load` triggers MCP server initialization
2. `_kiro.dev/commands/available` notification gives expected server count
3. `_kiro.dev/mcp/server_initialized` fires per server
4. `_kiro.dev/mcp/server_init_failure` fires per failed server
5. When initialized + failed = expected → ready
6. 30s safety net timeout if count never matches
7. Settling mode (older kiro-cli): 3s debounce after last notification

## Frontend: Shared Chat Components

### Current State

```
ChatDock.tsx (330 lines) — orchestrator
ChatDockBody.tsx (393 lines) — message list + context
ChatInputArea.tsx (279 lines) — input with attachments
MessageBubble.tsx (417 lines) — single message rendering
StreamingMessage.tsx (94 lines) — streaming text display
ToolCallDisplay.tsx (271 lines) — tool call cards
hooks/useChatInput.ts (262 lines) — input state management
hooks/useToolApproval.ts (97 lines) — approval flow
hooks/streaming/*.ts (649 lines) — SSE stream handlers
```

### Extraction Plan

These components are already fairly modular. The main coupling is to ChatDock-specific layout (sidebar, header, dock mode). The extraction:

```
src-ui/src/components/chat/          ← NEW shared directory
  ├─ ChatMessageList.tsx             ← extracted from ChatDockBody (message rendering loop)
  ├─ ChatInput.tsx                   ← extracted from ChatInputArea (input + send)
  ├─ MessageBubble.tsx               ← move as-is (already generic)
  ├─ StreamingMessage.tsx            ← move as-is
  ├─ ToolCallDisplay.tsx             ← move as-is
  └─ useChat.ts                      ← extracted from useChatInput + useSendMessage
                                       (session management, send, stream, cancel)

ChatDock.tsx                         ← imports from chat/, adds dock chrome
  └─ ChatDockBody.tsx                ← imports ChatMessageList, adds context panel

CodingLayout.tsx
  └─ ACPChatPanel.tsx                ← imports from chat/, compact layout
       └─ ChatMessageList + ChatInput (no sidebar, no model picker)
```

**Key principle:** `ChatMessageList` and `ChatInput` don't know whether they're in a dock or a terminal tab. They receive messages, a send callback, and streaming state. The parent decides the layout.

### ACPChatPanel (terminal tab)

```typescript
interface ACPChatPanelProps {
  projectSlug: string;
  agentSlug: string;          // which ACP mode to use
  connectionId: string;       // which ACP connection
  conversationId?: string;    // resume existing, or undefined for new
}
```

Compact layout:
- No conversation sidebar
- No model picker (uses the ACP connection's model)
- No dock mode toggle
- Just: message list (scrollable) + input bar (bottom)
- Tool approval renders inline (same as ChatDock)

## Backend Changes

### New: `ACPSessionPool`

Manages per-project process pools. Lives alongside `ACPManager`.

```typescript
class ACPSessionPool {
  // Get or create a process for a conversation in a project
  async acquireProcess(projectSlug: string, conversationId: string): Promise<ACPProcess>

  // Release a process back to the pool (after turn ends)
  releaseProcess(projectSlug: string, conversationId: string): void

  // Cull idle processes
  private cullIdle(): void

  // Destroy all processes for a project
  async destroyProject(projectSlug: string): Promise<void>
}

class ACPProcess {
  // Wraps a single kiro-cli acp child process
  // Similar to the surveyed client's AcpSessionManager but adapted for Station

  async start(cwd: string, agent?: string): Promise<void>
  async newSession(mcpServers: McpServerConfig[]): Promise<string>  // returns sessionId
  async loadSession(sessionId: string): Promise<void>
  async prompt(content: string): Promise<void>  // streams via events
  async cancel(): Promise<void>
  destroy(): void

  // Events: same as the surveyed client's model
  on(event: 'agent_message_chunk', cb: (data: { text: string }) => void): void
  on(event: 'tool_call', cb: (data: ToolCallEvent) => void): void
  on(event: 'tool_call_update', cb: (data: ToolCallUpdateEvent) => void): void
  on(event: 'request_permission', cb: (data: PermissionEvent) => void): void
  on(event: 'turn_end', cb: (data: TurnEndEvent) => void): void
  on(event: 'close', cb: (data: { code: number; signal: string }) => void): void
}
```

### Modified: Chat Route

The existing `/chat` SSE endpoint needs a branch:

```typescript
// Existing: native agent
if (!acpBridge.hasAgent(slug)) {
  // Direct Bedrock call (existing path)
}

// New: ACP agent
const process = await sessionPool.acquireProcess(projectSlug, conversationId);
if (conversation.acpSessionId) {
  await process.loadSession(conversation.acpSessionId);
} else {
  const sessionId = await process.newSession(mcpServers);
  conversation.acpSessionId = sessionId;  // persist
}
await process.prompt(content);
// Stream events to SSE...
```

### Modified: Conversation Model

Add to the conversation/session storage:

```typescript
{
  acpSessionId?: string;      // ACP session ID for resume
  acpProjectSlug?: string;    // which project pool
  acpConnectionId?: string;   // which ACP connection (for multi-connection support)
}
```

## Implementation Phases

### Phase 1: Extract Shared Chat Components
- Create `src-ui/src/components/chat/` directory
- Extract `ChatMessageList`, `ChatInput` from ChatDock components
- Move `MessageBubble`, `StreamingMessage`, `ToolCallDisplay` to shared
- Extract `useChat` hook from `useChatInput` + `useSendMessage`
- Refactor ChatDock to import from shared — zero behavior change
- **Acceptance:** ChatDock works identically, components are importable from `chat/`

### Phase 2: ACPSessionPool Backend
- Implement `ACPProcess` (adapted from the surveyed client's `AcpSessionManager`)
  - JSON-RPC 2.0 over stdin/stdout
  - MCP readiness gating
  - Event emission for streaming
- Implement `ACPSessionPool` (process pool per project)
  - Lazy spawn on first chat
  - Culling with tiered timeouts
  - Max concurrent processes per project
- Wire into `StationRuntime` alongside existing `ACPManager`
- **Acceptance:** Can spawn, chat, cull, and resume ACP sessions per project

### Phase 3: Chat Route Integration
- Branch `/chat` endpoint for ACP agents
- Session-conversation binding (acpSessionId persistence)
- SSE streaming from ACPProcess events
- Tool approval flow through ACPProcess
- Session resume on conversation reopen
- **Acceptance:** ChatDock can chat with ACP agents through project pool

### Phase 4: ACPChatPanel for Terminal Tabs
- Build `ACPChatPanel` using shared chat components
- Wire into terminal tab system (type: 'acp-chat')
- Update "+" modal to create ACP chat tabs
- Same project pool as ChatDock — shared processes
- **Acceptance:** Terminal ACP tab streams independently from ChatDock

### Phase 5: Hardening
- Waiting detection (poll-based, from the surveyed client)
- Session event cards (init/resume/compaction visualization)
- Sub-agent support (`spawn_sub_agents`)
- Context compaction handling
- Interleaved segments persistence for page-reload

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Process per conversation vs shared | Per conversation | True concurrency required |
| Session resume mechanism | `session/load` in fresh process | Culling + resume is invisible to user |
| Discovery vs chat connections | Separate | Different lifecycles, different concerns |
| Component sharing | Extract to `chat/` directory | DRY between ChatDock and terminal tab |
| Max processes per project | 4 | Bounded resource usage, oldest idle culled |
| Culling timeouts | 60s unviewed, 5m viewed | Matches the surveyed client's proven model |

## Open Questions

1. **Should the discovery connection also be per-project?** Currently global. Per-project would mean agents could differ by working directory (different .kiro configs). But it's heavier.

2. **How to handle ACP connection drops mid-stream?** the surveyed client retries session/load 3 times, then falls back to session/new. We should do the same.

3. **Should terminal ACP tabs persist conversations?** Currently ephemeral (close tab = lose history). Could store in the same conversation system as ChatDock for resume.

4. **Sub-agent rendering in terminal tab?** the surveyed client has a tabbed card UI. In the compact terminal panel, this might need a different treatment.
