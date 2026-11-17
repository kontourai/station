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
 * `station conversation settle|reopen <conversationId>`, driven through
 * `runCli` against a real HTTP server standing in for
 * `PUT /api/conversations/:id/work-state` with the bodies that route answers
 * (`routes/chat/conversation-work-state.ts`). The route's own preview,
 * person and admission checks are proved by its mounted tests.
 */
describe('station conversation settle and reopen over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let consoleLog: MockInstance;
  let consoleError: MockInstance;
  let exit: MockInstance;
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    requests.length = 0;
    reply = { status: 200, body: { success: true } };
    server = createServer(async (req, res) => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method,
        path: url.pathname,
        ...(method === 'PUT' ? { body: await readBody(req) } : {}),
      });
      const answer =
        method === 'PUT' && url.pathname.endsWith('/work-state')
          ? reply
          : { status: 404, body: { success: false, error: 'Not found' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
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

  test.each([
    ['settle', true, 'Settled conversation conversation/1'],
    ['reopen', false, 'Reopened conversation conversation/1'],
  ] as const)(
    '%s sends settled=%s and reports it',
    async (verb, settled, line) => {
      const { runCli } = await import('../cli.js');
      await runCli([
        'conversation',
        verb,
        'conversation/1',
        `--api-base=${apiBase}`,
      ]);
      expect(requests).toEqual([
        {
          method: 'PUT',
          path: '/api/conversations/conversation%2F1/work-state',
          body: { settled },
        },
      ]);
      expect(printed()).toBe(line);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  test('--json prints the change under the CLI envelope', async () => {
    const { runCli } = await import('../cli.js');
    await runCli([
      'conversation',
      'settle',
      'conversation-1',
      '--json',
      `--api-base=${apiBase}`,
    ]);
    expect(JSON.parse(printed())).toEqual({
      ok: true,
      kind: 'conversation.work-state',
      data: { conversationId: 'conversation-1', settled: true },
    });
  });

  test('a Station with the preview off refuses it: reported, exit 3', async () => {
    reply = {
      status: 404,
      body: {
        success: false,
        code: 'feature_preview_disabled',
        previewId: 'conversation-resolution',
        error:
          'Enable Open and Settled inbox in Settings → Advanced → Feature previews.',
      },
    };
    const { runCli } = await import('../cli.js');
    await runCli([
      'conversation',
      'settle',
      'conversation-1',
      `--api-base=${apiBase}`,
    ]);
    expect(exit).toHaveBeenCalledWith(3);
    expect(String(consoleError.mock.calls[0]?.[1])).toMatch(
      /Open and Settled inbox|preview/,
    );
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test('a missing conversation id is a usage error before any request', async () => {
    const { runCli } = await import('../cli.js');
    await expect(
      runCli(['conversation', 'reopen', `--api-base=${apiBase}`]),
    ).rejects.toThrow(/conversation id/);
    expect(requests).toEqual([]);
  });
});
