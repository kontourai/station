import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  bootPayloadServed: { add: vi.fn() },
  bootPayloadSectionErrors: { add: vi.fn() },
}));

const { createBootRoutes, BOOT_PAYLOAD_VERSION } = await import('../boot.js');

describe('boot routes', () => {
  const providers = () => ({
    auth: async () => ({ authenticated: true }),
    config: async () => ({ success: true, data: {} }),
    capabilities: async () => ({ runtime: 'station' }),
    branding: async () => ({ success: true, data: { name: 'Station' } }),
    agents: async () => ({ success: true, data: [] }),
    projects: async () => ({ success: true, data: [] }),
    models: async () => ({ success: true, data: [] }),
  });
  test('returns a versioned complete envelope', async () => {
    const response = await createBootRoutes(providers()).request('/');
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      version: BOOT_PAYLOAD_VERSION,
      sections: {
        auth: { data: { authenticated: true } },
        models: { data: { success: true, data: [] } },
      },
    });
  });
  test('isolates one provider failure', async () => {
    const response = await createBootRoutes({
      ...providers(),
      projects: async () => {
        throw new Error('unavailable');
      },
    }).request('/');
    expect(response.status).toBe(200);
    expect((await json(response)).sections.projects).toEqual({ error: true });
  });
});
