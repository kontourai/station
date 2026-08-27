import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  FeaturePreviewNotOfferedError,
  FeaturePreviewRegistry,
  featurePreviewStatePath,
} from '../feature-preview-registry.js';

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
          birthFingerprint: () => 'feature-preview-registry-test',
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

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'station-feature-previews-'));
  directories.push(directory);
  return directory;
}

function bindProbe(registry: FeaturePreviewRegistry) {
  return registry.bind({
    id: 'probe',
    label: 'Probe',
    description: 'Selects a real branch.',
  });
}

function selectProbe(
  selector: ReturnType<typeof bindProbe>,
): 'probed' | 'skipped' {
  return selector.select({
    enabled: () => 'probed',
    disabled: () => 'skipped',
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('FeaturePreviewRegistry', () => {
  test('a bound consumer enters the catalog before its branch runs', () => {
    const registry = new FeaturePreviewRegistry(home(), logger);

    expect(registry.list()).toEqual([]);
    const probe = bindProbe(registry);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: 'probe', enabled: false }),
    ]);
    expect(Object.hasOwn(registry, 'register')).toBe(false);
    expect(selectProbe(probe)).toBe('skipped');
  });

  test('persists an enabled choice across a fresh registry and changes the consuming branch', async () => {
    const directory = home();
    const first = new FeaturePreviewRegistry(directory, logger);
    const firstProbe = bindProbe(first);
    expect(selectProbe(firstProbe)).toBe('skipped');

    await first.setEnabled('probe', true);
    expect(selectProbe(firstProbe)).toBe('probed');

    // A new registry is the restart boundary: it must read the durable state,
    // then the same consuming path (not a hand-built response) changes.
    const restarted = new FeaturePreviewRegistry(directory, logger);
    expect(selectProbe(bindProbe(restarted))).toBe('probed');
  });

  test('cannot toggle or list a persisted id that has no live consumer', async () => {
    const directory = home();
    const registry = new FeaturePreviewRegistry(directory, logger);
    mkdirSync(join(directory, 'config'), { recursive: true });
    writeFileSync(
      featurePreviewStatePath(directory),
      JSON.stringify({ orphaned: { enabled: true } }),
    );

    expect(registry.list()).toEqual([]);
    await expect(registry.setEnabled('orphaned', false)).rejects.toBeInstanceOf(
      FeaturePreviewNotOfferedError,
    );
  });
});
