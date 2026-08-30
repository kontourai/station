import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import type { ParsedCoreArgs } from '../commands/core-api.js';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Node reports every transport failure as `TypeError: fetch failed` + cause — mirrors `request-failure-messages.test.ts`'s helper. */
function transportError(code: string): TypeError {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = Object.assign(
    new Error(`${code} 127.0.0.1:3141`),
    { code },
  );
  return error;
}

const NONE: ParsedCoreArgs = { flags: {}, positionals: [], repeatedFlags: {} };
const OFFLINE: ParsedCoreArgs = {
  flags: { offline: true },
  positionals: [],
  repeatedFlags: {},
};

let tempHome: string;
let previousStationHome: string | undefined;
let previousApiBase: string | undefined;
let previousPort: string | undefined;
const fetchMock = vi.fn<typeof fetch>();
let consoleLog: MockInstance;
let consoleError: MockInstance;

function markCurrentHome(): void {
  writeFileSync(
    join(tempHome, '.station-home-schema.json'),
    JSON.stringify({ version: 1 }),
  );
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'station-config-'));
  previousStationHome = process.env.STATION_HOME;
  previousApiBase = process.env.STATION_API_BASE;
  previousPort = process.env.STATION_PORT;
  process.env.STATION_HOME = tempHome;
  delete process.env.STATION_API_BASE;
  delete process.env.STATION_PORT;

  vi.resetModules();
  vi.doMock('../commands/helpers.js', () => ({
    DEFAULT_SERVER_PORT: 3141,
    PROJECT_HOME: tempHome,
  }));

  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (previousStationHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousStationHome;
  if (previousApiBase === undefined) delete process.env.STATION_API_BASE;
  else process.env.STATION_API_BASE = previousApiBase;
  if (previousPort === undefined) delete process.env.STATION_PORT;
  else process.env.STATION_PORT = previousPort;
  rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('configSet', () => {
  test('writes through the live route when Station is reachable (#175)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, value: 'info', revision: 'revision-1' }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, value: 'debug', revision: 'revision-2' }),
    );
    const { configSet } = await import('../commands/config.js');
    await configSet('logLevel', 'debug', NONE);

    const [requestUrl, request] = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    )!;
    const requestInit = request!;
    expect(requestUrl).toBe('http://127.0.0.1:3141/config/app/log-level');
    expect(requestInit).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ value: 'debug' }),
    });
    const headers = new Headers(requestInit.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('if-match')).toBe('revision-1');
    expect(headers.get('idempotency-key')).toEqual(expect.any(String));
    expect(consoleLog).toHaveBeenCalledWith('  ✓ logLevel = debug');
  });

  test('a server-reported typed violation exits non-zero carrying the server message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, value: 'info', revision: 'revision-1' }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'logLevel: expected one of trace|debug|info|warn|error',
          violations: [
            {
              key: 'logLevel',
              message: 'logLevel: expected one of trace|debug|info|warn|error',
            },
          ],
        },
        400,
      ),
    );
    const { configSet } = await import('../commands/config.js');
    await expect(configSet('logLevel', 'bogus', NONE)).rejects.toThrow(
      'logLevel: expected one of trace|debug|info|warn|error',
    );
  });

  test('prints the server ignoredKeys warning', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {},
        ignoredKeys: [{ key: 'apiEndpoint', reason: 'unknown' }],
      }),
    );
    const { configSet } = await import('../commands/config.js');
    await configSet('apiEndpoint', 'http://example.com', NONE);

    expect(consoleError).toHaveBeenCalledWith(
      '  ! ignored: apiEndpoint (unknown)',
    );
  });

  test('--offline writes config/app.json directly after local registry sanitize/validation', async () => {
    const { configSet } = await import('../commands/config.js');
    await configSet('logLevel', 'debug', OFFLINE);

    expect(fetchMock).not.toHaveBeenCalled();
    const written = JSON.parse(
      readFileSync(join(tempHome, 'config', 'app.json'), 'utf-8'),
    );
    expect(written.logLevel).toBe('debug');
  });

  test('--offline rejects a typed violation locally, without writing the file', async () => {
    const { configSet } = await import('../commands/config.js');
    await expect(configSet('logLevel', 'bogus', OFFLINE)).rejects.toThrow(
      'logLevel: expected one of trace|debug|info|warn|error',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(tempHome, 'config', 'app.json'))).toBe(false);
  });

  test('--offline drops a runtime-derived key with the same ignored-keys warning as the live route', async () => {
    const { configSet } = await import('../commands/config.js');
    await configSet('mcpUiFrameOrigin', 'http://127.0.0.1:4555', OFFLINE);

    expect(consoleError).toHaveBeenCalledWith(
      '  ! ignored: mcpUiFrameOrigin (runtime-derived)',
    );
    const written = JSON.parse(
      readFileSync(join(tempHome, 'config', 'app.json'), 'utf-8'),
    );
    expect(written.mcpUiFrameOrigin).toBeUndefined();
  });

  test('unreachable without --offline names both ways forward', async () => {
    fetchMock.mockRejectedValueOnce(transportError('ECONNREFUSED'));
    const { configSet } = await import('../commands/config.js');

    let caught: Error | undefined;
    try {
      await configSet('logLevel', 'debug', NONE);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/--offline/);
    expect(caught?.message).toMatch(/Retry once Station is reachable/);
    expect(existsSync(join(tempHome, 'config', 'app.json'))).toBe(false);
  });

  // station#3402 review (MEDIUM 2): the unreachable hint above must not be
  // appended to a timed-out PUT. Every clause in it is wrong for that state —
  // it re-asserts an unreachability nothing observed, invites the blind retry
  // of a write whose outcome is unknown, and offers `--offline`, which writes
  // config/app.json behind a running Station and produces the exact
  // disk/server divergence #175's live route exists to prevent.
  test('a timed-out PUT is not told to retry or to go offline', async () => {
    const { setClientRequestTimeout } = await import(
      '@kontourai/station-sdk/client'
    );
    setClientRequestTimeout(20);
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const { configSet } = await import('../commands/config.js');

    let caught: Error | undefined;
    try {
      await configSet('mcpUiFrameOrigin', 'https://example.test', NONE);
    } catch (error) {
      caught = error as Error;
    } finally {
      setClientRequestTimeout(undefined);
    }

    expect(caught?.message).toContain('may still have been applied');
    expect(caught?.message).toContain('station config get <key>');
    expect(caught?.message).toContain('Do not pass --offline here');
    expect(caught?.message).not.toMatch(/Retry once Station is reachable/);
    expect(caught?.message).not.toMatch(/pass --offline to write/);
    expect(existsSync(join(tempHome, 'config', 'app.json'))).toBe(false);
  });

  // Review round 1 LOW 2: a reachable Station running a build that
  // predates PUT /config/app 404s on the exact route rather than refusing
  // the connection — that is not a transport failure, so it deserves its
  // own hint rather than a bare "Request failed with HTTP 404".
  test('a 404 on the route (an old Station binary) also suggests --offline', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const { configSet } = await import('../commands/config.js');

    let caught: Error | undefined;
    try {
      await configSet('logLevel', 'debug', NONE);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/HTTP 404/);
    expect(caught?.message).toMatch(/predates PUT \/config\/app/);
    expect(caught?.message).toMatch(/--offline/);
  });

  // Review round 1 HIGH 1: a registry-nullable key (`NULLABLE_APP_CONFIG_KEYS`
  // — `builtinAgentEngineConnectionId` today) stores an explicit `null` as
  // the value ITSELF (absent = re-derive each boot; null = sticky, explicit
  // Station) — offline merge must not silently invert that into a delete.
  describe('offline null semantics (review round 1 HIGH 1)', () => {
    test('setting a nullable key to null persists a literal null, not a deletion', async () => {
      markCurrentHome();
      mkdirSync(join(tempHome, 'config'), { recursive: true });
      writeFileSync(
        join(tempHome, 'config', 'app.json'),
        JSON.stringify({ builtinAgentEngineConnectionId: 'codex-runtime' }),
      );
      const { configSet } = await import('../commands/config.js');
      await configSet('builtinAgentEngineConnectionId', 'null', OFFLINE);

      const written = JSON.parse(
        readFileSync(join(tempHome, 'config', 'app.json'), 'utf-8'),
      );
      expect(Object.hasOwn(written, 'builtinAgentEngineConnectionId')).toBe(
        true,
      );
      expect(written.builtinAgentEngineConnectionId).toBeNull();
    });

    test('setting a nullable key to a connection id stores the string', async () => {
      const { configSet } = await import('../commands/config.js');
      await configSet(
        'builtinAgentEngineConnectionId',
        'codex-runtime',
        OFFLINE,
      );

      const written = JSON.parse(
        readFileSync(join(tempHome, 'config', 'app.json'), 'utf-8'),
      );
      expect(written.builtinAgentEngineConnectionId).toBe('codex-runtime');
    });

    test('setting a NON-nullable key to null still deletes it (round-trip contrast)', async () => {
      markCurrentHome();
      mkdirSync(join(tempHome, 'config'), { recursive: true });
      writeFileSync(
        join(tempHome, 'config', 'app.json'),
        JSON.stringify({ region: 'us-east-1' }),
      );
      const { configSet } = await import('../commands/config.js');
      await configSet('region', 'null', OFFLINE);

      const written = JSON.parse(
        readFileSync(join(tempHome, 'config', 'app.json'), 'utf-8'),
      );
      expect(Object.hasOwn(written, 'region')).toBe(false);
    });
  });

  // Review round 1 MEDIUM 2(a): the offline write is temp-file + rename,
  // not a direct in-place write — no leftover `.tmp` file after a normal
  // write, and the final file is valid JSON (not partially written).
  test('--offline writes atomically: no leftover temp file, valid JSON on disk', async () => {
    const { configSet } = await import('../commands/config.js');
    await configSet('logLevel', 'debug', OFFLINE);

    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(join(tempHome, 'config'));
    expect(entries).toEqual(['app.json']);
    expect(() =>
      JSON.parse(readFileSync(join(tempHome, 'config', 'app.json'), 'utf-8')),
    ).not.toThrow();
  });

  // Review round 1 MEDIUM 2(b): a composite-kind field (structurally
  // unvalidated offline — no AJV pass runs outside a live Station) gets an
  // explicit disclosure in the confirmation line, not a silent same-parity
  // claim.
  test('--offline names the composite-field structural-validation gap in its confirmation line', async () => {
    const { configSet } = await import('../commands/config.js');
    await configSet(
      'approvalGuardian',
      '{"enabled":true,"mode":"review"}',
      OFFLINE,
    );

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('structural validation'),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('next Station boot'),
    );
  });
});

