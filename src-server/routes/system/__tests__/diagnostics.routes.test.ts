import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  serverLogsRead: { add: vi.fn() },
}));

const { isLocalRuntimeCallerMock, originalEvaluate } = vi.hoisted(() => {
  const originalEvaluate = (request: { principal?: { locality?: string } }) =>
    request.principal?.locality === 'home-possession';
  return {
    originalEvaluate,
    isLocalRuntimeCallerMock: vi.fn(originalEvaluate),
  };
});

vi.mock(
  '../../../security/runtime-request-security.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../security/runtime-request-security.js')
      >();
    isLocalRuntimeCallerMock.mockImplementation(originalEvaluate);
    actual.localRuntimeCaller.evaluate = isLocalRuntimeCallerMock;
    return {
      ...actual,
      isLocalRuntimeCaller: isLocalRuntimeCallerMock,
    };
  },
);

const { createDiagnosticsRoutes } = await import('../diagnostics.js');
const { createServerLogReader } = await import(
  '../../../services/infra/server-log-reader.js'
);
const { serverLogsRead } = await import('../../../telemetry/metrics.js');
const {
  bindRuntimeLocalOperator,
  isLocalRuntimeCaller,
  localRuntimeCaller,
  setRuntimeAuthenticatedRequestPrincipal,
} = await import('../../../security/runtime-request-security.js');

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  setLevel: vi.fn(),
  getLevel: vi.fn(),
} as any;

function fakeDiagnosticsService(bundle: unknown = { schemaVersion: 1 }) {
  return { generateBundle: vi.fn().mockResolvedValue(bundle) } as any;
}

const tempDirs: string[] = [];

afterEach(() => {
  isLocalRuntimeCallerMock.mockReset();
  isLocalRuntimeCallerMock.mockImplementation(originalEvaluate);
  localRuntimeCaller.evaluate = isLocalRuntimeCallerMock;
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-diagnostics-logs-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeDay(
  directory: string,
  date: string,
  lines: readonly Record<string, unknown>[],
): void {
  const path = join(directory, `server-${date}.ndjson`);
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
}

function createApp(directory: string) {
  const inner = createDiagnosticsRoutes(
    fakeDiagnosticsService(),
    mockLogger,
    createServerLogReader({ directory }),
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    const pairingSource = c.req.header('x-station-test-pairing-source');
    const authority = c.req.header('x-station-test-authority');
    const locality = c.req.header('x-station-test-locality');
    if (locality === 'home-possession') {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'test-home-possession',
        authority:
          authority === 'operator-credential'
            ? 'operator-credential'
            : 'device-credential',
        source: pairingSource ? 'session' : 'bearer',
        ...(pairingSource === 'same-origin' ||
        pairingSource === 'pairing-code' ||
        pairingSource === 'tailnet'
          ? { pairingSource }
          : {}),
        locality: 'home-possession',
      });
    } else if (authority === 'operator-credential') {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'test-operator',
        authority: 'operator-credential',
        source: 'bearer',
      });
    } else if (
      pairingSource === 'same-origin' ||
      pairingSource === 'pairing-code' ||
      pairingSource === 'tailnet'
    ) {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'test-device',
        authority: 'device-credential',
        source: 'session',
        pairingSource,
      });
    }
    // Same write the auth boundary performs; diagnostics reads the bound
    // flag, not a second isLocalRuntimeCaller call.
    bindRuntimeLocalOperator(c.req.raw);
    return next();
  });
  app.route('/', inner);
  return app;
}

const LOOPBACK_ENV = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
};

function localUiHeaders(): Record<string, string> {
  return {
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    'x-station-test-locality': 'home-possession',
  };
}

function remoteUiHeaders(): Record<string, string> {
  return {
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
  };
}

function homePossessionHeaders(): Record<string, string> {
  return {
    ...remoteUiHeaders(),
    'x-station-test-pairing-source': 'same-origin',
    'x-station-test-locality': 'home-possession',
  };
}

function accessRequestThroughProxyHeaders(): Record<string, string> {
  return {
    ...remoteUiHeaders(),
    'x-station-test-pairing-source': 'same-origin',
  };
}

function proxiedBootstrapHeaders(): Record<string, string> {
  return {
    ...remoteUiHeaders(),
    'x-station-test-pairing-source': 'same-origin',
  };
}

function pairingSessionHeaders(): Record<string, string> {
  return {
    ...remoteUiHeaders(),
    'x-station-test-pairing-source': 'pairing-code',
  };
}

