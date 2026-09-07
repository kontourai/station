import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { nativePublicHandshakeTransport } from '../publicHandshakeTransport';

describe('nativePublicHandshakeTransport', () => {
  beforeEach(() => mocks.invoke.mockReset());

  it('projects the host-owned handshake response without exposing credentials', async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      body: '{"compatibility":{"protocolVersion":1}}',
    });
    const response = await nativePublicHandshakeTransport(
      'https://station.example.test/.well-known/station/v1',
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      'station_native_public_handshake',
      { url: 'https://station.example.test/.well-known/station/v1' },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      compatibility: { protocolVersion: 1 },
    });
  });

  it('preserves the native transport code for actionable diagnosis', async () => {
    mocks.invoke.mockRejectedValueOnce({
      code: 'transport_dns',
      message: 'Station host could not be resolved.',
    });
    await expect(
      nativePublicHandshakeTransport(
        'https://station.example.test/.well-known/station/v1',
      ),
    ).rejects.toMatchObject({ code: 'transport_dns' });
  });
});
