import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkPluginUpdates } from '../plugin-update-check.js';

describe('checkPluginUpdates (station#2236)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function pluginsDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'plugin-update-check-'));
    roots.push(root);
    return join(root, 'plugins');
  }

  const logger = { debug: vi.fn() };

  test('a missing plugins dir yields no updates without touching the network', async () => {
    const dir = pluginsDir();
    await expect(
      checkPluginUpdates({ pluginsDir: dir, logger }),
    ).resolves.toEqual({ updates: [] });
  });

  test('entries without a git checkout and manifest pair are skipped', async () => {
    const dir = pluginsDir();
    // A bare directory (no .git, no plugin.json) can never report drift.
    mkdirSync(join(dir, 'plain-dir'), { recursive: true });
    // A manifest without a checkout is not version-controlled either.
    mkdirSync(join(dir, 'no-git'), { recursive: true });
    writeFileSync(
      join(dir, 'no-git', 'plugin.json'),
      JSON.stringify({ name: 'no-git', version: '1.0.0' }),
    );
    await expect(
      checkPluginUpdates({ pluginsDir: dir, logger }),
    ).resolves.toEqual({ updates: [] });
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
