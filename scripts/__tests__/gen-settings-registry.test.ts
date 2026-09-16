import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildRegistryDocument,
  generateSettingsRegistry,
  loadRegistrySources,
  MINIMUM_REGISTRY_ENTRIES,
  serializeRegistry,
} from '../gen-settings-registry';

const ROOT = process.cwd();

/**
 * The real sources, loaded once. These tests deliberately run the generator
 * against the live catalog and registries rather than a fixture: the thing
 * under test is what it emits for the settings Station actually has, and a
 * fixture would retire that question.
 */
const sources = await loadRegistrySources(ROOT);
const document = buildRegistryDocument(sources);

describe('settings registry generator', () => {
  test('emits one entry per catalog row, above the floor', () => {
    expect(document.settings).toHaveLength(sources.catalog.length);
    expect(document.settings.length).toBeGreaterThanOrEqual(
      MINIMUM_REGISTRY_ENTRIES,
    );
    expect(document.$comment).toContain('do not edit');
  });

  test('every entry carries a non-empty label and a deep-link route', () => {
    for (const entry of document.settings) {
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.route, entry.id).toBe(
        `/settings?view=${encodeURIComponent(entry.section)}&highlight=${encodeURIComponent(entry.id)}`,
      );
    }
  });

  test('every entry with a config key carries non-empty help', () => {
    const withKey = document.settings.filter(
      (entry) => entry.configKey !== undefined,
    );
    // The assertion below iterates a list; a list that became empty would
    // pass it silently, so the population is pinned first.
    expect(withKey.length).toBeGreaterThan(20);
    const missing = withKey
      .filter((entry) => (entry.help ?? '').trim() === '')
      .map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  test('ids are unique, so a deep link identifies one control', () => {
    const ids = document.settings.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the floor refuses to write a catalog one entry short', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'settings-registry-floor-'));
    const outputPath = join(scratch, 'settings-registry.json');
    try {
      const short = {
        ...sources,
        catalog: sources.catalog.slice(0, MINIMUM_REGISTRY_ENTRIES - 1),
      };
      expect(short.catalog).toHaveLength(39);
      await expect(
        generateSettingsRegistry({ sources: short, outputPath }),
      ).rejects.toThrow(/below the floor/);
      expect(existsSync(outputPath), 'the refusal still wrote a file').toBe(
        false,
      );

      // One more entry and the same call writes, so the refusal is the floor
      // and not some other failure on this path.
      await expect(
        generateSettingsRegistry({
          sources: {
            ...sources,
            catalog: sources.catalog.slice(0, MINIMUM_REGISTRY_ENTRIES),
          },
          outputPath,
        }),
      ).resolves.toEqual({ written: true, entries: MINIMUM_REGISTRY_ENTRIES });
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('--check detects a stale file and passes on a current one', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'settings-registry-'));
    const outputPath = join(scratch, 'settings-registry.json');
    try {
      await expect(
        generateSettingsRegistry({ check: true, root: ROOT, outputPath }),
      ).rejects.toThrow(/is missing/);

      writeFileSync(outputPath, serializeRegistry(document), 'utf8');
      await expect(
        generateSettingsRegistry({ check: true, root: ROOT, outputPath }),
      ).resolves.toEqual({ written: false, entries: document.settings.length });

      const stale = {
        ...document,
        settings: document.settings.map((entry, index) =>
          index === 0 ? { ...entry, label: 'Edited by hand' } : entry,
        ),
      };
      writeFileSync(outputPath, serializeRegistry(stale), 'utf8');
      await expect(
        generateSettingsRegistry({ check: true, root: ROOT, outputPath }),
      ).rejects.toThrow(/stale/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('the checked-in artifact is what the sources produce', async () => {
    await expect(
      generateSettingsRegistry({ check: true, root: ROOT }),
    ).resolves.toEqual({ written: false, entries: document.settings.length });
  });
});
