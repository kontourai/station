import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runCoreCommand } from '../commands/core.js';
import {
  buildApprovalsRespondCommand,
  createSessionClient,
  shellQuote,
} from '../commands/session-client.js';

/**
 * #3304: `sessions list` against the real `/agents/:slug/conversations` page
 * shape, `{ items, hasMore, nextCursor? }`.
 */
describe('managed sessions list pagination', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let pages: Record<string, unknown>;
  const requested: string[] = [];
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    requested.length = 0;
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/binding')) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false }));
        return;
      }
      requested.push(url.search);
      const body = pages[url.searchParams.get('cursor') ?? ''];
      res.end(JSON.stringify({ success: true, data: body }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    stderr.mockRestore();
    await new Promise((resolve) => server.close(resolve));
  });

  const list = async () =>
    (
      await createSessionClient(apiBase, {
        agentSlug: agentId('station'),
        classifiedExternalTarget: null,
      })
    ).listSessions();
  const item = (id: string) => ({ id, title: id });

  test('follows nextCursor across pages without a warning', async () => {
    pages = {
      '': { items: [item('a')], hasMore: true, nextCursor: 'c1' },
      c1: { items: [item('b')], hasMore: false },
    };
    const sessions = await list();
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(requested).toEqual(['', '?cursor=c1']);
    expect(stderr).not.toHaveBeenCalled();
  });

  test('hasMore with no cursor warns on stderr that the listing is truncated', async () => {
    pages = { '': { items: [item('a')], hasMore: true } };
    const sessions = await list();
    expect(sessions.map((s) => s.id)).toEqual(['a']);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      'more conversations exist',
    );
  });

  test('a cursor that never ends stops at the page bound with a warning', async () => {
    pages = new Proxy(
      {},
      {
        get: (_t, key) => {
          const n = key === '' ? 0 : Number(key) + 1;
          return { items: [item(`x${n}`)], hasMore: true, nextCursor: `${n}` };
        },
      },
    );
    const sessions = await list();
    expect(sessions).toHaveLength(20);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      'stopped after 20 pages',
    );
  });

  test('a repeated cursor stops with a warning and de-dupes items by id', async () => {
    pages = {
      '': { items: [item('a')], hasMore: true, nextCursor: 'loop' },
      loop: {
        items: [item('a'), item('b')],
        hasMore: true,
        nextCursor: 'loop',
      },
    };
    const sessions = await list();
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(requested).toEqual(['', '?cursor=loop']);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      'repeated a page cursor',
    );
  });

  test('an unknown response shape is an error, not an empty list', async () => {
    pages = { '': { rows: [] } };
    await expect(list()).rejects.toThrow('Unexpected conversations response');
  });
});

/**
 * The copy-paste hints (`Respond:`, `Resume:`, and `respondCommand` under
 * `--json`) must survive the shell they are pasted into. cmd.exe keeps single
 * quotes as literal characters, so POSIX quoting there named ids that do not
 * exist — the defect #2805 fixed for `--home`.
 */
describe('shellQuote', () => {
  test.each(['thr_1', 'task:12', 'conversation:ordinary:child', 'a/b.c-d'])(
    'prints the safe token %s bare on every platform',
    (token) => {
      expect(shellQuote(token, 'linux')).toBe(token);
      expect(shellQuote(token, 'win32')).toBe(token);
    },
  );

  test.each<[value: string, posix: string, windows: string]>([
    ['has space', "'has space'", '"has space"'],
    ["it's", "'it'\\''s'", '"it\'s"'],
    ['say "hi"', '\'say "hi"\'', '"say \\"hi\\""'],
    ['$HOME', "'$HOME'", '"$HOME"'],
    ['dir\\', "'dir\\'", '"dir\\\\"'],
    ['', "''", '""'],
  ])('quotes %j for the shell of its platform', (value, posix, windows) => {
    expect(shellQuote(value, 'linux')).toBe(posix);
    expect(shellQuote(value, 'darwin')).toBe(posix);
    expect(shellQuote(value, 'win32')).toBe(windows);
  });

  test('the respond command leaves ordinary ids bare', () => {
    expect(buildApprovalsRespondCommand('thr_1', 'req_1')).toBe(
      'station approvals respond thr_1 req_1 <accept|acceptForSession|decline|cancel>',
    );
  });
});

test('sessions list selects an offline runtime by binding and filters by recorded Agent', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const send = (data: unknown) =>
      response.end(JSON.stringify({ success: true, data }));
    const binding = request.url?.match(/^\/api\/agents\/([^/]+)\/binding$/);
    if (binding) {
      const slug = binding[1];
      if (slug === 'managed') {
        return send({ agentConnectionId: 'station', engineId: 'station' });
      }
      if (slug === 'ambiguous') {
        return send({ agentConnectionId: 'fixture-claude' });
      }
      return send({ agentConnectionId: 'fixture-claude', engineId: 'claude' });
    }
    if (request.url === '/api/connections/fixture-claude') {
      return send({
        kind: 'agent',
        enabled: true,
        status: 'missing_prerequisites',
        capabilities: ['agent-runtime'],
        config: { provider: 'claude' },
      });
    }
    if (request.url?.match(/^\/agents\/(managed|ambiguous)\/conversations$/)) {
      return send({ items: [{ id: 'managed-root' }], hasMore: false });
    }
    if (request.url !== '/api/orchestration/sessions/read-model') {
      response.writeHead(404).end(JSON.stringify({ success: false }));
      return;
    }
    response.end(
      JSON.stringify({
        success: true,
        data: [
          {
            threadId: 'root-alpha',
            provider: 'claude',
            assignedAgentSlug: 'alpha',
          },
          {
            threadId: 'root-alpha:session:child',
            provider: 'claude',
            assignedAgentSlug: 'alpha',
          },
          {
            threadId: 'beta-only',
            provider: 'claude',
            assignedAgentSlug: 'beta',
          },
          { threadId: 'unassigned-legacy', provider: 'claude' },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const list = async (slug: string) => {
      log.mockClear();
      await runCoreCommand('sessions', ['list', slug, `--api-base=${apiBase}`]);
      return JSON.parse(String(log.mock.calls.at(-1)?.[0])).map(
        (row: { id: string }) => row.id,
      );
    };
    await expect(list('alpha')).resolves.toEqual([
      'root-alpha',
      'root-alpha:session:child',
    ]);
    await expect(list('beta')).resolves.toEqual(['beta-only']);
    await expect(list('claude')).resolves.toEqual(['unassigned-legacy']);
    await expect(list('managed')).resolves.toEqual(['managed-root']);
    await expect(list('ambiguous')).resolves.toEqual(['managed-root']);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
