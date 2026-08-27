import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  voiceOps: { add: vi.fn() },
  voiceSessionLifecycle: { add: vi.fn() },
}));

const { createVoiceRoutes } = await import('../voice.js');

function createMockVoiceService() {
  return {
    destroySession: vi.fn().mockResolvedValue(undefined),
    getActiveCount: vi.fn().mockReturnValue(2),
  };
}

describe('Voice Routes', () => {
  test('POST /sessions creates a voice session with explicit agent slug', async () => {
    const service = createMockVoiceService();
    const app = createVoiceRoutes(service as any);

    const body = await json(
      await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug: 'voice-agent' }),
      }),
    );

    expect(body.success).toBe(true);
    expect(body.data.agentSlug).toBe('voice-agent');
    expect(body.data.sessionId).toBeTruthy();
  });

  test('DELETE /sessions/:id destroys a voice session', async () => {
    const service = createMockVoiceService();
    const app = createVoiceRoutes(service as any);

    const body = await json(
      await app.request('/sessions/demo', { method: 'DELETE' }),
    );

    expect(body).toEqual({ success: true });
    expect(service.destroySession).toHaveBeenCalledWith('demo');
  });

  test('DELETE /sessions/:id does not respond before provider teardown settles', async () => {
    let release!: () => void;
    const service = createMockVoiceService();
    service.destroySession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const app = createVoiceRoutes(service as any);

    let settled = false;
    const response = Promise.resolve(
      app.request('/sessions/demo', { method: 'DELETE' }),
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const body = await json(await response);
    expect(body).toEqual({ success: true });
  });

  test('GET /status and /agent return active session info', async () => {
    const service = createMockVoiceService();
    const app = createVoiceRoutes(service as any);

    const status = await json(await app.request('/status'));
    const agent = await json(await app.request('/agent'));

    expect(status).toEqual({
      success: true,
      data: { activeSessions: 2 },
    });
    expect(agent).toEqual({
      success: true,
      data: { slug: 'station-voice', activeSessions: 2 },
    });
  });
});
