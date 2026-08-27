import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readCredential,
  runRemoteAuthSmoke,
} from '../station-dogfood-remote-auth-smoke.mjs';

const SHA = 'a'.repeat(40);
const TEST_CREDENTIAL = ['test', 'credential', 'must-not-be-reported'].join(
  '-',
);

function response(status: number, body: unknown) {
  return { status, json: async () => body } as Response;
}

describe('remote authenticated dogfood smoke', () => {
  it('proves remote denial/auth, exact SHA, local compatibility, and WS auth', async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string>)
        ?.Authorization;
      requests.push({ url, authorization });
      if (url.endsWith('/.well-known/station/v1')) {
        return response(200, {
          schemaVersion: 1,
          environmentId: 'environment-1',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
        });
      }
      if (url.includes('remote.test') && !authorization) {
        return response(401, { error: 'authentication_required' });
      }
      if (url.endsWith('/api/system/identity'))
        return response(200, { sha: SHA });
      return response(200, { success: true });
    });
    const websocketProbe = vi.fn(async (_url: string, credential?: string) =>
      credential
        ? { outcome: 'authenticated' }
        : { outcome: 'denied', closeCode: 4401 },
    );

    const result = await runRemoteAuthSmoke(
      {
        remoteOrigin: 'https://remote.test',
        localOrigin: 'http://127.0.0.1:3141',
        expectedSha: SHA,
        websocketUrls: {
          terminal: 'wss://terminal.remote.test',
          voice: 'wss://voice.remote.test/?agent=station-voice',
        },
      },
      { credential: TEST_CREDENTIAL, fetchImpl, websocketProbe },
    );

    expect(result).toMatchObject({
      ok: true,
      expectedSha: SHA,
      checks: {
        remoteUnauthenticated: 401,
        remoteAuthenticatedIdentity: 200,
        localUnauthenticatedIdentity: 200,
      },
    });
    expect(requests[0].authorization).toBeUndefined();
    expect(requests[1].authorization).toBeUndefined();
    expect(requests.at(-1)?.authorization).toBeUndefined();
    expect(requests.filter((request) => request.authorization)).toHaveLength(3);
    expect(websocketProbe).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain(TEST_CREDENTIAL);
  });

  it('rejects non-minimal handshake and unexpected unauthenticated access', async () => {
    const base = {
      remoteOrigin: 'https://remote.test',
      localOrigin: 'http://127.0.0.1:3141',
      expectedSha: SHA,
    };
    await expect(
      runRemoteAuthSmoke(base, {
        credential: TEST_CREDENTIAL,
        fetchImpl: async () =>
          response(200, {
            schemaVersion: 1,
            environmentId: 'environment-1',
            credential: TEST_CREDENTIAL,
            authentication: { scheme: 'bearer' },
            transports: {},
          }),
      }),
    ).rejects.toThrow(/minimal versioned contract/);

    let count = 0;
    await expect(
      runRemoteAuthSmoke(base, {
        credential: TEST_CREDENTIAL,
        fetchImpl: async () => {
          count += 1;
          if (count === 1)
            return response(200, {
              schemaVersion: 1,
              environmentId: 'environment-1',
              authentication: { scheme: 'bearer', protocolVersion: 1 },
              transports: { http: 1, sse: 1, websocket: 1 },
            });
          return response(200, {});
        },
      }),
    ).rejects.toThrow(/expected 401/);
  });

  it('reads only owner-private credential files', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-smoke-credential-'));
    const file = join(root, 'credential');
    writeFileSync(file, `${TEST_CREDENTIAL}\n`, { mode: 0o600 });
    expect(readCredential(file)).toBe(TEST_CREDENTIAL);
    chmodSync(file, 0o644);
    expect(() => readCredential(file)).toThrow(/0600/);
  });
});
