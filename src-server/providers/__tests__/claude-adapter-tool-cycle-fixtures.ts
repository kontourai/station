import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * One real Claude Code Bash tool cycle, captured from live `query()` runs
 * against `@anthropic-ai/claude-agent-sdk` 0.3.224 driving `claude` 2.1.261,
 * for the prompt "Reply with exactly: TURN ONE OK. Then run `pwd` and tell me
 * the directory." (#1536 finding B1's own repro prompt).
 *
 * Both captures used `permissionMode: 'default'` (Station's `ask` approval
 * mode) with a `PreToolUse` hook and a `canUseTool` callback attached, exactly
 * as `claude-adapter.ts` wires them. They differ in ONE input:
 *
 * - the `CLAUDE_BASH_*` sequence below is the hook stating no permission
 *   opinion — the engine asked through `canUseTool`, the tool ran, and its
 *   `tool_result` came back;
 * - `CLAUDE_BASH_DEFERRED_RESULT` is the same run with the hook answering
 *   `permissionDecision: 'defer'`. `canUseTool` was never called, no
 *   `tool_result` was ever emitted, and the engine ended the turn on the spot
 *   with `stop_reason: 'tool_deferred'` and the unexecuted call on
 *   `deferred_tool_use`.
 *
 * Scrubbed, not synthesised: absolute paths became `/workspace/example`,
 * session/message uuids and the request id became fixed placeholders, and the
 * reported model became `claude-sonnet-4-5`. Every other field, and the shape
 * of all of them, is as the engine emitted it — which is the point: a mapper
 * test that passes here passes against messages Claude Code actually sends.
 */
/** The reply's text half, before the tool call. */
export const CLAUDE_BASH_TEXT_ASSISTANT = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-4-5',
    id: 'msg_011CekmsX4M3aRdc5LvdaBHz',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'TURN ONE OK.',
      },
    ],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 41890,
      cache_read_input_tokens: 11109,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 41890,
      },
      output_tokens: 1,
      service_tier: 'standard',
      inference_geo: 'not_available',
    },
    diagnostics: null,
    context_management: null,
  },
  parent_tool_use_id: null,
  session_id: '11111111-1111-4111-8111-111111111111',
  uuid: '22222222-2222-4222-8222-000000000001',
  timestamp: '2026-09-05T18:34:57.855Z',
  request_id: 'req_00000000000000000000000000',
} as unknown as SDKMessage;

/** The top-level `Bash pwd` call — what `tool.started` is mapped from. */
export const CLAUDE_BASH_TOOL_USE_ASSISTANT = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-4-5',
    id: 'msg_011CekmsX4M3aRdc5LvdaBHz',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01QuzhUwwwRumEUn3peJnLpw',
        name: 'Bash',
        input: {
          command: 'pwd',
          description: 'Print current working directory',
        },
        caller: {
          type: 'direct',
        },
      },
    ],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 41890,
      cache_read_input_tokens: 11109,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 41890,
      },
      output_tokens: 1,
      service_tier: 'standard',
      inference_geo: 'not_available',
    },
    diagnostics: null,
    context_management: null,
  },
  parent_tool_use_id: null,
  session_id: '11111111-1111-4111-8111-111111111111',
  uuid: '22222222-2222-4222-8222-000000000002',
  timestamp: '2026-09-05T18:34:58.566Z',
  request_id: 'req_00000000000000000000000000',
} as unknown as SDKMessage;

/** Its `tool_result`, carrying the command's stdout. */
export const CLAUDE_BASH_TOOL_RESULT_USER = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01QuzhUwwwRumEUn3peJnLpw',
        type: 'tool_result',
        content: '/workspace/example',
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: null,
  session_id: '11111111-1111-4111-8111-111111111111',
  uuid: '22222222-2222-4222-8222-000000000003',
  timestamp: '2026-09-05T18:34:58.935Z',
  tool_use_result: {
    stdout: '/workspace/example',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
} as unknown as SDKMessage;

/** The reply the model gave once it had the output. */
export const CLAUDE_BASH_FINAL_TEXT_ASSISTANT = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-4-5',
    id: 'msg_011CekmskWDtjAvYx23G5Awk',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'The directory is `/workspace/example`.',
      },
    ],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 32,
      cache_creation_input_tokens: 120,
      cache_read_input_tokens: 52999,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 120,
      },
      output_tokens: 1,
      service_tier: 'standard',
      inference_geo: 'not_available',
    },
    diagnostics: null,
    context_management: null,
  },
  parent_tool_use_id: null,
  session_id: '11111111-1111-4111-8111-111111111111',
  uuid: '22222222-2222-4222-8222-000000000004',
  timestamp: '2026-09-05T18:34:59.885Z',
  request_id: 'req_00000000000000000000000000',
} as unknown as SDKMessage;

