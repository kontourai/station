/**
 * Security review H1: a remote read through this Station presents the
 * Station-wide outbound peer bearer, so the real auth boundary must admit
 * only the bound owner. Real paired devices, the real scope table and the
 * same owner/current predicates runtime-routes.ts composes for the mount;
 * only the remote Station behind the tunnel is a stub.
 */
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { describe, expect, test, vi } from 'vitest';
import { peerChatRuntime } from '../../__test-utils__/peer-chat-runtime.js';
import { createSshEnvironmentRoutes } from '../../routes/operations/ssh-environments.js';
import {
  isBoundRuntimeOwner,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';

const ENV_ID = '22222222-2222-4222-8222-222222222222';
const THREAD = 'external:claude:0123456789abcdef0123456789abcdef';
const HISTORY = `/api/environments/ssh/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`;

async function world() {
  const source = await peerChatRuntime();
  const fetchHistory = vi.fn(async () => ({
    protocolVersion: 1 as const,
    session: { threadId: THREAD } as never,
    events: [],
    hasMore: false,
    watermark: 0,
  }));
  source.app.route(
    '/api/environments/ssh',
    createSshEnvironmentRoutes(
      {
        list: () => [
          {
            profile: { id: ENV_ID, name: 'Home media', environmentId: 'peer' },
            state: { phase: 'connected', localUrl: 'http://127.0.0.1:1' },
          },
        ],
      } as never,
      undefined,
      { get: () => ({ credential: 'peer-bearer-for-test' }) } as never,
      undefined,
      fetchHistory,
      {
        hosted: false,
        current: (request) =>
          isRuntimeRequestPrincipalCurrent(request, source.security),
        owner: isBoundRuntimeOwner,
      },
    ),
  );
  return { source, fetchHistory };
}

describe('remote session reads at the real auth boundary', () => {
  test("the owner's own operate device reads a remote session's history", async () => {
    const { source, fetchHistory } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    const response = await source.call(HISTORY, owner.credential);
    expect(response.status).toBe(200);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  test('an operate device bound to another person is refused before the remote', async () => {
    const { source, fetchHistory } = await world();
    const guest = source.pair(
      pairingScopePresetString('standard'),
      'device',
      'guest@example.test',
    );
    const response = await source.call(HISTORY, guest.credential);
    expect(response.status).toBe(403);
    expect(
      (await source.call('/api/environments/ssh/sessions', guest.credential))
        .status,
    ).toBe(403);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test("the owner's device acting as an agent tool is refused", async () => {
    const { source, fetchHistory } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    const response = await source.call(HISTORY, owner.credential, {
      headers: { 'x-station-control-origin': 'agent-tool' },
    });
    expect(response.status).toBe(403);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test('a read-only device is refused by scope on the history path', async () => {
    const { source, fetchHistory } = await world();
    const readOnly = source.pair(pairingScopePresetString('read-only'));
    const response = await source.call(HISTORY, readOnly.credential);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test('a revoked owner device reads nothing', async () => {
    const { source, fetchHistory } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    source.security.devicePairing.revokeDevice(
      owner.device.id,
      'operator-credential',
    );
    const response = await source.call(HISTORY, owner.credential);
    expect(response.status).not.toBe(200);
    expect(fetchHistory).not.toHaveBeenCalled();
  });
});
