import { describe, expect, test } from 'vitest';
import {
  ClaudePermissionAsks,
  ClaudePermissionFrameTap,
  MAX_RECORDED_PERMISSION_ASKS,
  noteClaudeHostFrame,
} from '../adapters/claude-permission-frames.js';
import { claudeCanUseToolFrame } from './claude-engine-process-test-utils.js';

/** Pushes chunks through a tap and returns every byte it forwarded. */
async function forward(
  tap: ClaudePermissionFrameTap,
  chunks: ReadonlyArray<Buffer | string>,
): Promise<Buffer> {
  const out: Buffer[] = [];
  tap.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)));
  const ended = new Promise<void>((resolve, reject) => {
    tap.once('end', resolve);
    tap.once('error', reject);
  });
  for (const chunk of chunks) tap.write(chunk);
  tap.end();
  await ended;
  return Buffer.concat(out);
}

function split(bytes: Buffer, size: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size)
    parts.push(bytes.subarray(at, at + size));
  return parts;
}

/** A Bash safety check as Claude Code 2.1.278 writes it. */
const safetyCheckFrame = claudeCanUseToolFrame('req-safety', {
  tool_name: 'Bash',
  display_name: 'Bash',
  input: { command: 'sleep 5 &' },
  description: 'sleep 5 &',
  decision_reason:
    'This command uses the `&` background operator, which defers execution past approval-time safety checks. Approve only if you trust it.',
  decision_reason_type: 'safetyCheck',
  classifier_approvable: false,
  tool_use_id: 'toolu_01',
});

