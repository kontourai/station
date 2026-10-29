import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { FeaturePreviewSelector } from '../../../services/feature-previews/feature-preview-registry.js';
import { __workloadTestHooks } from '../../../services/infra/workload-resources.js';
import { createWorkloadRoutes } from '../workload-routes.js';

const MIB = 1024 * 1024;
const makeTempDir = trackTempDirs();

function selector(enabled: () => boolean): FeaturePreviewSelector {
  return {
    select: (branches) =>
      enabled() ? branches.enabled() : branches.disabled(),
  };
}

describe('workload budget routes', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
    __workloadTestHooks.reset();
  });

  async function setup() {
    process.env = { ...env };
    delete process.env.STATION_WORKLOAD_MEMORY_MIB;
    delete process.env.STATION_WORKLOAD_TOTAL_MEMORY_MIB;
    const home = makeTempDir('workload-routes-');
    const calls: string[][] = [];
    await __workloadTestHooks.start({
      homeDir: home,
      cgroupRoot: join(home, 'cgroup'),
      run: async (args) => {
        calls.push(args);
        return '';
      },
    });
    let enabled = false;
    const app = new Hono().route(
      '/api/system',
      createWorkloadRoutes({
        operator: { settingsPreview: selector(() => enabled) },
        resolveCallerSession: () => null,
      }),
    );
    const put = (body: unknown) =>
      app.request('/api/system/workload/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    return {
      app,
      put,
      calls,
      file: join(home, 'config', 'workload-budgets.json'),
      enable: () => {
        enabled = true;
      },
    };
  }

  test('the settings write is refused, with nothing written, while its preview is off', async () => {
    const { put, calls, file } = await setup();
    const before = calls.length;
    const response = await put({ memoryMiB: 600, totalMemoryMiB: 900 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error:
        'Enable Workload budget settings in Settings → Advanced → Feature previews.',
      code: 'feature_preview_disabled',
      previewId: 'workload-budget-settings',
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    });
    expect(existsSync(file)).toBe(false);
    expect(calls.length).toBe(before);
  });

  test('enabled, a valid write persists and re-applies the slice; an invalid one is refused', async () => {
    const { put, calls, file, enable, app } = await setup();
    enable();
    const response = await put({ memoryMiB: 600, totalMemoryMiB: 900 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        settings: { memoryMiB: 600, totalMemoryMiB: 900 },
        limits: { memoryMaxBytes: 600 * MIB, totalMemoryMaxBytes: 900 * MIB },
        sources: { memory: 'settings', totalMemory: 'settings' },
        applies: 'new-scopes',
      },
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      memoryMiB: 600,
      totalMemoryMiB: 900,
    });
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining(['set-property', `MemoryMax=${900 * MIB}`]),
    );

    const rejected = await put({ memoryMiB: 900, totalMemoryMiB: 600 });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      code: 'workload_settings_invalid',
    });
    expect((await put({ memoryMiB: 'lots' })).status).toBe(400);

    // null returns a value to its default.
    expect(
      await (await put({ memoryMiB: null, totalMemoryMiB: 900 })).json(),
    ).toMatchObject({
      data: {
        settings: { totalMemoryMiB: 900 },
        sources: { memory: 'default' },
      },
    });
    expect(
      await (await app.request('/api/system/workload')).json(),
    ).toMatchObject({
      success: true,
      data: { hostMemoryBytes: expect.any(Number) },
    });
  });

  test('hosted composition mounts no operator routes', async () => {
    const app = new Hono().route(
      '/api/system',
      createWorkloadRoutes({ resolveCallerSession: () => null }),
    );
    expect((await app.request('/api/system/workload')).status).toBe(404);
    expect(
      (
        await app.request('/api/system/workload/settings', {
          method: 'PUT',
          body: '{}',
        })
      ).status,
    ).toBe(404);
  });
});
