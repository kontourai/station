import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  base: 'http://127.0.0.1:43521',
  authorize: vi.fn(),
  profile: { name: 'local', endpoint: 'http://127.0.0.1:43521' },
}));
vi.mock('../commands/core-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/core-api.js')>()),
  configureApiCredential: vi.fn(),
  resolveApiBase: () => mocks.base,
  getResolvedApiBase: () => ({ station: 'local' }),
  requestJson: mocks.request,
}));

vi.mock('../commands/local-self-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/local-self-auth.js')>()),
  selfAuthorizeLocalProfile: mocks.authorize,
}));
vi.mock('../commands/profile-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/profile-store.js')>()),
  findProfile: () => mocks.profile,
}));

import { runCoreCommand } from '../commands/core.js';

const lease = {
  leaseId: 'b'.repeat(32),
  sessionId: 'recorded-session',
  project: { id: 'project-id', slug: 'project' },
  allowedTools: ['read_conversation', 'board_pin'],
  expiresAt: '2026-10-21T12:30:00.000Z',
  lifetime: 'process-and-session-bound',
  config: {
    url: 'http://127.0.0.1:43521/mcp/station-control',
    headers: { Authorization: `Bearer ${'A'.repeat(43)}` },
  },
};
const endpoint = '/api/orchestration/station-control/external-clients';
const makeTempDir = trackTempDirs();
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.base = 'http://127.0.0.1:43521';
  mocks.profile = { name: 'local', endpoint: mocks.base };
  mocks.authorize.mockReset().mockResolvedValue({
    status: 'authorized',
    profile: mocks.profile,
    credential: 'synthetic-private-device-value',
  });
  mocks.request.mockReset().mockResolvedValue(structuredClone(lease));
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
function outputPath() {
  const root = makeTempDir('station-external-client-cli-');
  return join(root, 'client.json');
}
function args(path: string) {
  return [
    'create',
    '--session=recorded-session',
    '--tools=read_conversation,board_pin',
    '--ttl-seconds=300',
    `--output=${path}`,
  ];
}

describe('external-client CLI custody', () => {
  test('explicit authorization uses the existing profile flow and prints no credential', async () => {
    await runCoreCommand('mcp-clients', ['authorize']);
    expect(mocks.authorize).toHaveBeenCalledWith(mocks.profile);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      authorized: true,
      station: 'local',
    });
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(
      'synthetic-private-device-value',
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  test('does not authorize a saved profile for a different endpoint', async () => {
    mocks.profile.endpoint = 'http://127.0.0.1:43522';
    await expect(runCoreCommand('mcp-clients', ['authorize'])).rejects.toThrow(
      /saved installed local Station/,
    );
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === 'win32')(
    'writes a new private config and prints only non-secret metadata through the actual command',
    async () => {
      const path = outputPath();
      await runCoreCommand('mcp-clients', args(path));
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(lease);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const metadata = JSON.parse(String(stdout.mock.calls[0]?.[0]));
      expect(metadata).toMatchObject({
        leaseId: lease.leaseId,
        sessionId: lease.sessionId,
        configPath: path,
      });
      expect(metadata).not.toHaveProperty('config');
      expect(JSON.stringify(stdout.mock.calls)).not.toContain(
        lease.config.headers.Authorization,
      );
      const init = mocks.request.mock.calls[0]?.[2];
      expect(mocks.request.mock.calls[0]?.slice(0, 2)).toEqual([
        mocks.base,
        endpoint,
      ]);
      expect(JSON.parse(init.body)).toEqual({
        sessionId: lease.sessionId,
        allowedTools: lease.allowedTools,
        ttlSeconds: 300,
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'does not overwrite an existing configuration or request a lease',
    async () => {
      const path = outputPath();
      writeFileSync(path, 'intentional-existing-file');
      await expect(runCoreCommand('mcp-clients', args(path))).rejects.toThrow(
        /already exists/,
      );
      expect(readFileSync(path, 'utf8')).toBe('intentional-existing-file');
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  test.skipIf(process.platform === 'win32').each([
    { ...lease, sessionId: 'different-session' },
    { ...lease, allowedTools: ['browser_navigate'] },
    {
      ...lease,
      config: {
        ...lease.config,
        url: 'http://remote.example/mcp/station-control',
      },
    },
    {
      ...lease,
      config: { ...lease.config, url: `${lease.config.url}?token=unexpected` },
    },
  ])(
    'refuses a malformed or different-scope response without saving or guessing a revocation target',
    async (response) => {
      mocks.request.mockResolvedValue(response);
      const path = outputPath();
      await expect(runCoreCommand('mcp-clients', args(path))).rejects.toThrow(
        /invalid|different scope/,
      );
      expect(existsSync(path)).toBe(false);
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'does not replay an uncertain issuance',
    async () => {
      mocks.request.mockRejectedValue(
        Object.assign(new Error('transport unavailable'), { status: 503 }),
      );
      const path = outputPath();
      await expect(runCoreCommand('mcp-clients', args(path))).rejects.toThrow(
        /outcome is unknown.*Do not retry/,
      );
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(existsSync(path)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'revokes only the newly issued lease if its destination disappears before saving',
    async () => {
      const path = outputPath();
      mocks.request
        .mockImplementationOnce(async () => {
          rmSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
          return structuredClone(lease);
        })
        .mockResolvedValueOnce({ revoked: true, leaseId: lease.leaseId });
      await expect(runCoreCommand('mcp-clients', args(path))).rejects.toThrow(
        /issued lease was revoked/,
      );
      expect(mocks.request.mock.calls.map((call) => call[2]?.method)).toEqual([
        'POST',
        'DELETE',
      ]);
      expect(mocks.request.mock.calls[1]?.[1]).toBe(
        `${endpoint}/${lease.leaseId}`,
      );
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'retains uncertainty if compensating revocation cannot be confirmed',
    async () => {
      const path = outputPath();
      mocks.request
        .mockImplementationOnce(async () => {
          rmSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
          return structuredClone(lease);
        })
        .mockRejectedValueOnce(new Error('lost acknowledgement'));
      await expect(runCoreCommand('mcp-clients', args(path))).rejects.toThrow(
        /revocation is unconfirmed/,
      );
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  test('revokes by exact lease id without printing unexpected response secrets', async () => {
    mocks.request.mockResolvedValue({
      revoked: true,
      leaseId: lease.leaseId,
      config: lease.config,
    });
    await runCoreCommand('mcp-clients', ['revoke', lease.leaseId]);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      revoked: true,
      leaseId: lease.leaseId,
    });
  });

  test('does not claim or repeat a revocation whose response was lost', async () => {
    mocks.request.mockRejectedValue(new Error('lost acknowledgement'));
    await expect(
      runCoreCommand('mcp-clients', ['revoke', lease.leaseId]),
    ).rejects.toThrow(/revocation is unconfirmed/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  test('refuses remote targets before requesting anything', async () => {
    mocks.base = 'https://station.example';
    await expect(
      runCoreCommand('mcp-clients', ['revoke', lease.leaseId]),
    ).rejects.toThrow(/loopback/);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  test.runIf(process.platform === 'win32')(
    'does not claim POSIX privacy on Windows',
    async () => {
      await expect(
        runCoreCommand('mcp-clients', args(outputPath())),
      ).rejects.toThrow(/POSIX/);
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
});