describe('configGet', () => {
  // station#1557: the note names the environment as the SOURCE of a value,
  // and only when nothing is stored. It used to print "AWS_REGION is set and
  // overrides this value" against a stored region that was in fact winning.
  test('reads through the live route and names the env as the source when nothing is stored', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { region: 'us-west-2' },
        provenance: { region: { source: 'env', envVar: 'AWS_REGION' } },
      }),
    );
    const { configGet } = await import('../commands/config.js');
    await configGet('region', NONE);

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3141/config/app');
    expect(consoleLog).toHaveBeenCalledWith('us-west-2');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('AWS_REGION'),
    );
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('overrides'),
    );
  });

  test('prints no provenance note for a stored value, whatever the environment holds', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { region: 'eu-west-1' },
        provenance: { region: { source: 'file' } },
      }),
    );
    const { configGet } = await import('../commands/config.js');
    await configGet('region', NONE);

    expect(consoleLog).toHaveBeenCalledWith('eu-west-1');
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('prints every value as JSON for a bare get, with no provenance note', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { logLevel: 'info' },
        provenance: { logLevel: { source: 'file' } },
      }),
    );
    const { configGet } = await import('../commands/config.js');
    await configGet(undefined, NONE);

    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({ logLevel: 'info' }, null, 2),
    );
  });

  test('falls back to the local file, without erroring, when Station is unreachable', async () => {
    markCurrentHome();
    mkdirSync(join(tempHome, 'config'), { recursive: true });
    writeFileSync(
      join(tempHome, 'config', 'app.json'),
      JSON.stringify({ logLevel: 'warn' }),
    );
    fetchMock.mockRejectedValueOnce(transportError('ECONNREFUSED'));
    const { configGet } = await import('../commands/config.js');
    await configGet('logLevel', NONE);

    expect(consoleLog).toHaveBeenCalledWith('warn');
  });

  test('--offline reads the local file without a network call', async () => {
    markCurrentHome();
    mkdirSync(join(tempHome, 'config'), { recursive: true });
    writeFileSync(
      join(tempHome, 'config', 'app.json'),
      JSON.stringify({ logLevel: 'warn' }),
    );
    const { configGet } = await import('../commands/config.js');
    await configGet('logLevel', OFFLINE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith('warn');
  });

  test('a genuine application error (not a transport failure) still throws', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'config file is corrupt' }, 500),
    );
    const { configGet } = await import('../commands/config.js');
    await expect(configGet('logLevel', NONE)).rejects.toThrow(
      'config file is corrupt',
    );
  });

  test('--offline refuses to downgrade a newer home before reading app config', async () => {
    mkdirSync(join(tempHome, 'config'), { recursive: true });
    writeFileSync(
      join(tempHome, '.station-home-schema.json'),
      JSON.stringify({ version: 999 }),
    );
    writeFileSync(
      join(tempHome, 'config', 'app.json'),
      JSON.stringify({ logLevel: 'warn' }),
    );

    const { configGet } = await import('../commands/config.js');
    await expect(configGet('logLevel', OFFLINE)).rejects.toMatchObject({
      code: 'STATION_HOME_SCHEMA_DOWNGRADE_REFUSED',
    });
    expect(consoleLog).not.toHaveBeenCalledWith('warn');
  });
});

