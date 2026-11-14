/**
 * One Qwen Code subagent run, as `session/update` frames. Not a recording:
 * the shapes are built from Qwen Code's emitters at
 * QwenLM/qwen-code 6f754be6548903e545e6ff0ed43a34927fe3bfb9 (the same in
 * release v0.27.3):
 *
 * - The parent Agent call (`_meta.toolName: 'agent'`, `ToolNames.AGENT` in
 *   packages/core/src/tools/tool-names.ts) starts and ends as an ordinary
 *   builtin tool (`createTranscriptToolCallStartUpdate` /
 *   `createTranscriptToolCallResultUpdate` in
 *   packages/acp-bridge/src/transcript-replay.ts, `_meta` from
 *   `buildUpdateMeta`, which spreads `extra` into `_meta`).
 * - The subagent's own calls carry its `SubagentMeta` (`parentToolCallId`,
 *   `subagentType`, `agent`) and `provenance: 'subagent'`
 *   (session/emitters/tool-call-emitter.ts `emitStart` / `emitResult`,
 *   `resolveToolProvenance`; session/SubAgentTracker.ts).
 * - Its progress note lands on the parent call with `subagentProgress: true`
 *   and no `parentToolCallId` (tool-call-emitter.ts `emitProgressUpdate`).
 *
 * Assumed (valid, not observed): the ids, titles, paths, texts, `kind` of
 * the Agent call and the timestamps.
 */
const SESSION = 'qwen-session-1';
const PARENT = 'call_agent_7f3a';
const AGENT = { agentName: '/root/Explore', depth: 1 };
const SUBAGENT_META = {
  parentToolCallId: PARENT,
  subagentType: 'Explore',
  agent: AGENT,
};

export const QWEN_SUBAGENT_PARENT_CALL_ID = PARENT;

export const QWEN_SUBAGENT_FRAMES: Array<{
  method: 'session/update';
  params: { sessionId: string; update: Record<string, unknown> };
}> = [
  {
    sessionUpdate: 'tool_call',
    toolCallId: PARENT,
    status: 'pending',
    title: 'Find where authentication is handled',
    content: [],
    locations: [],
    kind: 'other',
    rawInput: {
      description: 'Find where authentication is handled',
      subagent_type: 'Explore',
      prompt: 'Find where authentication is handled.',
    },
    _meta: {
      toolName: 'agent',
      provenance: 'builtin',
      subagentSessionReady: false,
      timestamp: 1763049600000,
    },
  },
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_read_2c91',
    status: 'pending',
    title: 'src/auth.ts',
    content: [],
    locations: [{ path: '/workspace/src/auth.ts' }],
    kind: 'read',
    rawInput: { file_path: '/workspace/src/auth.ts' },
    _meta: {
      toolName: 'read_file',
      provenance: 'subagent',
      ...SUBAGENT_META,
      timestamp: 1763049601000,
    },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: PARENT,
    status: 'in_progress',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'read_file src/auth.ts' },
      },
    ],
    _meta: {
      subagentType: 'Explore',
      provenance: 'subagent',
      subagentProgress: true,
      agent: AGENT,
    },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_read_2c91',
    status: 'completed',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'export function login() {}' },
      },
    ],
    _meta: {
      toolName: 'read_file',
      ...SUBAGENT_META,
      provenance: 'subagent',
      timestamp: 1763049602000,
    },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: PARENT,
    status: 'completed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Authentication is handled in src/auth.ts.',
        },
      },
    ],
    _meta: {
      toolName: 'agent',
      provenance: 'builtin',
      timestamp: 1763049603000,
    },
  },
].map((update) => ({
  method: 'session/update' as const,
  params: { sessionId: SESSION, update },
}));
