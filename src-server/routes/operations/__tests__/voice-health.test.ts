import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RuntimeAuthFailureLimiter } from '../../../security/runtime-request-security.js';
import { attachVoiceWebSocket } from '../voice.js';

async function closesWithin(ws: WebSocket, timeoutMs = 200): Promise<boolean> {
  return Promise.race([
    once(ws, 'close').then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

describe('voice websocket health', () => {
  it('closes repeated public health upgrades without creating sessions', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const wss = attachVoiceWebSocket(0, voiceService as any, '127.0.0.1');
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    for (let index = 0; index < 3; index += 1) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${address.port}/__station/health`,
      );
      await once(ws, 'close');
    }
    expect(voiceService.createSession).not.toHaveBeenCalled();
    expect(voiceService.getActiveCount()).toBe(0);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('does not disclose operational identity in public or pre-auth upgrade headers', async () => {
    const sensitiveHeaders = [
      'x-station-instance',
      'x-station-build-sha',
      'x-station-boot-id',
    ];
    const scenarios = [
      { path: '/__station/health', auth: undefined },
      {
        path: '/',
        auth: {
          classifyPeer: vi.fn(() => 'remote'),
          verifyCredential: vi.fn(() => false),
          authTimeoutMs: 20,
          maxAuthFailures: 1,
        },
      },
    ];

    for (const scenario of scenarios) {
      const voiceService = {
        createSession: vi.fn(),
        getActiveCount: vi.fn(() => 0),
      };
      const wss = attachVoiceWebSocket(
        0,
        voiceService as any,
        '127.0.0.1',
        scenario.auth as any,
      );
      if (!wss) throw new Error('voice websocket was not created');
      await once(wss, 'listening');
      const address = wss.address();
      if (!address || typeof address === 'string')
        throw new Error('missing address');
      const ws = new WebSocket(
        `ws://127.0.0.1:${address.port}${scenario.path}`,
      );
      const upgrade = once(ws, 'upgrade');
      const [response] = await upgrade;
      for (const header of sensitiveHeaders) {
        expect(response.headers[header]).toBeUndefined();
      }
      await once(ws, 'close');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      expect(voiceService.createSession).not.toHaveBeenCalled();
    }
  });

  it('fails closed when the central declaration does not classify health as public', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const wss = attachVoiceWebSocket(0, voiceService as any, '127.0.0.1', {
      verifyCredential: vi.fn(),
      resolveCapability: () => undefined,
    });
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/__station/health`);
    const [code] = await once(ws, 'close');

    expect(code).toBe(4404);
    expect(voiceService.createSession).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe('voice websocket remote authentication', () => {
  it('persists bounded failure state across reconnects and recovers after expiry', async () => {
    let now = 1_000;
    const limiter = new RuntimeAuthFailureLimiter({
      now: () => now,
      maxFailures: 2,
      windowMs: 1_000,
      maxTrackedPeers: 4,
    });
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn((value: string) => value === 'valid-credential'),
      authTimeoutMs: 100,
      maxAuthFailures: 1,
      limiter,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const url = `ws://127.0.0.1:${address.port}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const invalid = new WebSocket(url);
      await once(invalid, 'open');
      invalid.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: `invalid-${attempt}`,
        }),
      );
      const [code] = await once(invalid, 'close');
      expect(code).toBe(4401);
    }

    const limited = new WebSocket(url);
    await once(limited, 'open');
    limited.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    const [limitedCode, limitedReason] = await once(limited, 'close');
    expect(limitedCode).toBe(4429);
    expect(limitedReason.toString()).toBe('authentication_rate_limited');
    expect(voiceService.createSession).not.toHaveBeenCalled();

    now += 1_001;
    const recovered = new WebSocket(url);
    await once(recovered, 'open');
    const acknowledgement = once(recovered, 'message');
    recovered.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    await acknowledgement;
    await vi.waitFor(() =>
      expect(voiceService.createSession).toHaveBeenCalledTimes(1),
    );

    recovered.close();
    await once(recovered, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('uses a bounded failure map for listener-scoped peer state', () => {
    const limiter = new RuntimeAuthFailureLimiter({
      now: () => 1_000,
      maxFailures: 1,
      windowMs: 1_000,
      maxTrackedPeers: 1,
    });
    limiter.recordFailure('first-peer');
    limiter.recordFailure('second-peer');

    expect(limiter.retryAfterSeconds('first-peer')).toBeUndefined();
    expect(limiter.retryAfterSeconds('second-peer')).toBe(1);
  });

  it('cannot allocate a voice session when credential verification resolves after close', async () => {
    let resolveVerification: ((valid: boolean) => void) | undefined;
    let verificationCalls = 0;
    const verifyCredential = vi.fn(() => {
      verificationCalls += 1;
      if (verificationCalls === 1) {
        return new Promise<boolean>((resolve) => {
          resolveVerification = resolve;
        });
      }
      return true;
    });
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential,
      authTimeoutMs: 500,
      maxUnauthenticatedConnectionsPerPeer: 1,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const url = `ws://127.0.0.1:${address.port}`;
    const serverConnection = once(wss, 'connection');
    const closing = new WebSocket(url);
    await once(closing, 'open');
    const [serverSocket] = await serverConnection;
    closing.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    await vi.waitFor(() => expect(verifyCredential).toHaveBeenCalledTimes(1));
    const serverClosed = once(serverSocket, 'close');
    closing.close();
    await Promise.all([once(closing, 'close'), serverClosed]);
    resolveVerification?.(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(voiceService.createSession).not.toHaveBeenCalled();

    // Close cleanup also releases admission before the delayed verifier
    // settles, so a replacement socket can begin authentication immediately.
    const replacement = new WebSocket(url);
    await once(replacement, 'open');
    const acknowledgement = once(replacement, 'message');
    replacement.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    await acknowledgement;
    await vi.waitFor(() =>
      expect(voiceService.createSession).toHaveBeenCalledTimes(1),
    );
    replacement.close();
    await once(replacement, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('preserves direct-loopback voice session creation', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'loopback'),
      verifyCredential: vi.fn(() => false),
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/?agent=station-voice`,
    );
    await once(ws, 'open');
    await vi.waitFor(() =>
      expect(voiceService.createSession).toHaveBeenCalledWith(
        expect.anything(),
        { agentSlug: 'station-voice' },
      ),
    );

    ws.close();
    await once(ws, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(auth.verifyCredential).not.toHaveBeenCalled();
  });

  it('closes before creating a voice session when remote auth is absent', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn(() => false),
      authTimeoutMs: 50,
      maxAuthFailures: 2,
    };
    const wss = (attachVoiceWebSocket as any)(
      0,
      voiceService,
      '127.0.0.1',
      auth,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(ws, 'open');
    const closed = await closesWithin(ws);

    if (!closed) ws.close();
    if (!closed) await once(ws, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(closed).toBe(true);
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('rejects a credential in the URL before creating a voice session', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn(() => true),
      authTimeoutMs: 50,
      maxAuthFailures: 2,
    };
    const wss = (attachVoiceWebSocket as any)(
      0,
      voiceService,
      '127.0.0.1',
      auth,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/?credential=url-secret`,
    );
    await once(ws, 'open');
    const closed = await closesWithin(ws);

    if (!closed) ws.close();
    if (!closed) await once(ws, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(closed).toBe(true);
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('creates a voice session only after a valid first auth frame', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn((value: string) => value === 'valid-credential'),
      authTimeoutMs: 50,
      maxAuthFailures: 2,
    };
    const wss = (attachVoiceWebSocket as any)(
      0,
      voiceService,
      '127.0.0.1',
      auth,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(ws, 'open');
    const allocatedBeforeAuth = voiceService.createSession.mock.calls.length;
    const acknowledgement = once(ws, 'message');
    ws.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    const [rawAcknowledgement] = await acknowledgement;
    await vi.waitFor(() =>
      expect(voiceService.createSession).toHaveBeenCalledTimes(1),
    );

    ws.close();
    await once(ws, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(allocatedBeforeAuth).toBe(0);
    expect(JSON.parse(rawAcknowledgement.toString())).toEqual({
      type: 'authenticated',
      protocolVersion: 1,
    });
  });

  it('bounds malformed pre-auth frames before allocating a voice session', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn(() => false),
      authTimeoutMs: 100,
      maxAuthFailures: 1,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'select-agent', agent: 'station-voice' }));
    const [code, reason] = await once(ws, 'close');

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(code).toBe(4401);
    expect(reason.toString()).toBe('authentication_failed');
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('rejects oversized auth frames before credential verification', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn(() => true),
      authTimeoutMs: 100,
      maxAuthFrameBytes: 8,
      maxAuthFailures: 2,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(ws, 'open');
    ws.send(
      JSON.stringify({ type: 'auth', protocolVersion: 1, credential: 'x' }),
    );
    const [code, reason] = await once(ws, 'close');

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(code).toBe(4409);
    expect(reason.toString()).toBe('authentication_frame_too_large');
    expect(auth.verifyCredential).not.toHaveBeenCalled();
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('caps transport payload buffering before authentication', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn(() => true),
      authTimeoutMs: 100,
      maxAuthFrameBytes: 64,
      maxPayloadBytes: 128,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(ws, 'open');
    ws.send('x'.repeat(256));
    const [code] = await once(ws, 'close');

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(code).toBe(1009);
    expect(auth.verifyCredential).not.toHaveBeenCalled();
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('caps unauthenticated connections per peer and recovers after cleanup', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn((value: string) => value === 'valid-credential'),
      authTimeoutMs: 500,
      maxUnauthenticatedConnections: 2,
      maxUnauthenticatedConnectionsPerPeer: 1,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const url = `ws://127.0.0.1:${address.port}`;
    const held = new WebSocket(url);
    await once(held, 'open');
    const rejected = new WebSocket(url);
    await once(rejected, 'open');
    const [rejectedCode, rejectedReason] = await once(rejected, 'close');
    expect(rejectedCode).toBe(4429);
    expect(rejectedReason.toString()).toBe('authentication_capacity_exceeded');

    held.close();
    await once(held, 'close');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovered = new WebSocket(url);
    await once(recovered, 'open');
    const acknowledgement = once(recovered, 'message');
    recovered.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    await acknowledgement;
    await vi.waitFor(() =>
      expect(voiceService.createSession).toHaveBeenCalledTimes(1),
    );

    // Successful authentication releases the admission slot even while the
    // business voice socket remains connected.
    const afterAuthentication = new WebSocket(url);
    await once(afterAuthentication, 'open');
    const secondAcknowledgement = once(afterAuthentication, 'message');
    afterAuthentication.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: 'valid-credential',
      }),
    );
    await secondAcknowledgement;
    await vi.waitFor(() =>
      expect(voiceService.createSession).toHaveBeenCalledTimes(2),
    );

    afterAuthentication.close();
    await once(afterAuthentication, 'close');
    recovered.close();
    await once(recovered, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('caps total unauthenticated connections independently of peer limits', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const auth = {
      classifyPeer: vi.fn(() => 'remote'),
      verifyCredential: vi.fn(() => false),
      authTimeoutMs: 500,
      maxUnauthenticatedConnections: 1,
      maxUnauthenticatedConnectionsPerPeer: 2,
    };
    const wss = attachVoiceWebSocket(
      0,
      voiceService as any,
      '127.0.0.1',
      auth as any,
    );
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const url = `ws://127.0.0.1:${address.port}`;
    const held = new WebSocket(url);
    await once(held, 'open');
    const rejected = new WebSocket(url);
    await once(rejected, 'open');
    const [code, reason] = await once(rejected, 'close');

    held.close();
    await once(held, 'close');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(code).toBe(4429);
    expect(reason.toString()).toBe('authentication_capacity_exceeded');
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('rejects unexpected paths without allocating a voice session', async () => {
    const voiceService = {
      createSession: vi.fn(),
      getActiveCount: vi.fn(() => 0),
    };
    const wss = attachVoiceWebSocket(0, voiceService as any, '127.0.0.1');
    if (!wss) throw new Error('voice websocket was not created');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/__station/health?probe=1`,
    );
    await once(ws, 'open');
    const [code, reason] = await once(ws, 'close');

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(code).toBe(4404);
    expect(reason.toString()).toBe('unexpected_path');
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });
});