function pairingOverLoopbackHeaders(): Record<string, string> {
  return { 'x-station-test-pairing-source': 'pairing-code' };
}

function operatorLoopbackHeaders(): Record<string, string> {
  return { 'x-station-test-authority': 'operator-credential' };
}

const SEEDED_API_KEY = 'local-operator-canary-material';

function writeSecretDay(directory: string): void {
  writeDay(directory, '2026-08-01', [
    {
      level: 'info',
      timestamp: '2026-08-01T00:00:01.000Z',
      msg: 'config loaded',
      config: { apiKey: SEEDED_API_KEY },
    },
  ]);
}

describe('Diagnostics Routes — GET /bundle (unchanged)', () => {
  test('returns the generated bundle', async () => {
    const directory = createTempLogDir();
    const app = createApp(directory);

    const body = await json(await app.request('/bundle'));

    expect(body).toEqual({ schemaVersion: 1 });
  });
});

describe('Diagnostics Routes — GET /logs param validation', () => {
  test('rejects an invalid level with 400 naming accepted values', async () => {
    const directory = createTempLogDir();
    const app = createApp(directory);

    const res = await app.request('/logs?level=verbose');

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('verbose');
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(body.error).toContain(level);
    }
  });

  test('rejects an invalid since with 400', async () => {
    const directory = createTempLogDir();
    const app = createApp(directory);

    const res = await app.request('/logs?since=not-a-date');

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('since');
  });

  test('rejects an invalid until with 400', async () => {
    const directory = createTempLogDir();
    const app = createApp(directory);

    const res = await app.request('/logs?until=not-a-date');

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('until');
  });

  test('clamps an out-of-range limit rather than rejecting it', async () => {
    const directory = createTempLogDir();
    writeDay(
      directory,
      '2026-08-01',
      Array.from({ length: 5 }, (_, i) => ({
        level: 'info',
        timestamp: `2026-08-01T00:00:0${i}.000Z`,
        msg: `line ${i}`,
      })),
    );
    const app = createApp(directory);

    const res = await app.request('/logs?limit=0');

    expect(res.status).toBe(200);
    const body = await json(res);
    // Clamped up to 1, not rejected — at least the most recent line comes back.
    expect(body.entries.length).toBeGreaterThanOrEqual(1);

    const resOver = await app.request('/logs?limit=999999');
    expect(resOver.status).toBe(200);
    const bodyOver = await json(resOver);
    expect(bodyOver.entries.length).toBeLessThanOrEqual(5);
  });

  test('accepts a valid level/since/until/q/limit combination', async () => {
    const directory = createTempLogDir();
    writeDay(directory, '2026-08-01', [
      {
        level: 'warn',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'disk usage high',
      },
      {
        level: 'info',
        timestamp: '2026-08-01T00:00:02.000Z',
        msg: 'unrelated',
      },
    ]);
    const app = createApp(directory);

    const res = await app.request(
      '/logs?level=warn&since=2026-08-01T00:00:00.000Z&until=2026-08-01T23:59:59.000Z&q=disk&limit=10',
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].msg).toBe('disk usage high');
  });
});

describe('Diagnostics Routes — GET /logs response shape', () => {
  test('returns entries, truncated, scannedFiles, oldestScannedDay, skippedMalformedLines', async () => {
    const directory = createTempLogDir();
    writeDay(directory, '2026-08-01', [
      {
        level: 'info',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'hello',
      },
    ]);
    const app = createApp(directory);

    const body = await json(await app.request('/logs'));

    expect(body).toEqual({
      entries: [
        {
          level: 'info',
          timestamp: '2026-08-01T00:00:01.000Z',
          msg: 'hello',
        },
      ],
      truncated: false,
      scannedFiles: 1,
      unreadableFiles: 0,
      oldestScannedDay: '2026-08-01',
      skippedMalformedLines: 0,
      scanBudgetExhausted: false,
    });
  });

  test('increments the station.logs.read counter with surface=route', async () => {
    const directory = createTempLogDir();
    const app = createApp(directory);

    await app.request('/logs');

    expect(serverLogsRead.add).toHaveBeenCalledWith(1, { surface: 'route' });
  });
});

