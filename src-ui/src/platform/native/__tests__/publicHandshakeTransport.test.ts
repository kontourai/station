import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { nativePublicHandshakeTransport } from '../publicHandshakeTransport';

describe('nativePublicHandshakeTransport', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    mocks.invoke.mockRejectedValue({
      code: 'transport_dns',
      message: 'Station host could not be resolved.',
    });
    await expect(
      nativePublicHandshakeTransport(
        'https://station.example.test/.well-known/station/v1',
      ),
    ).rejects.toMatchObject({ code: 'transport_dns' });
  });

  it('recovers a handshake after a resolver miss without replaying HTTP failures', async () => {
    vi.useFakeTimers();
    mocks.invoke
      .mockRejectedValueOnce({
        code: 'transport_dns',
        message: 'DNS unavailable',
      })
      .mockResolvedValueOnce({ status: 200, body: '{}' });
    const recovered = nativePublicHandshakeTransport(
      'https://station.example.test/.well-known/station/v1',
    );
    await vi.advanceTimersByTimeAsync(250);
    expect((await recovered).status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    mocks.invoke.mockReset().mockResolvedValue({ status: 503, body: '{}' });
    expect(
      (
        await nativePublicHandshakeTransport(
          'https://station.example.test/.well-known/station/v1',
        )
      ).status,
    ).toBe(503);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
