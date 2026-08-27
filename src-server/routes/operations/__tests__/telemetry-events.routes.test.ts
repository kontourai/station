import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

const { createTelemetryRoutes } = await import('../telemetry-events.js');

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};

describe('Telemetry Events Routes', () => {
  test('POST /events logs plugin events', async () => {
    const app = createTelemetryRoutes(mockLogger);
    const body = await json(
      await app.request('/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-station-plugin': 'test-plugin',
        },
        body: JSON.stringify({ events: [{ name: 'click', data: {} }] }),
      }),
    );
    expect(body.success).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Plugin telemetry event',
      expect.objectContaining({ plugin: 'test-plugin', name: 'click' }),
    );
  });

  test('POST /events returns 400 on bad body', async () => {
    const app = createTelemetryRoutes(mockLogger);
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
