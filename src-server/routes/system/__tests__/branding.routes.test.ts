import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  providerOps: { add: vi.fn() },
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  getBrandingProvider: () => ({
    getAppName: async () => 'Station',
    getLogo: async () => null,
    getTheme: async () => ({ primary: '#000' }),
    getWelcomeMessage: async () => 'Hello!',
  }),
}));

const { createBrandingRoutes } = await import('../branding.js');

describe('Branding Routes', () => {
  test('GET / returns branding config', async () => {
    const app = createBrandingRoutes();
    const body = await json(await app.request('/'));
    expect(body.data.name).toBe('Station');
    expect(body.data.theme).toEqual({ primary: '#000' });
    expect(body.data.welcomeMessage).toBe('Hello!');
  });
});
