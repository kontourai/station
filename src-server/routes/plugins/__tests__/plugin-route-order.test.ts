import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Logger } from '../../../utils/logger.js';
import { createPluginRoutes } from '../plugins.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
}

// These requests go through the COMPOSED plugins router, not a module's
// registrar mounted alone. That distinction is the point: every module's own
// suite passed while `DELETE /home-role` was unreachable, because Hono matches
// in registration order and the lifecycle `DELETE /:name` was registered
// first (#477).
describe('composed plugin route order', () => {
  test('station#477: DELETE /home-role reaches the home-role handler, not the lifecycle catch-all', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-route-order-'));
    cleanup.push(home);
    mkdirSync(join(home, 'plugins'), { recursive: true });
    mkdirSync(join(home, 'agents'), { recursive: true });
    const emit = vi.fn();
    const app = createPluginRoutes(home, makeLogger(), {
      emit,
    } as never);

    const response = await app.request('/home-role', { method: 'DELETE' });

    // The lifecycle catch-all answers 404 "Plugin not found" here (no plugin
    // directory named home-role exists, and every supported install path
    // refuses the name as a reserved identity). Success proves the home-role
    // handler received the request.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(emit).toHaveBeenCalledWith(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
      name: 'workspace-home-role',
    });
  });

  test('the lifecycle catch-all still answers for ordinary plugin names after the reorder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-route-order-'));
    cleanup.push(home);
    mkdirSync(join(home, 'plugins'), { recursive: true });
    mkdirSync(join(home, 'agents'), { recursive: true });
    const app = createPluginRoutes(home, makeLogger());

    const response = await app.request('/no-such-plugin', { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Plugin not found',
    });
  });
});