/** The resolved turn: `stop_reason: 'end_turn'`, two engine turns. */
export const CLAUDE_BASH_END_TURN_RESULT = {
  duration_api_ms: 3781,
  stop_reason: 'end_turn',
  session_id: '11111111-1111-4111-8111-111111111111',
  total_cost_usd: 0.8615669999999999,
  usage: {
    input_tokens: 34,
    cache_creation_input_tokens: 42010,
    cache_read_input_tokens: 64108,
    output_tokens: 100,
    output_tokens_details: {
      thinking_tokens: 0,
    },
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
    cache_creation: {
      ephemeral_1h_input_tokens: 42010,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: 'not_available',
    iterations: [
      {
        input_tokens: 32,
        output_tokens: 15,
        cache_read_input_tokens: 52999,
        cache_creation_input_tokens: 120,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 120,
        },
        type: 'message',
      },
    ],
    speed: 'standard',
  },
  modelUsage: {
    'claude-sonnet-4-5': {
      inputTokens: 34,
      outputTokens: 100,
      cacheReadInputTokens: 64108,
      cacheCreationInputTokens: 42010,
      webSearchRequests: 0,
      costUSD: 0.8615669999999999,
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      thinkingTokens: 0,
      canonicalModel: 'claude-sonnet-4-5',
      provider: 'firstParty',
      costBasis: 'list',
    },
  },
  permission_denials: [],
  terminal_reason: 'completed',
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required',
  subagent_stats: {
    spawned: 0,
    requested: {
      background: 0,
      foreground: 0,
      unset: 0,
    },
    started_in_background: 0,
    max_depth: 0,
    spawned_by_subagents: 0,
    completed: 0,
    failed: 0,
    killed: {
      parent: 0,
      user: 0,
      system: 0,
    },
    refused: {
      depth_limit: 0,
      concurrency_limit: 0,
      budget: 0,
    },
    by_type: {},
  },
  is_error: false,
  num_turns: 2,
  subtype: 'success',
  api_error_status: null,
  result: 'The directory is `/workspace/example`.',
  ttft_ms: 2135,
  type: 'result',
  duration_ms: 4272,
  uuid: '22222222-2222-4222-8222-000000000005',
  ttft_stream_ms: 1179,
  time_to_request_ms: 29,
  first_content_frame_ms: 1179,
  queued_turn_count: 0,
} as unknown as SDKMessage;

/**
 * The turn the engine handed back after a `defer`: no `tool_result` for
 * `deferred_tool_use.id` was emitted before it, and none ever will be.
 */
export const CLAUDE_BASH_DEFERRED_RESULT = {
  duration_api_ms: 5093,
  stop_reason: 'tool_deferred',
  session_id: '11111111-1111-4111-8111-111111111111',
  total_cost_usd: 1.06423,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 52998,
    cache_read_input_tokens: 0,
    output_tokens: 85,
    output_tokens_details: {
      thinking_tokens: 0,
    },
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
    cache_creation: {
      ephemeral_1h_input_tokens: 52998,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: 'not_available',
    iterations: [
      {
        input_tokens: 2,
        output_tokens: 85,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 52998,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 52998,
        },
        type: 'message',
      },
    ],
    speed: 'standard',
  },
  modelUsage: {
    'claude-sonnet-4-5': {
      inputTokens: 2,
      outputTokens: 85,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 52998,
      webSearchRequests: 0,
      costUSD: 1.06423,
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      thinkingTokens: 0,
      canonicalModel: 'claude-sonnet-4-5',
      provider: 'firstParty',
      costBasis: 'list',
    },
  },
  permission_denials: [],
  terminal_reason: 'tool_deferred',
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required',
  subagent_stats: {
    spawned: 0,
    requested: {
      background: 0,
      foreground: 0,
      unset: 0,
    },
    started_in_background: 0,
    max_depth: 0,
    spawned_by_subagents: 0,
    completed: 0,
    failed: 0,
    killed: {
      parent: 0,
      user: 0,
      system: 0,
    },
    refused: {
      depth_limit: 0,
      concurrency_limit: 0,
      budget: 0,
    },
    by_type: {},
  },
  is_error: false,
  num_turns: 1,
  subtype: 'success',
  result: '',
  deferred_tool_use: {
    id: 'toolu_01QuzhUwwwRumEUn3peJnLpw',
    name: 'Bash',
    input: {
      command: 'pwd',
      description: 'Print current working directory',
    },
  },
  type: 'result',
  duration_ms: 5129,
  uuid: '22222222-2222-4222-8222-000000000008',
  queued_turn_count: 0,
} as unknown as SDKMessage;
