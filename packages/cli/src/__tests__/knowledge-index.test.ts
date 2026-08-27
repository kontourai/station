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
 * `station knowledge reindex`/`migrate` (`s201-knowledge-retrieval` Wave 4) —
 * exercises the CLI verbs against a mocked HTTP server standing in for
 * `src-server/routes/knowledge/knowledge-index-routes.ts`'s `POST /api/knowledge/index/
 * rebuild` and `POST /api/knowledge/migrate` (Wave 3), asserting the CLI
 * reports the server's returned counts and that an unknown/missing
 * `knowledge` subcommand still fails loudly (the S2 false-green invariant —
 * `runKnowledgeCommand`'s default arm throws, which propagates as a rejected
 * `runCli()` promise here and as `process.exit(1)` under real invocation via
 * `cli.ts`'s bottom-of-file `.catch`).
 */
describe('CLI knowledge reindex/migrate over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let stdoutWrite: MockInstance;
  let consoleLog: MockInstance;

  const state: {
    rebuildCalls: Array<Record<string, unknown>>;
    migrateCalls: Array<Record<string, unknown>>;
    searchCalls: Array<Record<string, unknown>>;
    rebuildResult: {
      roots: Array<{ rootId: string; records: number; chunks: number }>;
    };
    migrateResult: {
      documentsMigrated: number;
      chunksIndexed: number;
      namespacesProcessed: string[];
    };
    searchResult: Array<{
      recordId: string;
      rootId: string;
      score: number;
      title: string;
      excerpt: string;
      category: string;
    }>;
    searchError: string | null;
  } = {
    rebuildCalls: [],
    migrateCalls: [],
    searchCalls: [],
    rebuildResult: {
      roots: [{ rootId: 'root:personal', records: 3, chunks: 12 }],
    },
    migrateResult: {
      documentsMigrated: 2,
      chunksIndexed: 8,
      namespacesProcessed: ['pre-index-ns'],
    },
    searchResult: [
      {
        recordId: 'rec-1',
        rootId: 'root:personal',
        score: 0.9231,
        title: 'Standup notes',
        excerpt: 'Discussed the release plan.',
        category: 'meeting',
      },
    ],
    searchError: null,
  };

  beforeEach(async () => {
    stdoutWrite = vi.spyOn(process.stdout, 'write');
    stdoutWrite.mockImplementation(() => true);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    server = createServer(async (req, res) => {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body =
        method === 'POST' || method === 'PUT' || method === 'PATCH'
          ? await readBody(req)
          : undefined;

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (
        method === 'POST' &&
        url.pathname === '/api/knowledge/index/rebuild'
      ) {
        state.rebuildCalls.push(body ?? {});
        sendJson(200, { success: true, data: state.rebuildResult });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/knowledge/migrate') {
        state.migrateCalls.push(body ?? {});
        sendJson(200, { success: true, data: state.migrateResult });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/knowledge/index/search') {
        state.searchCalls.push(body ?? {});
        if (state.searchError !== null) {
          sendJson(400, { success: false, error: state.searchError });
          return;
        }
        sendJson(200, { success: true, data: state.searchResult });
        return;
      }

      sendJson(404, { success: false, error: 'Unhandled route' });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    vi.restoreAllMocks();
    state.rebuildCalls = [];
    state.migrateCalls = [];
    state.searchCalls = [];
    state.searchError = null;
  });

  test('knowledge reindex reports rebuilt root counts and forwards --root', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'reindex',
      '--root=root:personal',
      `--api-base=${apiBase}`,
    ]);

    expect(state.rebuildCalls).toEqual([{ rootId: 'root:personal' }]);
    expect(consoleLog).toHaveBeenCalledWith(
      'Reindexed root root:personal: 3 record(s), 12 chunk(s).',
    );
    expect(consoleLog).toHaveBeenCalledWith(
      'Knowledge reindex complete: 1 root(s), 3 record(s), 12 chunk(s).',
    );
  });

  test('knowledge reindex omits rootId when --root is not supplied (all roots)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['knowledge', 'reindex', `--api-base=${apiBase}`]);

    expect(state.rebuildCalls).toEqual([{ rootId: undefined }]);
  });

  test('a second reindex reporting zero roots is a reported no-op, not an error', async () => {
    state.rebuildResult = { roots: [] };
    const { runCli } = await import('../cli.js');

    await runCli(['knowledge', 'reindex', `--api-base=${apiBase}`]);

    expect(consoleLog).toHaveBeenCalledWith(
      'Knowledge reindex: no roots to rebuild.',
    );
  });

  test('knowledge migrate reports migrated counts and forwards --project', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'migrate',
      '--project=demo',
      `--api-base=${apiBase}`,
    ]);

    expect(state.migrateCalls).toEqual([{ projectSlug: 'demo' }]);
    expect(consoleLog).toHaveBeenCalledWith(
      'Knowledge migrate complete: 2 document(s), 8 chunk(s) across 1 namespace(s) (pre-index-ns).',
    );
  });

  test('a second migrate reporting zero documents/chunks is a reported no-op, not an error', async () => {
    state.migrateResult = {
      documentsMigrated: 0,
      chunksIndexed: 0,
      namespacesProcessed: [],
    };
    const { runCli } = await import('../cli.js');

    await runCli(['knowledge', 'migrate', `--api-base=${apiBase}`]);

    expect(consoleLog).toHaveBeenCalledWith(
      'Knowledge migrate: no pre-index documents or vectors found (no-op).',
    );
  });

  test('knowledge search forwards the query, repeated --root scoping, and --top-k, and prints human-readable results', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'search',
      'release plan',
      '--root=root:personal',
      '--root=root:project-demo',
      '--top-k=5',
      `--api-base=${apiBase}`,
    ]);

    expect(state.searchCalls).toEqual([
      {
        query: 'release plan',
        rootIds: ['root:personal', 'root:project-demo'],
        topK: 5,
      },
    ]);
    // Human output, not JSON: rank + score + re-resolved record fields, then a
    // summary line naming the scope. The S1064 lesson: json-only assertions
    // leave the human path unreviewed surface.
    expect(consoleLog).toHaveBeenCalledWith(
      '1. [0.923] Standup notes (root:personal · meeting · rec-1)',
    );
    expect(consoleLog).toHaveBeenCalledWith('   Discussed the release plan.');
    expect(consoleLog).toHaveBeenCalledWith(
      "Knowledge search: 1 result(s) for 'release plan' (root:personal, root:project-demo).",
    );
  });

  test('knowledge search forwards a single --root (the boundary a >1 scoping bug silently drops)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'search',
      'release plan',
      '--root=root:personal',
      `--api-base=${apiBase}`,
    ]);

    expect(state.searchCalls).toEqual([
      { query: 'release plan', rootIds: ['root:personal'] },
    ]);
  });

  test('knowledge search omits rootIds/topK when unscoped (all roots) and reports that scope', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'search',
      'release plan',
      `--api-base=${apiBase}`,
    ]);

    expect(state.searchCalls).toEqual([{ query: 'release plan' }]);
    expect(consoleLog).toHaveBeenCalledWith(
      "Knowledge search: 1 result(s) for 'release plan' (all roots).",
    );
  });

  test('knowledge search --json prints the raw results array as JSON', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'search',
      'release plan',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify(state.searchResult, null, 2),
    );
  });

  test('knowledge search with zero results is a reported no-op, not an error', async () => {
    state.searchResult = [];
    const { runCli } = await import('../cli.js');

    await runCli([
      'knowledge',
      'search',
      'nothing here',
      `--api-base=${apiBase}`,
    ]);

    expect(consoleLog).toHaveBeenCalledWith(
      "Knowledge search: no results for 'nothing here' (all roots).",
    );
  });

  test('knowledge search without a query exits non-zero and never calls the server', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['knowledge', 'search', `--api-base=${apiBase}`]),
    ).rejects.toThrow('Missing required argument: search query');
    expect(state.searchCalls).toHaveLength(0);
  });

  test('space-separated --root fails loudly instead of silently searching all roots', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'knowledge',
        'search',
        'release plan',
        '--root',
        'root:personal',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      "--root requires '=<id>' (e.g. --root=root:personal); '--root <id>' is not supported.",
    );
    expect(state.searchCalls).toHaveLength(0);
  });

  test('space-separated --top-k fails loudly instead of silently using the server default', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'knowledge',
        'search',
        'release plan',
        '--top-k',
        '5',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      "--top-k requires '=<n>' (e.g. --top-k=5); '--top-k <n>' is not supported.",
    );
    expect(state.searchCalls).toHaveLength(0);
  });

  test('knowledge search surfaces the NO_EMBEDDER server error as a thrown error (exit 1 path)', async () => {
    state.searchError =
      'No embedding provider connection is configured — add one under Connections, then reindex.';
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['knowledge', 'search', 'release plan', `--api-base=${apiBase}`]),
    ).rejects.toThrow(
      'No embedding provider connection is configured — add one under Connections, then reindex.',
    );
    expect(state.searchCalls).toHaveLength(1);
  });

  test('knowledge search rejects a non-integer --top-k before calling the server', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'knowledge',
        'search',
        'release plan',
        '--top-k=zero',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow("--top-k must be a positive integer, got 'zero'.");
    expect(state.searchCalls).toHaveLength(0);
  });

  test('unknown knowledge subcommand exits non-zero (rejects, matching other surface families)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['knowledge', 'bogus', `--api-base=${apiBase}`]),
    ).rejects.toThrow(
      "Unknown knowledge action. Use 'reindex', 'migrate', 'status', 'search', 'namespaces', 'docs', or 'documents'.",
    );
    expect(state.rebuildCalls).toHaveLength(0);
    expect(state.migrateCalls).toHaveLength(0);
  });

  test('bare `station knowledge` (missing action) exits non-zero', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['knowledge', `--api-base=${apiBase}`]),
    ).rejects.toThrow('Missing required argument: knowledge action');
  });
});
