import { describe, expect, it, vi } from 'vitest';
import {
  BrowserWebSocketAuthGate,
  isRemoteEndpoint,
  websocketCloseError,
} from '../browserWebSocketAuth';

const credentials = (credential?: string) => ({
  getCredential: () => credential,
  getProtocolVersion: () => 1,
});

describe('BrowserWebSocketAuthGate', () => {
  it('preserves the direct-loopback business-first flow', () => {
    const send = vi.fn();
    const ready = vi.fn();
    const gate = new BrowserWebSocketAuthGate(
      false,
      credentials(),
      ready,
      vi.fn(),
    );
    gate.open({ send });
    expect(send).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce();
    expect(gate.canSendBusinessData()).toBe(true);
  });

  it('sends only auth until the matching acknowledgement arrives', () => {
    const send = vi.fn();
    const ready = vi.fn();
    const gate = new BrowserWebSocketAuthGate(
      true,
      credentials('super-secret'),
      ready,
      vi.fn(),
    );
    gate.open({ send });
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'auth',
      protocolVersion: 1,
      credential: 'super-secret',
    });
    expect(gate.canSendBusinessData()).toBe(false);
    expect(gate.consume('{"type":"authenticated","protocolVersion":1}')).toBe(
      true,
    );
    expect(ready).toHaveBeenCalledOnce();
    expect(gate.canSendBusinessData()).toBe(true);
  });

  it('fails closed when the credential is missing or the ack is invalid', () => {
    const missing = vi.fn();
    new BrowserWebSocketAuthGate(true, credentials(), vi.fn(), missing).open({
      send: vi.fn(),
    });
    expect(missing).toHaveBeenCalledWith('Station credential required');

    const rejected = vi.fn();
    const gate = new BrowserWebSocketAuthGate(
      true,
      credentials('secret'),
      vi.fn(),
      rejected,
    );
    gate.open({ send: vi.fn() });
    gate.consume('{"type":"session_ready"}');
    expect(rejected).toHaveBeenCalledWith('Station credential was rejected');
    expect(gate.canSendBusinessData()).toBe(false);
  });
});

describe('browser WebSocket endpoint classification', () => {
  it.each([
    'http://localhost:3141',
    'http://127.0.0.1:3141',
    'http://[::1]:3141',
  ])('keeps %s zero-friction', (url) =>
    expect(isRemoteEndpoint(url, 'http://localhost')).toBe(false),
  );

  it('requires auth for a tailnet endpoint and maps non-secret close errors', () => {
    expect(
      isRemoteEndpoint('https://kontour.example.ts.net', 'http://localhost'),
    ).toBe(true);
    expect(websocketCloseError(4401)).toMatch(/credential/i);
    expect(websocketCloseError(4429)).toMatch(/attempts/i);
  });
});