describe('Diagnostics Routes — GET /logs redaction (station#1922)', () => {
  test('redacts a seeded connection-string secret through the full HTTP response', async () => {
    const directory = createTempLogDir();
    writeDay(directory, '2026-08-01', [
      {
        level: 'error',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'db connect failed',
        err: {
          message:
            'connection failed: postgres://dbuser:sup3rSecret@db.internal:5432/station',
        },
      },
    ]);
    const app = createApp(directory);

    const res = await app.request('/logs');
    const text = await res.text();

    expect(text).not.toContain('sup3rSecret');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('db.internal');
    expect(text).toContain('[REDACTED_URL]');
  });

  test('redacts a seeded nested apiKey secret through the full HTTP response', async () => {
    const directory = createTempLogDir();
    writeDay(directory, '2026-08-01', [
      {
        level: 'info',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'config loaded',
        config: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz01' },
      },
    ]);
    const app = createApp(directory);

    const res = await app.request('/logs');
    const text = await res.text();

    expect(text).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz01');
    expect(text).toContain('[REDACTED]');
  });

  test('redacts a connection-string password containing an unescaped @ through the full HTTP response (station#1896 review round 2, HIGH #3)', async () => {
    const directory = createTempLogDir();
    writeDay(directory, '2026-08-01', [
      {
        level: 'error',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'db connect failed',
        err: {
          message:
            'connection failed: postgres://dbuser:p@ssw0rd@db.internal:5432/station',
        },
      },
    ]);
    const app = createApp(directory);

    const res = await app.request('/logs');
    const text = await res.text();

    expect(text).not.toContain('p@ssw0rd');
    expect(text).not.toContain('ssw0rd');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('db.internal:5432/station');
    expect(text).toContain('[REDACTED_URL]');
  });
});

describe('Diagnostics Routes — GET /logs q is not a pre-redaction oracle (station#1896 review round 2, HIGH #1)', () => {
  test('q=<the exact seeded secret> returns zero matches through the full HTTP response', async () => {
    const directory = createTempLogDir();
    const seededSecret = 'sk-live-abcdefghijklmnopqrstuvwxyz01';
    writeDay(directory, '2026-08-01', [
      {
        level: 'info',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'config loaded',
        config: { apiKey: seededSecret },
      },
    ]);
    const app = createApp(directory);

    const byMsg = await json(await app.request('/logs?q=config+loaded'));
    expect(byMsg.entries).toHaveLength(1);

    const bySecret = await json(
      await app.request(`/logs?q=${encodeURIComponent(seededSecret)}`),
    );
    expect(bySecret.entries).toHaveLength(0);
  });
});

