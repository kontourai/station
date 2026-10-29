import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { readBody } from './helpers/http-test-helpers.js';

/**
 * #3427: `station claims list` and `station conversation fork`, driven through
 * `runCli` against a real HTTP server standing in for the two routes, with the
 * exact body shapes they answer (`routes/orchestration/session-work-claims.ts`
 * `GET /` and `routes/chat/conversations.ts` `POST .../fork`). The routes'
 * own behavior, including the fork scope rule for agents, is proved by their
 * mounted tests.
 */

/** A claim exactly as `workClaimView` writes it. */
const CLAIM = {
  claimId: 'claim_1',
  sessionId: 'session-1',
  conversationId: 'conversation-1',
  scope: { kind: 'project', id: 'project-id-1' },
  taskId: 'task-1',
  workItemRef: 'kontourai/station#3427',
  paths: ['packages/cli/src/commands/claims.ts'],
  note: 'Adding the claims verb',
  claimedAt: '2026-10-28T10:00:00.000Z',
  renewedAt: '2026-10-28T10:00:00.000Z',
  expiresAt: '2026-10-28T11:00:00.000Z',
};

/** A fork reply exactly as `forkReply` writes it. */
const FORK = {
  conversationId: 'conversation:fork:abc',
  seed: 'replayed history',
  branchPointTurnId: 'turn-2',
  sourceSessionId: 'session-1',
  continuation: 'replay-seed',
  disclosure:
    'The engine replays text from the selected history. Engine cursor, tool state, and approval state do not carry.',
  idempotent: false,
};

