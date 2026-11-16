import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureApiCredential,
  parseCoreArgs,
  parseWholeNumber,
  parseWholeNumberFlag,
  resolveApiBase,
} from '../commands/core-api.js';
import { DEFAULT_SERVER_PORT } from '../commands/helpers.js';
import {
  readProfileStore,
  upsertProfile,
  writeProfileStore,
} from '../commands/profile-store.js';

describe('resolveApiBase', () => {
  const originalProfile = process.env.STATION_TARGET;
  const originalPort = process.env.STATION_PORT;
  const originalHome = process.env.STATION_HOME;
  const originalRoot = process.env.STATION_ROOT;
  let stationHome: string;
  let stationRoot: string;

  beforeEach(() => {
    stationRoot = mkdtempSync(join(tmpdir(), 'station-core-api-root-'));
    stationHome = join(stationRoot, 'instances', 'stable');
    process.env.STATION_HOME = stationHome;
    process.env.STATION_ROOT = stationRoot;
    delete process.env.STATION_TARGET;
    delete process.env.STATION_PORT;
  });

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.STATION_TARGET;
    } else {
      process.env.STATION_TARGET = originalProfile;
    }
    if (originalPort === undefined) {
      delete process.env.STATION_PORT;
    } else {
      process.env.STATION_PORT = originalPort;
    }
    if (originalHome === undefined) {
      delete process.env.STATION_HOME;
    } else {
      process.env.STATION_HOME = originalHome;
    }
    if (originalRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = originalRoot;
    rmSync(stationRoot, { recursive: true, force: true });
  });

  it('passes through a bare origin unchanged', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('strips a trailing /api suffix from the --api-base flag', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350/api']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('strips a trailing /api/ suffix (with trailing slash) from the --api-base flag', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350/api/']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('strips a bare trailing slash with no /api suffix', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350/']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('resolves STATION_TARGET through the saved Station store', () => {
    upsertProfile({ name: 'remote', endpoint: 'http://host.example:3350' });
    process.env.STATION_TARGET = 'remote';
    const parsed = parseCoreArgs([]);
    expect(resolveApiBase(parsed)).toBe('http://host.example:3350');
  });

  it('refuses explicit CLI selection of an inert broker route instead of using its Station origin directly', () => {
    const store = readProfileStore();
    const now = Date.now();
    writeProfileStore({
      ...store,
      profiles: [
        ...store.profiles,
        {
          schemaVersion: 1,
          name: 'broker-route',
          endpoint: 'https://private-station.example',
          relayRoute: {
            brokerOrigin: 'https://broker.example',
            stationId: '11111111-1111-4111-8111-111111111111',
            enrollmentId: '22222222-2222-4222-8222-222222222222',
          },
          setupSource: 'manual',
          configurationState: 'unconfigured',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    expect(() =>
      resolveApiBase(parseCoreArgs(['--station=broker-route'])),
    ).toThrow(/saved broker route, not a direct CLI connection/);
    process.env.STATION_TARGET = 'broker-route';
    expect(() => resolveApiBase(parseCoreArgs([]))).toThrow(
      /saved broker route, not a direct CLI connection/,
    );
  });

  it('prefers the explicit --api-base flag over STATION_TARGET', () => {
    upsertProfile({ name: 'remote', endpoint: 'http://env-host:3350' });
    process.env.STATION_TARGET = 'remote';
    const parsed = parseCoreArgs(['--api-base=http://flag-host:3350/api']);
    expect(resolveApiBase(parsed)).toBe('http://flag-host:3350');
  });

  it('refuses to attach an explicit bearer to non-loopback HTTP', () => {
    const parsed = parseCoreArgs(['--credential=bearer']);
    expect(() =>
      configureApiCredential(parsed, 'http://host.example.test'),
    ).toThrow(/bearer credentials require HTTPS/);
  });

  it('permits bearer attachment to strict loopback HTTP', () => {
    const parsed = parseCoreArgs(['--credential=bearer']);
    expect(() =>
      configureApiCredential(parsed, 'http://127.0.0.1:3141'),
    ).not.toThrow();
  });

  it('falls back to 127.0.0.1 with STATION_PORT when nothing is set', () => {
    process.env.STATION_PORT = '4242';
    const parsed = parseCoreArgs([]);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:4242');
  });

  // The literal pins the CLI's DEFAULT_SERVER_PORT binding itself: the test
  // runtime resolves the stable-local channel port, and a regression to 3141
  // would point the CLI at the user's own Station.
  it('falls back to the current runtime port when nothing is set', () => {
    const parsed = parseCoreArgs([]);
    expect(DEFAULT_SERVER_PORT).toBe(18141);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:18141');
  });

  // #174 carry-along (#167 AC5): normalizeApiBase's `/api$/` strip is
  // segment-anchored (requires a leading slash before "api"), so a hostname
  // that merely *contains* "api" as a substring must survive untouched --
  // guards against a future regression to a naive `.replace(/api$/, '')`
  // (no leading-slash anchor) that would incorrectly strip "api" off the
  // end of a hostname like "api.example.com".
  it('leaves a hostname that merely contains "api" as a substring unchanged', () => {
    const parsed = parseCoreArgs(['--api-base=http://api.example.com']);
    expect(resolveApiBase(parsed)).toBe('http://api.example.com');
  });

  it('still strips a trailing /api suffix on a hostname that also contains "api"', () => {
    const parsed = parseCoreArgs(['--api-base=http://api.example.com/api']);
    expect(resolveApiBase(parsed)).toBe('http://api.example.com');
  });
});

describe('requestJson refusals (#1796)', () => {
  it('keeps the envelope code and details, so a refusal renders from its structure', async () => {
    const { requestJson } = await import('../commands/core-api.js');
    const details = {
      requested: 'never',
      requester: { kind: 'person' },
      station: {},
      grant: { by: 'operator', scope: 'approval:full-access', uiSteps: ['x'] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code: 'approval-full-access-not-granted',
              error: 'Full access was not applied.',
              details,
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    try {
      await expect(
        requestJson('http://127.0.0.1:1', '/api/agents/a', { method: 'PUT' }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'approval-full-access-not-granted',
        details,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('requestText failures', () => {
  it('keeps the HTTP status and the envelope code on the thrown error', async () => {
    const { requestText } = await import('../commands/core-api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code: 'conversation-not-found',
              error: 'Conversation not found',
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    try {
      await expect(
        requestText('http://127.0.0.1:1', '/agents/a/conversations/c/export'),
      ).rejects.toMatchObject({
        message: 'Conversation not found',
        status: 404,
        code: 'conversation-not-found',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the status when the error body is not JSON', async () => {
    const { requestText } = await import('../commands/core-api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      ),
    );
    try {
      const failure = await requestText('http://127.0.0.1:1', '/x').catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        message: 'Request failed with HTTP 502',
        status: 502,
      });
      expect(failure).not.toHaveProperty('code');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('parseWholeNumberFlag', () => {
  it('reads an absent flag as unset and a digit string as its number', () => {
    expect(parseWholeNumberFlag(parseCoreArgs([]), 'limit')).toBeUndefined();
    expect(parseWholeNumberFlag(parseCoreArgs(['--limit=0']), 'limit')).toBe(0);
    expect(
      parseWholeNumberFlag(parseCoreArgs(['--limit=25']), 'limit', {
        min: 1,
        max: 100,
      }),
    ).toBe(25);
  });

  it.each(['7abc', '30s', '1.5', '1e3', '-1', '+1', ' 1', ''])(
    'refuses %j instead of truncating or coercing it',
    (raw) => {
      expect(() =>
        parseWholeNumberFlag(parseCoreArgs([`--limit=${raw}`]), 'limit'),
      ).toThrow(`--limit must be a whole number. Got: ${raw}`);
    },
  );

  it('names the accepted range, and enforces both ends of it', () => {
    const read = (value: string, bounds: { min?: number; max?: number }) =>
      parseWholeNumberFlag(parseCoreArgs([`--n=${value}`]), 'n', bounds);

    expect(() => read('0', { min: 1 })).toThrow(
      '--n must be a positive integer. Got: 0',
    );
    expect(() => read('4', { min: 5 })).toThrow(
      '--n must be a whole number of at least 5. Got: 4',
    );
    expect(() => read('101', { min: 1, max: 100 })).toThrow(
      '--n must be a whole number from 1 to 100. Got: 101',
    );
    expect(read('100', { min: 1, max: 100 })).toBe(100);
  });

  it('refuses a bare flag, which is what the space-separated form parses to', () => {
    expect(() =>
      parseWholeNumberFlag(parseCoreArgs(['--limit', '5']), 'limit', {
        min: 1,
      }),
    ).toThrow('--limit must be a positive integer. Pass it as --limit=<n>.');
  });

  it('labels a positional by the name the caller gives it', () => {
    expect(parseWholeNumber('12', 'count')).toBe(12);
    expect(() => parseWholeNumber('abc', 'count')).toThrow(
      'count must be a whole number. Got: abc',
    );
  });
});