describe('Diagnostics Routes — local caller reads unredacted; remote stays redacted', () => {
  test('station-control internal-token hop reads the seeded secret', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request('/logs', { headers: localUiHeaders() }, LOOPBACK_ENV)
    ).text();

    expect(text).toContain(SEEDED_API_KEY);
    expect(text).not.toContain('[REDACTED]');
  });

  test('(d) a local-grant-minted credential reads the seeded secret unredacted', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request(
        '/logs',
        { headers: homePossessionHeaders() },
        LOOPBACK_ENV,
      )
    ).text();

    expect(text).toContain(SEEDED_API_KEY);
    expect(text).not.toContain('[REDACTED]');
  });

  test('(b) an operator credential over loopback is redacted', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request(
        '/logs',
        { headers: operatorLoopbackHeaders() },
        LOOPBACK_ENV,
      )
    ).text();

    expect(
      text,
      'operator credential over loopback leaked an unredacted secret',
    ).not.toContain(SEEDED_API_KEY);
    expect(text).toContain('[REDACTED]');
  });

  test('(a) a same-origin credential minted via access-request through the proxy is redacted', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request(
        '/logs',
        { headers: accessRequestThroughProxyHeaders() },
        LOOPBACK_ENV,
      )
    ).text();

    expect(
      text,
      'same-origin credential minted via access-request leaked an unredacted secret',
    ).not.toContain(SEEDED_API_KEY);
    expect(text).toContain('[REDACTED]');
  });

  test('(c) a bootstrap token exchanged from a proxied request mints a non-local credential (redacted)', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request(
        '/logs',
        { headers: proxiedBootstrapHeaders() },
        LOOPBACK_ENV,
      )
    ).text();

    expect(
      text,
      'proxied UI-bootstrap credential leaked an unredacted secret',
    ).not.toContain(SEEDED_API_KEY);
    expect(text).toContain('[REDACTED]');
  });

  test('a pairing credential over loopback is redacted (ssh -L is loopback)', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request(
        '/logs',
        { headers: pairingOverLoopbackHeaders() },
        LOOPBACK_ENV,
      )
    ).text();

    expect(
      text,
      'remote/paired caller leaked an unredacted secret',
    ).not.toContain(SEEDED_API_KEY);
    expect(text).toContain('[REDACTED]');
  });

  test('a local operator sees request paths; a remote/paired caller sees [REDACTED_PATH]', async () => {
    const directory = createTempLogDir();
    writeDay(directory, '2026-08-01', [
      {
        level: 'info',
        timestamp: '2026-08-01T00:00:01.000Z',
        msg: 'GET /api/projects/acme 200 9ms origin=none',
      },
    ]);
    const app = createApp(directory);

    const localText = await (
      await app.request(
        '/logs',
        { headers: homePossessionHeaders() },
        LOOPBACK_ENV,
      )
    ).text();
    expect(localText).toContain('GET /api/projects/acme 200');
    expect(localText).not.toContain('[REDACTED_PATH]');

    const remoteText = await (
      await app.request(
        '/logs',
        { headers: pairingSessionHeaders() },
        LOOPBACK_ENV,
      )
    ).text();
    expect(remoteText).toContain('[REDACTED_PATH]');
    expect(remoteText).not.toContain('/api/projects/acme');
  });

  test('a remote/paired UI behind the loopback proxy does not see the seeded secret (leak)', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const text = await (
      await app.request(
        '/logs',
        { headers: pairingSessionHeaders() },
        LOOPBACK_ENV,
      )
    ).text();

    expect(
      text,
      'remote/paired caller leaked an unredacted secret',
    ).not.toContain(SEEDED_API_KEY);
    expect(text).toContain('[REDACTED]');
  });

  test('(e) replacing the predicate changes the bound flag, Developer HTTP, and read_logs together', async () => {
    const directory = createTempLogDir();
    writeSecretDay(directory);
    const app = createApp(directory);

    const { McpServer } = await import('@modelcontextprotocol/server');
    const { registerOperationsTools } = await import(
      '../../../tools/station-control-operations-tools.js'
    );
    const { StationControlToolRegistry } = await import(
      '../../../tools/station-control-mcp-server.js'
    );
    const server = new McpServer({
      name: 'd6-local-read',
      version: '0.0.0',
    });
    registerOperationsTools(new StationControlToolRegistry(server));
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: object) => Promise<{
              content: Array<{ text: string }>;
            }>;
          }
        >;
      }
    )._registeredTools;

    const previousApiBase = process.env.STATION_API_BASE;
    process.env.STATION_API_BASE = 'http://d6-local-read.test';
    vi.stubGlobal(
      'fetch',
      async (
        input: string | URL | { readonly url: string },
        init?: RequestInit,
      ) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        const routePath = url.pathname.startsWith('/api/diagnostics')
          ? `${url.pathname.slice('/api/diagnostics'.length) || '/'}${url.search}`
          : `${url.pathname}${url.search}`;
        const headers = init?.headers
          ? Object.fromEntries(new Headers(init.headers).entries())
          : undefined;
        const proxied = await app.request(
          routePath,
          {
            method: init?.method ?? 'GET',
            headers,
          },
          LOOPBACK_ENV,
        );
        return new Response(await proxied.text(), {
          status: proxied.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    try {
      isLocalRuntimeCallerMock.mockReturnValue(false);
      const developerForced = await (
        await app.request(
          '/logs',
          { headers: homePossessionHeaders() },
          LOOPBACK_ENV,
        )
      ).text();
      const toolForced = (await tools.read_logs.handler({})).content[0].text;
      expect(
        developerForced,
        'home-possession caller leaked after the shared predicate was replaced',
      ).not.toContain(SEEDED_API_KEY);
      expect(
        toolForced,
        'read_logs leaked an unredacted secret after the shared predicate was replaced',
      ).not.toContain(SEEDED_API_KEY);

      isLocalRuntimeCallerMock.mockReturnValue(true);
      const developerOpened = await (
        await app.request(
          '/logs',
          { headers: operatorLoopbackHeaders() },
          LOOPBACK_ENV,
        )
      ).text();
      const toolOpened = (await tools.read_logs.handler({})).content[0].text;
      expect(developerOpened).toContain(SEEDED_API_KEY);
      expect(toolOpened).toContain(SEEDED_API_KEY);
      expect(isLocalRuntimeCaller).toBe(isLocalRuntimeCallerMock);
      expect(localRuntimeCaller.evaluate).toBe(isLocalRuntimeCallerMock);
    } finally {
      vi.unstubAllGlobals();
      if (previousApiBase === undefined) delete process.env.STATION_API_BASE;
      else process.env.STATION_API_BASE = previousApiBase;
    }
  });
});