describe('ClaudePermissionFrameTap', () => {
  test('records the structured reason of a can_use_tool frame by request id, consumed on read', async () => {
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks), [safetyCheckFrame]);
    expect(asks.take('req-safety')).toEqual({
      decisionReasonType: 'safetyCheck',
      classifierApprovable: false,
    });
    expect(asks.take('req-safety')).toBeUndefined();
  });

  test('a frame with no reason is still recorded, as an ask with no reason type', async () => {
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks), [
      claudeCanUseToolFrame('req-mcp', {
        tool_name: 'mcp__github__create_issue',
        mcp_server: { name: 'github', source: 'user' },
        display_name: 'github - create_issue (MCP)',
        input: { title: 'x' },
        tool_use_id: 'toolu_02',
        requires_user_interaction: true,
      }),
    ]);
    expect(asks.take('req-mcp')).toEqual({ requiresUserInteraction: true });
  });

  test('forwards identical bytes for split chunks, multi-byte boundaries, CRLF and non-JSON lines', async () => {
    const stream = Buffer.from(
      [
        '{"type":"system","subtype":"init","note":"héllo — 日本語 🙂"}',
        'not json at all: "can_use_tool" {',
        '',
        safetyCheckFrame.trimEnd(),
        '{"type":"assistant","text":"🙂🙂🙂"}\r',
        claudeCanUseToolFrame('req-unicode', {
          tool_name: 'Bash',
          input: { command: 'echo "日本語 🙂"' },
          decision_reason: 'This command requires approval',
          decision_reason_type: 'other',
        }).trimEnd(),
        'trailing line with no newline 🙂',
      ].join('\n'),
    );
    for (const size of [1, 2, 3, 5, 7, 64, stream.length]) {
      const asks = new ClaudePermissionAsks();
      const out = await forward(
        new ClaudePermissionFrameTap(asks),
        split(stream, size),
      );
      expect(out.equals(stream), `chunk size ${size}`).toBe(true);
      expect(asks.size, `chunk size ${size}`).toBe(2);
      expect(asks.take('req-safety')).toEqual({
        decisionReasonType: 'safetyCheck',
        classifierApprovable: false,
      });
      expect(asks.take('req-unicode')).toEqual({ decisionReasonType: 'other' });
    }
  });

  test('a final frame with no trailing newline is recorded when the stream ends', async () => {
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks), [
      safetyCheckFrame.trimEnd(),
    ]);
    expect(asks.take('req-safety')).toBeDefined();
  });

  test('an oversize line is forwarded whole and unrecorded; the next line is read again', async () => {
    const big = claudeCanUseToolFrame('req-big', {
      tool_name: 'Write',
      input: { file_path: '/repo/a.txt', content: 'x'.repeat(4096) },
      decision_reason_type: 'safetyCheck',
    });
    const stream = Buffer.from(big + safetyCheckFrame);
    for (const size of [17, stream.length]) {
      const asks = new ClaudePermissionAsks();
      const out = await forward(
        new ClaudePermissionFrameTap(asks, 1024),
        split(stream, size),
      );
      expect(out.equals(stream)).toBe(true);
      // The oversize ask was never recorded: it reads as missing.
      expect(asks.take('req-big')).toBeUndefined();
      expect(asks.take('req-safety')).toBeDefined();
    }
    // Positive control: under the cap the same frame is recorded.
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks, 64 * 1024), [big]);
    expect(asks.take('req-big')).toEqual({ decisionReasonType: 'safetyCheck' });
  });

  const replayed = (id: string, type: string) =>
    JSON.parse(
      claudeCanUseToolFrame(id, {
        tool_name: 'Bash',
        input: { command: 'git push' },
        decision_reason_type: type,
      }),
    );
  const responseWithReplay = (requestId: string, ids: string[]) =>
    `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { commands: [], models: [] },
        pending_permission_requests: ids.map((id) => replayed(id, 'rule')),
        pending_user_dialog_requests: [],
      },
    })}\n`;
  /** The `initialize` request as the SDK writes it to the engine's stdin. */
  const initializeRequest = (requestId: string) =>
    `${JSON.stringify({
      request_id: requestId,
      type: 'control_request',
      request: { subtype: 'initialize', hooks: {} },
    })}\n`;

  test('records the requests the initialize response replays in pending_permission_requests', async () => {
    const asks = new ClaudePermissionAsks();
    noteClaudeHostFrame(asks, initializeRequest('init-1'));
    await forward(new ClaudePermissionFrameTap(asks), [
      responseWithReplay('init-1', ['req-replay-1', 'req-replay-2']),
    ]);
    expect(asks.take('req-replay-1')).toEqual({ decisionReasonType: 'rule' });
    expect(asks.take('req-replay-2')).toEqual({ decisionReasonType: 'rule' });
  });

  test('ignores a replay on any response that does not answer initialize, and reads one initialize response once', async () => {
    const asks = new ClaudePermissionAsks();
    // Another request the host sent, and a host frame that only names it.
    noteClaudeHostFrame(
      asks,
      `${JSON.stringify({
        request_id: 'set-mode-1',
        type: 'control_request',
        request: { subtype: 'set_permission_mode', mode: 'initialize' },
      })}\n`,
    );
    noteClaudeHostFrame(asks, 'not json "initialize"');
    noteClaudeHostFrame(asks, Buffer.from(initializeRequest('init-1')));
    await forward(new ClaudePermissionFrameTap(asks), [
      responseWithReplay('set-mode-1', ['req-a']),
      responseWithReplay('unknown-request', ['req-b']),
      responseWithReplay('init-1', ['req-c']),
      // The same response id again is no longer awaited.
      responseWithReplay('init-1', ['req-d']),
    ]);
    expect(asks.take('req-a')).toBeUndefined();
    expect(asks.take('req-b')).toBeUndefined();
    expect(asks.take('req-c')).toEqual({ decisionReasonType: 'rule' });
    expect(asks.take('req-d')).toBeUndefined();
  });

  test('ignores other control requests, other frames and unknown field shapes', async () => {
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks), [
      // Another control request subtype whose body names the subtype as a
      // value, so the line passes the cheap marker check and is parsed.
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-hook',
        request: {
          subtype: 'hook_callback',
          callback_id: 'can_use_tool',
          decision_reason_type: 'rule',
        },
      })}\n`,
      // A message that is no control frame but names it too.
      `${JSON.stringify({
        type: 'assistant',
        request_id: 'req-assistant',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
        note: 'can_use_tool',
      })}\n`,
      // A message that quotes a whole frame inside a string.
      `${JSON.stringify({ type: 'assistant', text: safetyCheckFrame })}\n`,
      // A reason type that is not a string: nothing is recorded.
      claudeCanUseToolFrame('req-odd-type', {
        tool_name: 'Bash',
        input: {},
        decision_reason_type: { type: 'other' },
      }),
      claudeCanUseToolFrame('req-odd-flag', {
        tool_name: 'Bash',
        input: {},
        decision_reason_type: 'other',
        classifier_approvable: 'yes',
      }),
      // No request id.
      `${JSON.stringify({
        type: 'control_request',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
      })}\n`,
    ]);
    expect(asks.size).toBe(0);
  });
});

describe('ClaudePermissionAsks', () => {
  test('never grows past its cap: the oldest unread ask is dropped and reads as missing', () => {
    const asks = new ClaudePermissionAsks(3);
    for (const id of ['a', 'b', 'c', 'd', 'e'])
      expect(asks.record(id, { decisionReasonType: 'rule' })).toBe(true);
    expect(asks.size).toBe(3);
    expect(asks.take('a')).toBeUndefined();
    expect(asks.take('b')).toBeUndefined();
    expect(asks.take('e')).toEqual({ decisionReasonType: 'rule' });
    expect(asks.size).toBe(2);
  });

  test('the default cap holds under a flood of unread frames', async () => {
    const asks = new ClaudePermissionAsks();
    const flood = Array.from(
      { length: MAX_RECORDED_PERMISSION_ASKS + 50 },
      (_unused, index) =>
        claudeCanUseToolFrame(`req-${index}`, {
          tool_name: 'Bash',
          input: {},
          decision_reason_type: 'other',
        }),
    ).join('');
    await forward(new ClaudePermissionFrameTap(asks), [flood]);
    expect(asks.size).toBe(MAX_RECORDED_PERMISSION_ASKS);
    expect(asks.take('req-0')).toBeUndefined();
    expect(asks.take(`req-${MAX_RECORDED_PERMISSION_ASKS + 49}`)).toBeDefined();
  });

  test('refuses a malformed request id and reads nothing for one', () => {
    const asks = new ClaudePermissionAsks();
    expect(asks.record(undefined, {})).toBe(false);
    expect(asks.record('', {})).toBe(false);
    expect(asks.record('x'.repeat(201), {})).toBe(false);
    expect(asks.record(42, {})).toBe(false);
    expect(asks.size).toBe(0);
    expect(asks.take(undefined)).toBeUndefined();
  });

  test('the same ask recorded twice for a request id is kept once', () => {
    const asks = new ClaudePermissionAsks(2);
    expect(asks.record('a', { decisionReasonType: 'rule' })).toBe(true);
    expect(asks.record('a', { decisionReasonType: 'rule' })).toBe(true);
    expect(asks.size).toBe(1);
    expect(asks.take('a')).toEqual({ decisionReasonType: 'rule' });
  });

  test('a different ask for a recorded request id is a conflict: the id reads as missing', () => {
    for (const [first, second] of [
      [{ decisionReasonType: 'safetyCheck' }, { decisionReasonType: 'other' }],
      [{ decisionReasonType: 'other' }, {}],
      [
        { decisionReasonType: 'other', classifierApprovable: false },
        { decisionReasonType: 'other' },
      ],
      [{ requiresUserInteraction: true as const }, {}],
      [{ decisionReasonCode: 'memory_paused' }, {}],
    ]) {
      const asks = new ClaudePermissionAsks();
      expect(asks.record('a', first)).toBe(true);
      expect(asks.record('a', second)).toBe(false);
      // Recording the benign shape again does not win either.
      expect(asks.record('a', second)).toBe(false);
      expect(asks.size).toBe(1);
      expect(asks.take('a'), JSON.stringify([first, second])).toBeUndefined();
      expect(asks.size).toBe(0);
    }
  });

  test('a live frame and a conflicting later frame for one request id leave it missing', async () => {
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks), [
      safetyCheckFrame,
      claudeCanUseToolFrame('req-safety', {
        tool_name: 'Bash',
        input: { command: 'sleep 5 &' },
        decision_reason: 'This command requires approval',
        decision_reason_type: 'other',
      }),
    ]);
    expect(asks.take('req-safety')).toBeUndefined();
  });

  test('a host frame is sized in bytes, not characters', () => {
    const initialize = (padding: string) =>
      JSON.stringify({
        request_id: 'init-big',
        type: 'control_request',
        request: { subtype: 'initialize', padding },
      });
    const characters = 5 * 1024 * 1024;
    // 5 Mi two-byte characters: under the cap in characters, over in bytes.
    const multiByte = new ClaudePermissionAsks();
    noteClaudeHostFrame(multiByte, initialize('é'.repeat(characters)));
    expect(multiByte.takeInitializeResponse('init-big')).toBe(false);
    // Positive control: the same number of one-byte characters is read.
    const ascii = new ClaudePermissionAsks();
    noteClaudeHostFrame(ascii, initialize('e'.repeat(characters)));
    expect(ascii.takeInitializeResponse('init-big')).toBe(true);
    // Anything that is neither text nor bytes is ignored, without throwing.
    for (const odd of [undefined, null, 42, {}, new Uint8Array(4)])
      expect(() => noteClaudeHostFrame(ascii, odd)).not.toThrow();
  });

  test('awaited initialize responses are bounded', () => {
    const asks = new ClaudePermissionAsks();
    for (let index = 0; index < 20; index += 1)
      asks.awaitInitializeResponse(`init-${index}`);
    expect(asks.takeInitializeResponse('init-0')).toBe(false);
    expect(asks.takeInitializeResponse('init-19')).toBe(true);
    expect(asks.takeInitializeResponse('init-19')).toBe(false);
    asks.awaitInitializeResponse('');
    expect(asks.takeInitializeResponse('')).toBe(false);
  });
});
