import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { createFeaturePreviewRoutes } from '../feature-previews.js';

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: (lock: string) =>
        actual.acquireFileMutationLockAsync(lock, {
          birthFingerprint: () => 'feature-preview-route-test',
        }),
    };
  },
);

const directories: string[] = [];
const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};

function registryWithConsumer() {
  const directory = mkdtempSync(
    join(tmpdir(), 'station-feature-preview-route-'),
  );
  directories.push(directory);
  const registry = new FeaturePreviewRegistry(directory, logger);
  registry.bind({
    id: 'real-consumer',
    label: 'Real consumer',
    description: 'A real branch.',
  });
  return registry;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('feature preview routes', () => {
  test('lists only bound consumer entries and persists a server-side toggle', async () => {
    const registry = registryWithConsumer();
    const app = createFeaturePreviewRoutes(registry, logger);

    const before = await app.request('/');
    expect(await before.json()).toMatchObject({
      success: true,
      data: [{ id: 'real-consumer', enabled: false }],
    });

    const update = await app.request('/real-consumer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(await update.json()).toMatchObject({
      success: true,
      data: { id: 'real-consumer', enabled: true },
    });

    const missing = await app.request('/invented', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });
});