describe('offline schema authority', () => {
  test('refuses to downgrade a newer home before mutating app config', async () => {
    mkdirSync(join(tempHome, 'config'), { recursive: true });
    writeFileSync(
      join(tempHome, '.station-home-schema.json'),
      JSON.stringify({ version: 999 }),
    );
    const appPath = join(tempHome, 'config', 'app.json');
    const original = JSON.stringify({ logLevel: 'warn' });
    writeFileSync(appPath, original);

    const { configSet } = await import('../commands/config.js');
    await expect(configSet('logLevel', 'debug', OFFLINE)).rejects.toMatchObject(
      { code: 'STATION_HOME_SCHEMA_DOWNGRADE_REFUSED' },
    );
    expect(readFileSync(appPath, 'utf-8')).toBe(original);
  });

  test('rejects an unversioned non-empty home before mutating app config', async () => {
    mkdirSync(join(tempHome, 'config'), { recursive: true });
    const appPath = join(tempHome, 'config', 'app.json');
    const original = JSON.stringify({ logLevel: 'warn' });
    writeFileSync(appPath, original);

    const { configSet } = await import('../commands/config.js');
    await expect(configSet('logLevel', 'debug', OFFLINE)).rejects.toMatchObject(
      { code: 'STATION_HOME_RESET_REQUIRED' },
    );
    expect(readFileSync(appPath, 'utf-8')).toBe(original);
    expect(existsSync(join(tempHome, '.station-home-schema.json'))).toBe(false);
  });
});
