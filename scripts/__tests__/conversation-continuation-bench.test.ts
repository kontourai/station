import { describe, expect, test } from 'vitest';
import {
  descendantProcesses,
  summarize,
} from '../bench/conversation-continuation-bench.mjs';

describe('conversation continuation benchmark (#2540)', () => {
  test('counts only the server tree, including grandchildren', () => {
    const ps = [
      '  100     1  1000 node dist-server/command-station.js',
      '  200   100  2048 /usr/local/bin/claude --output-format stream-json',
      '  201   200   512 node mcp-server.js',
      '  300   100  4096 codex app-server',
      '  999     1  8192 unrelated process',
    ].join('\n');
    const tree = descendantProcesses(ps, 100);
    expect(tree.map((row) => row.pid).sort()).toEqual([200, 201, 300]);
    expect(tree.reduce((sum, row) => sum + row.rss, 0)).toBe(6656);
  });

  test('a follow-up only counts as working when its turn completed', () => {
    const summary = summarize({
      codex: {
        sessions: ['a'],
        turns: [
          {
            turn: 0,
            outcome: 'turn.completed',
            firstTextMs: 900,
            totalMs: 1000,
            processes: { count: 1, rssMb: 100 },
          },
          { turn: 1, error: 'thread already has an active writer' },
          { turn: 2, outcome: 'timeout', processes: { count: 3, rssMb: 300 } },
        ],
      },
      claude: {
        sessions: ['a', 'b', 'c'],
        turns: [
          {
            turn: 0,
            outcome: 'turn.completed',
            firstTextMs: 900,
            totalMs: 1000,
          },
          {
            turn: 1,
            outcome: 'turn.completed',
            firstTextMs: 500,
            totalMs: 700,
          },
          {
            turn: 2,
            outcome: 'turn.completed',
            firstTextMs: 300,
            totalMs: 400,
          },
        ],
      },
    });
    expect(summary.codex).toMatchObject({
      followups: 2,
      followupFailures: 2,
      medianFollowupFirstTextMs: null,
      maxProcesses: 3,
      maxRssMb: 300,
    });
    expect(summary.claude).toMatchObject({
      followups: 2,
      followupFailures: 0,
      sessionsUsed: 3,
      medianFollowupFirstTextMs: 500,
    });
  });
});
