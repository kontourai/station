import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import { describe, expect, test } from 'vitest';
import {
  buildRegistryDocument,
  generateSettingsRegistry,
  loadRegistrySources,
  MINIMUM_REGISTRY_CONFIG_KEYS,
  MINIMUM_REGISTRY_ENTRIES,
  REGISTRY_ARTIFACT_PATH,
  REGISTRY_SOURCE_PATHS,
  serializeRegistry,
} from '../gen-settings-registry';
import { selectChangedVerification } from '../run-changed-verification.mjs';

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

  test('the config-key floor refuses a full-length catalog that lost its keys', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'settings-registry-keys-'));
    const outputPath = join(scratch, 'settings-registry.json');
    try {
      // The first floor cannot see this: every entry is still here, so the
      // count is 45 and passes. What is gone is the key that resolves `help`.
      const keyless = {
        ...sources,
        catalog: sources.catalog.map(
          ({ configKeys: _dropped, ...rest }) => rest,
        ),
      };
      const keylessDocument = buildRegistryDocument(keyless);
      expect(keylessDocument.settings.length).toBeGreaterThanOrEqual(
        MINIMUM_REGISTRY_ENTRIES,
      );
      expect(
        keylessDocument.settings.filter(
          (entry) => entry.configKey !== undefined,
        ),
      ).toHaveLength(0);

      await expect(
        generateSettingsRegistry({ sources: keyless, outputPath }),
      ).rejects.toThrow(/carry a config key/);
      expect(existsSync(outputPath), 'the refusal still wrote a file').toBe(
        false,
      );

      // And the two floors are independent: 39 entries that all keep their
      // keys clears this floor and is stopped by the other one, so neither
      // is standing in for the other.
      const short = {
        ...sources,
        catalog: sources.catalog.slice(0, MINIMUM_REGISTRY_ENTRIES - 1),
      };
      expect(
        buildRegistryDocument(short).settings.filter(
          (entry) => entry.configKey !== undefined,
        ).length,
      ).toBeGreaterThanOrEqual(MINIMUM_REGISTRY_CONFIG_KEYS);
      await expect(
        generateSettingsRegistry({ sources: short, outputPath }),
      ).rejects.toThrow(/below the floor/);
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

  test('a change to any generator input selects this suite in the pull-request lane', () => {
    // #2176: the sources load through a computed specifier and the artifact
    // is read by path, so no import edge reaches this suite from any of them.
    // Without an impact edge, a new settings row first failed the two
    // assertions above in the merge queue's full corpus (#2511, #2593). The
    // list is the generator's own, so a new source without an edge reds here.
    const inputs = [...REGISTRY_SOURCE_PATHS, REGISTRY_ARTIFACT_PATH];
    expect(inputs).toHaveLength(5);
    const unselected = inputs.filter(
      (path) =>
        !selectChangedVerification([path]).tests.some(
          (entry) =>
            entry.path === 'scripts/__tests__/gen-settings-registry.test.ts',
        ),
    );
    expect(unselected).toEqual([]);
  });
});

/**
 * The published write authority of every settings row, pinned literally.
 *
 * `scope` is the field that tells an agent WHICH DOCUMENT to write, so it is
 * the one field in this artifact that a purely presentational change must
 * never move. Before #2182 it was derived from the row's SECTION, which made
 * it move with any information-architecture change: filing the Station-scope
 * `default-chat-font-size` row under the device-scope Chat card would have
 * published `scope: "device"` for a key that lives in the Station document,
 * and an agent reading this artifact would have written it to the wrong one.
 * Nothing on screen would have said so — `scopeBadgeLabel` collapses
 * `station` and `defaults` to the same chip.
 *
 * It is pinned as an exhaustive MAP, not a spot check: the defect this
 * catches is a row silently changing authority while every count, every
 * route and every label stays correct.
 */
/** What each registry declares for its own key — the authority `scope` copies. */
const DECLARED_SCOPE: ReadonlyMap<string, string> = new Map(
  [...APP_SETTINGS_REGISTRY, ...DEVICE_SETTINGS_REGISTRY].map((definition) => [
    String(definition.key),
    definition.scope as string,
  ]),
);

const PUBLISHED_SCOPE_BY_ID: Readonly<Record<string, string>> = {
  'approval-guardian': 'station',
  'usage-telemetry': 'station',
  'telemetry-destination': 'informational',
  'default-max-turns': 'station',
  'default-max-output-tokens': 'station',
  'default-chat-font-size': 'station',
  'terminal-shell': 'station',
  'mcp-ui-host': 'station',
  'surface-trust': 'station',
  'device-helper-url': 'station',
  'default-skill-registries': 'station',
  'workspace-checkpoints': 'station',
  'default-workspace-isolation': 'station',
  'device-hosts': 'station',
  'default-approval-mode': 'station',
  'registry-url': 'station',
  'distribution-profile': 'station',
  'builtin-agent-engine': 'station',
  'desktop-app-updates': 'station',
  'core-app-updates': 'station',
  'deployed-build': 'informational',
  'log-level': 'station',
  'backup-restore': 'mixed',
  'reset-defaults': 'station',
  'reset-device-defaults': 'device',
  'feature-previews': 'station',
  'enable-developer-tools': 'device',
  'shared-answers': 'station',
  'plugin-visibility': 'station',
  'host-runtime': 'informational',
  'diagnostics-bundle': 'informational',
  'default-model': 'defaults',
  'default-region': 'defaults',
  'default-agent-instructions': 'defaults',
  'template-variables': 'defaults',
  'chat-font-size': 'device',
  'smooth-answer-reveal': 'device',
  'chat-show-reasoning': 'device',
  'chat-show-tool-details': 'device',
  'chat-dock-auto-hide': 'device',
  'chat-auto-float-browser': 'device',
  'diff-style': 'device',
  'diff-wrap': 'device',
  theme: 'device',
  'sidebar-sections': 'device',
  'haptic-feedback': 'device',
  'confirm-conversation-delete': 'device',
  'accent-color': 'device',
  'keyboard-shortcuts': 'device',
  'push-notifications': 'device',
  'speech-to-text': 'device',
  'text-to-speech': 'device',
  'message-context': 'temporary',
  'voice-pill': 'device',
  'mobile-pairing': 'device',
  'open-last-station': 'device',
  'tts-readback': 'device',
  'personal-knowledge-store': 'station',
};

describe('published write authority', () => {
  test('every row publishes the scope of the document it writes', () => {
    expect(
      Object.fromEntries(
        document.settings.map((entry) => [entry.id, entry.scope]),
      ),
    ).toEqual(PUBLISHED_SCOPE_BY_ID);
  });

  test('a row with a config key takes its scope from that key, not its section', () => {
    // The population is pinned first: an assertion that iterates a list is
    // satisfied by an empty list.
    const withKey = document.settings.filter(
      (entry) => entry.configKey !== undefined,
    );
    expect(withKey.length).toBeGreaterThan(30);
    const mismatched = withKey
      .filter((entry) => DECLARED_SCOPE.has(entry.configKey as string))
      .filter(
        (entry) =>
          entry.scope !== DECLARED_SCOPE.get(entry.configKey as string),
      )
      .map((entry) => `${entry.id} (${entry.configKey}): ${entry.scope}`);
    // No exemption list. Every row that names a key agrees with that key's
    // registry today, and a row that needed to disagree would have to say so
    // here rather than acquiring the difference from where it is rendered.
    expect(mismatched).toEqual([]);
  });
});
