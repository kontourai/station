import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSessionClient } from '../commands/session-client.js';

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
        get: () => ({ items: [item('x')], hasMore: true, nextCursor: 'again' }),
      },
    );
    const sessions = await list();
    expect(sessions).toHaveLength(20);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      'stopped after 20 pages',
    );
  });

  test('an unknown response shape is an error, not an empty list', async () => {
    pages = { '': { rows: [] } };
    await expect(list()).rejects.toThrow('Unexpected conversations response');
  });
});