describe('station claims and conversation fork over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let consoleLog: MockInstance;
  let consoleError: MockInstance;
  let exit: MockInstance;
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let claimsReply: { status: number; body: unknown };
  let forkReply: { status: number; body: unknown };

  beforeEach(async () => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    requests.length = 0;
    claimsReply = {
      status: 200,
      body: { success: true, data: { claims: [CLAIM] } },
    };
    forkReply = { status: 200, body: { success: true, data: FORK } };
    server = createServer(async (req, res) => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = method === 'POST' ? await readBody(req) : undefined;
      requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        ...(body === undefined ? {} : { body }),
      });
      const reply =
        method === 'GET' && url.pathname === '/api/orchestration/work-claims'
          ? claimsReply
          : method === 'POST' && url.pathname.endsWith('/fork')
            ? forkReply
            : { status: 404, body: { success: false, error: 'Not found' } };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
  });

  const printed = () => consoleLog.mock.calls.map((call) => call[0]).join('\n');

  describe('claims list', () => {
    test('--json prints the route projection under the CLI envelope', async () => {
      const { runCli } = await import('../cli.js');
      await runCli(['claims', 'list', '--json', `--api-base=${apiBase}`]);
      expect(JSON.parse(printed())).toEqual({
        ok: true,
        kind: 'claims.list',
        data: { claims: [CLAIM] },
      });
      expect(requests).toEqual([
        { method: 'GET', path: '/api/orchestration/work-claims' },
      ]);
      expect(exit).not.toHaveBeenCalled();
    });

    test('the human summary escapes terminal controls an agent could write into a note', async () => {
      claimsReply = {
        status: 200,
        body: {
          success: true,
          data: {
            // C1 CSI (U+009B) passes the route's C0 check; it must not
            // reach the terminal raw.
            claims: [{ ...CLAIM, note: 'done \u009b31mRED' }],
          },
        },
      };
      const { runCli } = await import('../cli.js');
      await runCli(['claims', 'list', `--api-base=${apiBase}`]);
      const human = printed();
      expect(human).toContain(
        'claim_1: kontourai/station#3427, packages/cli/src/commands/claims.ts',
      );
      expect(human).toContain(
        'Session session-1 in Project project-id-1, Task task-1; expires 2026-10-28T11:00:00.000Z',
      );
      expect(human).toContain('done \\u009b31mRED');
      expect(human).not.toContain('\u009b');
    });

    test('a claim the contract cannot read fails the read rather than vanishing', async () => {
      claimsReply = {
        status: 200,
        body: {
          success: true,
          data: { claims: [CLAIM, { claimId: 'claim_2' }] },
        },
      };
      const { runCli } = await import('../cli.js');
      await runCli(['claims', 'list', '--json', `--api-base=${apiBase}`]);
      expect(exit).toHaveBeenCalledWith(3);
      expect(consoleError).toHaveBeenCalledWith(
        'Error:',
        'Work claims response entry 1 is not a claim.',
      );
      expect(consoleLog).not.toHaveBeenCalled();
    });

    test('a Station without the route says so and exits 3', async () => {
      claimsReply = {
        status: 404,
        body: { success: false, error: 'Not found' },
      };
      const { runCli } = await import('../cli.js');
      await runCli(['claims', 'list', `--api-base=${apiBase}`]);
      expect(exit).toHaveBeenCalledWith(3);
      expect(consoleError).toHaveBeenCalledWith(
        'Error:',
        'This Station does not answer work claims. Update it to a version that does.',
      );
    });

    test('an unreachable Station exits 2', async () => {
      const { runCli } = await import('../cli.js');
      await new Promise((resolve) => server.close(resolve));
      await runCli(['claims', 'list', `--api-base=${apiBase}`]);
      expect(exit).toHaveBeenCalledWith(2);
      // Reopen so afterEach can close it.
      server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
    });

    test('only list exists', async () => {
      const { runCli } = await import('../cli.js');
      await expect(
        runCli(['claims', 'claim', `--api-base=${apiBase}`]),
      ).rejects.toThrow('Unknown claims subcommand "claim" (expected: list)');
      expect(requests).toEqual([]);
    });
  });

  describe('conversation fork', () => {
    test('sends the fork request and prints the route projection under --json', async () => {
      const { runCli } = await import('../cli.js');
      await runCli([
        'conversation',
        'fork',
        'terra',
        'conversation-1',
        '--target-agent=luna',
        '--project=demo',
        '--turn=turn-2',
        '--idempotency-key=retry-1',
        '--json',
        `--api-base=${apiBase}`,
      ]);
      expect(requests).toEqual([
        {
          method: 'POST',
          path: '/agents/terra/conversations/conversation-1/fork',
          body: {
            targetAgent: 'luna',
            targetProjectSlug: 'demo',
            branchPointTurnId: 'turn-2',
            idempotencyKey: 'retry-1',
          },
        },
      ]);
      expect(JSON.parse(printed())).toEqual({
        ok: true,
        kind: 'conversation.fork',
        data: FORK,
      });
    });

    test('defaults the target Agent to the source and names nothing else', async () => {
      const { runCli } = await import('../cli.js');
      await runCli([
        'conversation',
        'fork',
        'terra',
        'conversation-1',
        `--api-base=${apiBase}`,
      ]);
      expect(requests[0]?.body).toEqual({ targetAgent: 'terra' });
      expect(printed()).toBe(
        `Forked conversation-1 into conversation conversation:fork:abc (from turn turn-2)\n${FORK.disclosure}`,
      );
    });

    test("the human summary escapes terminal controls in the Station's reply", async () => {
      forkReply = {
        status: 200,
        body: {
          success: true,
          data: { ...FORK, disclosure: 'replayed \u009b31mRED' },
        },
      };
      const { runCli } = await import('../cli.js');
      await runCli([
        'conversation',
        'fork',
        'terra',
        'conversation-1',
        `--api-base=${apiBase}`,
      ]);
      expect(printed()).toContain('replayed \\u009b31mRED');
      expect(printed()).not.toContain('\u009b');
    });

    test("the route's refusal is reported and exits 3", async () => {
      forkReply = {
        status: 409,
        body: {
          success: false,
          error:
            'Fork from a completed assistant turn. The selected turn is not complete.',
        },
      };
      const { runCli } = await import('../cli.js');
      await runCli([
        'conversation',
        'fork',
        'terra',
        'conversation-1',
        `--api-base=${apiBase}`,
      ]);
      expect(exit).toHaveBeenCalledWith(3);
      expect(String(consoleError.mock.calls[0]?.[1])).toContain(
        'The selected turn is not complete.',
      );
      expect(consoleLog).not.toHaveBeenCalled();
    });
  });
});
