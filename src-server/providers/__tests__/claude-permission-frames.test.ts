import { describe, expect, test } from 'vitest';
import {
  ClaudePermissionAsks,
  ClaudePermissionFrameTap,
  MAX_RECORDED_PERMISSION_ASKS,
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

  test('records the requests an initialize response replays in pending_permission_requests', async () => {
    const asks = new ClaudePermissionAsks();
    const replayed = (id: string, type: string) =>
      JSON.parse(
        claudeCanUseToolFrame(id, {
          tool_name: 'Bash',
          input: { command: 'git push' },
          decision_reason_type: type,
        }),
      );
    await forward(new ClaudePermissionFrameTap(asks), [
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'init-1',
          response: { commands: [], models: [] },
          pending_permission_requests: [
            replayed('req-replay-1', 'rule'),
            replayed('req-replay-2', 'subcommandResults'),
          ],
          pending_user_dialog_requests: [],
        },
      })}\n`,
    ]);
    expect(asks.take('req-replay-1')).toEqual({ decisionReasonType: 'rule' });
    expect(asks.take('req-replay-2')).toEqual({
      decisionReasonType: 'subcommandResults',
    });
  });

  test('ignores other control requests, other frames and unknown field shapes', async () => {
    const asks = new ClaudePermissionAsks();
    await forward(new ClaudePermissionFrameTap(asks), [
      // Another control request subtype that happens to mention the marker.
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-hook',
        request: { subtype: 'hook_callback', note: '"can_use_tool"' },
      })}\n`,
      // A message that quotes a frame inside a string.
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

  test('re-recording a request id replaces its ask without growing', () => {
    const asks = new ClaudePermissionAsks(2);
    asks.record('a', { decisionReasonType: 'rule' });
    asks.record('a', { decisionReasonType: 'safetyCheck' });
    expect(asks.size).toBe(1);
    expect(asks.take('a')).toEqual({ decisionReasonType: 'safetyCheck' });
  });
});
