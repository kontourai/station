/**
 * station#3413: the pure fold behind `get_session_digest`. The route test
 * (`runtime-routes-station-control-project-activity.test.ts`) reaches it
 * through real events; these pin the bounds with shapes a route fixture does
 * not need to build.
 */
import { describe, expect, test } from 'vitest';
import {
  TURN_DIGEST_PROMPT_PREFIX_CHARS,
  type TurnDigestFacts,
} from '../event-store.js';
import {
  type DigestTurn,
  decodeDigestCursor,
  digestTurn,
  digestTurnOutcome,
  encodeDigestCursor,
  fitDigestPage,
} from '../session-digest.js';

const facts = (overrides: Partial<TurnDigestFacts> = {}): TurnDigestFacts => ({
  threadId: 't',
  turnId: 'turn-1',
  startedAt: '2026-10-05T10:00:00.000Z',
  startSequence: 10,
  toolCalls: [],
  filesTotal: 0,
  files: [],
  declaredPullRequests: [],
  ...overrides,
});

describe('digestTurnOutcome', () => {
  test.each([
    [undefined, 'open'],
    [{ method: 'turn.completed' as const }, 'completed'],
    [{ method: 'turn.completed' as const, finishReason: 'stop' }, 'completed'],
    [
      { method: 'turn.completed' as const, finishReason: 'cancelled' },
      'interrupted',
    ],
    [{ method: 'turn.aborted' as const }, 'interrupted'],
    [{ method: 'runtime.error' as const }, 'failed'],
  ])('%j is %s', (terminal, expected) => {
    expect(digestTurnOutcome(terminal)).toBe(expected);
  });
});

describe('digestTurn', () => {
  test('the request is the first non-empty line, clipped, and says when more of that line exists', () => {
    expect(
      digestTurn(facts({ promptPrefix: '\n  \n  Do the thing  \nmore' }), []),
    ).toMatchObject({ request: 'Do the thing' });
    expect(
      digestTurn(facts({ promptPrefix: 'Do the thing\nmore' }), [])
        .requestClipped,
    ).toBeUndefined();
    const long = digestTurn(facts({ promptPrefix: 'x'.repeat(2000) }), []);
    expect(long.request!.length).toBeLessThan(260);
    expect(long.requestClipped).toBe(true);
    // The store cut the prompt at its prefix, mid-line: still reported.
    const cut = digestTurn(
      facts({ promptPrefix: 'y'.repeat(TURN_DIGEST_PROMPT_PREFIX_CHARS) }),
      [],
    );
    expect(cut.requestClipped).toBe(true);
    // No prompt (an engine-opened turn): no request, no invented one.
    const none = digestTurn(facts({ providerTriggered: true }), []);
    expect(none.request).toBeUndefined();
    expect(none.providerTriggered).toBe(true);
  });

  test('tools beyond the listed names are counted, not dropped', () => {
    const toolCalls = Array.from({ length: 12 }, (_, index) => ({
      toolName: `tool-${index}`,
      calls: 12 - index,
    }));
    const turn = digestTurn(facts({ toolCalls }), []);
    expect(turn.toolCalls).toHaveLength(8);
    expect(turn.otherTools).toEqual({
      names: 4,
      calls: 4 + 3 + 2 + 1,
    });
    const total =
      turn.toolCalls.reduce((sum, entry) => sum + entry.calls, 0) +
      turn.otherTools!.calls;
    expect(total).toBe(toolCalls.reduce((sum, entry) => sum + entry.calls, 0));
  });

  test('only pull-request declarations count; files, pull requests and children state their totals', () => {
    const pullRequest = (ref: string) => ({
      kind: 'pull-request',
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'o', name: 'r' },
      ref,
      nativeId: ref,
    });
    const turn = digestTurn(
      facts({
        filesTotal: 30,
        files: Array.from({ length: 30 }, (_, index) => `f-${index}`),
        declaredPullRequests: [
          ...Array.from({ length: 7 }, (_, index) =>
            pullRequest(String(index)),
          ),
          { kind: 'workspace-file', relativePath: 'a', digest: 'd', length: 1 },
          'not an object',
        ],
      }),
      Array.from({ length: 9 }, (_, index) => ({
        sessionId: `child-${index}`,
      })),
    );
    expect(turn.files).toHaveLength(8);
    expect(turn.filesTotal).toBe(30);
    expect(turn.pullRequests).toHaveLength(5);
    expect(turn.pullRequestsTotal).toBe(7);
    expect(turn.delegatedChildren).toHaveLength(5);
    expect(turn.delegatedChildrenTotal).toBe(9);
    // Nothing recorded, nothing said.
    const empty = digestTurn(facts(), []);
    expect(Object.keys(empty).sort()).toEqual([
      'outcome',
      'startedAt',
      'toolCalls',
      'turnId',
    ]);
  });
});

describe('fitDigestPage', () => {
  const turn = (n: number, request: string): DigestTurn => ({
    turnId: `turn-${n}`,
    startedAt: '2026-10-05T10:00:00.000Z',
    request,
    outcome: 'completed',
    toolCalls: [],
  });

  test('takes the longest prefix under 8 KiB and always at least one turn', () => {
    const turns = Array.from({ length: 200 }, (_, index) =>
      turn(index, 'r'.repeat(200)),
    );
    const { turns: page, bytes } = fitDigestPage(turns);
    expect(page.length).toBeGreaterThan(10);
    expect(page.length).toBeLessThan(200);
    expect(bytes).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
    // One more turn would not have fit: the page ended for the cap.
    expect(
      Buffer.byteLength(JSON.stringify(turns.slice(0, page.length + 1))),
    ).toBeGreaterThan(8192);
    expect(page).toEqual(turns.slice(0, page.length));
    expect(fitDigestPage([])).toEqual({ turns: [], bytes: 2 });
  });

  test('a single turn over the cap is an error, never a cut answer', () => {
    expect(() => fitDigestPage([turn(1, 'r'.repeat(9000))])).toThrow(
      /exceeds the page byte cap/,
    );
  });
});

describe('digest cursors', () => {
  test('round trip, and anything else is refused', () => {
    const cursor = { conversationId: 'conversation-1', before: 42 };
    expect(decodeDigestCursor(encodeDigestCursor(cursor))).toEqual(cursor);
    for (const bad of [
      '',
      'not base64!',
      Buffer.from('{"v":2,"c":"x","b":1}').toString('base64url'),
      Buffer.from('{"v":1,"c":"x","b":0}').toString('base64url'),
      Buffer.from('{"v":1,"c":"x","b":1.5}').toString('base64url'),
      Buffer.from('{"v":1,"c":7,"b":1}').toString('base64url'),
      'a'.repeat(2000),
    ])
      expect(decodeDigestCursor(bad)).toBeUndefined();
  });
});
