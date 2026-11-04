// @vitest-environment node

/**
 * #4517: managed settings at the seams every reader and writer goes through.
 *
 * The policy is built by the real decoder (`decodeManagedPolicy`), so the
 * fixture has exactly the shape the startup loader hands `StationRuntime`.
 * The loader cases run a real `ConfigLoader` against a temp Station home and
 * read the stored file back from disk, so "never written" is observed, not
 * assumed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { summarizeManagedPolicy } from '@kontourai/station-contracts/managed-policy';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../services/projects/project-service.js';
import { APP_CONFIG_SEED } from '../app-config-seed.js';
import { ConfigLoader } from '../config-loader.js';
import { observeAppConfigFile } from '../config-loader-app.js';
import { FileStorageAdapter } from '../file-storage-adapter.js';
import {
  assertManagedSettingsValid,
  assertProjectOverridesUnlocked,
  installManagedAppSettings,
  ManagedSettingLockedError,
  managedAppSettingsOf,
  overlayManagedAppSettings,
  withoutLockedNoOps,
  withoutLockedProjectOverrides,
} from '../managed-settings.js';
import { resolveEffectiveAppSetting } from '../settings-effective.js';
import { buildAppConfigProvenance } from '../settings-registry-server.js';
import { validator } from '../validator.js';

const makeTempDir = trackTempDirs();

function policy(
  settings: Record<string, { value: unknown; locked: boolean }>,
  supportUrl = 'https://help.example/station',
): LoadedManagedPolicy {
  const document = decodeManagedPolicy('/test/policy.json', {
    kind: 'value',
    value: { schemaVersion: 1, organization: 'Acme', supportUrl, settings },
  });
  return {
    source: { kind: 'test-override', location: '/test/policy.json' },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

const DENIAL =
  "Acme's policy manages this setting. For help, visit https://help.example/station";

const stored = (value: Record<string, unknown>) =>
  value as unknown as AppConfig;

afterEach(() => installManagedAppSettings(null));

describe('overlayManagedAppSettings', () => {
  const managed = managedAppSettingsOf(
    policy({
      defaultMaxTurns: { value: 40, locked: true },
      workspaceCheckpoints: { value: true, locked: false },
      mobileDeviceHubUrl: { value: 'http://managed.example', locked: false },
      systemPrompt: { value: 'Managed prompt.', locked: false },
    }),
  );

  test('a lock replaces the stored value; a default fills only an undecided key', () => {
    const effective = overlayManagedAppSettings(
      stored({ defaultMaxTurns: 7, workspaceCheckpoints: false }),
      managed,
      {},
    );
    expect(effective.defaultMaxTurns).toBe(40);
    // The user's own choice beats a managed default.
    expect(effective.workspaceCheckpoints).toBe(false);
    expect(effective.mobileDeviceHubUrl).toBe('http://managed.example');
  });

  test('an environment value the setting accepts beats a managed default', () => {
    const effective = overlayManagedAppSettings(stored({}), managed, {
      STATION_MOBILE_DEVICE_HUB_URL: 'http://env.example',
    });
    // Left absent, so the reader's own env fallback applies.
    expect(effective.mobileDeviceHubUrl).toBeUndefined();
  });

  test('a loader-written seed is the built-in default, so a managed default replaces it', () => {
    const effective = overlayManagedAppSettings(
      stored({ systemPrompt: APP_CONFIG_SEED.systemPrompt }),
      managed,
      {},
    );
    expect(effective.systemPrompt).toBe('Managed prompt.');
  });

  test('never mutates the stored config and is the identity with no policy', () => {
    const input = stored({ defaultMaxTurns: 7 });
    overlayManagedAppSettings(input, managed, {});
    expect(input).toEqual({ defaultMaxTurns: 7 });
    expect(overlayManagedAppSettings(input, null, {})).toBe(input);
  });
});

describe('resolution and provenance report the managed source', () => {
  const managed = managedAppSettingsOf(
    policy({
      defaultModel: { value: 'managed-model', locked: true },
      defaultMaxTurns: { value: 40, locked: false },
      workspaceCheckpoints: { value: true, locked: false },
    }),
  );

  test('resolver: lock > project > Station > environment > managed default > built-in', () => {
    const input = {
      config: stored({ defaultModel: 'mine', workspaceCheckpoints: false }),
      projectOverrides: { defaultModel: 'project-model' },
      environment: {},
      managed,
    };
    expect(resolveEffectiveAppSetting('defaultModel', input)).toEqual({
      value: 'managed-model',
      source: 'managed',
      locked: true,
    });
    expect(resolveEffectiveAppSetting('defaultMaxTurns', input)).toEqual({
      value: 40,
      source: 'managed',
      locked: false,
    });
    expect(resolveEffectiveAppSetting('workspaceCheckpoints', input)).toEqual({
      value: false,
      source: 'station',
    });
  });

  test('provenance names managed for a lock (over a project) and for an applied default', () => {
    const provenance = buildAppConfigProvenance(
      stored({ defaultModel: 'mine', workspaceCheckpoints: false }),
      {
        injected: {},
        projectOverrides: {
          defaultModel: 'project-model',
          defaultLLMProvider: 'p',
        },
        managed,
      },
    );
    const managedEntry = (locked: boolean) => ({
      source: 'managed',
      locked,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
    });
    expect(provenance.defaultModel).toEqual(managedEntry(true));
    expect(provenance.defaultMaxTurns).toEqual(managedEntry(false));
    // The user's stored choice outranks the managed default.
    expect(provenance.workspaceCheckpoints).toEqual({
      source: 'file',
      scope: 'station',
    });
    // Value-free: the entry never carries the managed value.
    expect(JSON.stringify(provenance)).not.toContain('managed-model');
  });
});

describe('ConfigLoader applies the overlay and refuses locked writes', () => {
  function home(app: Record<string, unknown>) {
    const dir = makeTempDir('station-managed-settings-');
    const loader = new ConfigLoader({ projectHomeDir: dir });
    return { dir, loader, app };
  }
  const readStored = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'config', 'app.json'), 'utf8'));

  async function seeded(app: Record<string, unknown>) {
    const h = home(app);
    // First load creates the file; then write the user's own values.
    await h.loader.loadAppConfig();
    writeFileSync(
      join(h.dir, 'config', 'app.json'),
      JSON.stringify({ ...readStored(h.dir), ...app }, null, 2),
    );
    return h;
  }

  test('a raw AppConfig reader sees the managed values; the stored file keeps the user’s', async () => {
    const { dir, loader } = await seeded({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({
        defaultMaxTurns: { value: 40, locked: true },
        workspaceCheckpoints: { value: true, locked: false },
      }),
    );
    const config = await loader.loadAppConfig();
    expect(config.defaultMaxTurns).toBe(40);
    expect(config.workspaceCheckpoints).toBe(true);
    expect((await loader.loadStoredAppConfig()).defaultMaxTurns).toBe(7);
    // Observers (registry trust, plugin admission) see it too.
    expect((await observeAppConfigFile(dir))?.defaultMaxTurns).toBe(40);
    expect(readStored(dir).defaultMaxTurns).toBe(7);
    expect(readStored(dir)).not.toHaveProperty('workspaceCheckpoints');
  });

  test('mutateAppConfig refuses a change to a locked key, writes nothing, and allows other keys', async () => {
    const { dir, loader } = await seeded({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({ defaultMaxTurns: { value: 40, locked: true } }),
    );
    const before = readFileSync(join(dir, 'config', 'app.json'), 'utf8');
    await expect(
      loader.updateAppConfig({ defaultMaxTurns: 9 }),
    ).rejects.toBeInstanceOf(ManagedSettingLockedError);
    await expect(
      loader.updateAppConfig({ defaultMaxTurns: null as never }),
    ).rejects.toBeInstanceOf(ManagedSettingLockedError);
    await expect(
      loader.updateAppConfig({ defaultMaxTurns: 9 }),
    ).rejects.toThrow(DENIAL);
    expect(readFileSync(join(dir, 'config', 'app.json'), 'utf8')).toBe(before);

    // A caller that spreads the stored config back changes nothing locked.
    const updated = await loader.mutateAppConfig((current) => ({
      ...current,
      checkoutStaleAfterDays: 5,
    }));
    expect(updated.defaultMaxTurns).toBe(40);
    expect(readStored(dir)).toMatchObject({
      defaultMaxTurns: 7,
      checkoutStaleAfterDays: 5,
    });
  });

  test('removing the policy restores the user’s own values, which were never overwritten', async () => {
    const { loader } = await seeded({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({
        defaultMaxTurns: { value: 40, locked: true },
        workspaceCheckpoints: { value: true, locked: false },
      }),
    );
    expect((await loader.loadAppConfig()).defaultMaxTurns).toBe(40);
    await loader.updateAppConfig({ checkoutStaleAfterDays: 4 });

    installManagedAppSettings(null);
    const restored = await loader.loadAppConfig();
    expect(restored.defaultMaxTurns).toBe(7);
    expect(restored.workspaceCheckpoints).toBeUndefined();
    expect(restored.checkoutStaleAfterDays).toBe(4);
  });

  test('a whole-file save may not change a locked key either', async () => {
    const { loader } = await seeded({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({ defaultMaxTurns: { value: 40, locked: true } }),
    );
    const effective = await loader.loadAppConfig();
    // Saving the EFFECTIVE config back would write the policy value.
    await expect(loader.saveAppConfig(effective)).rejects.toBeInstanceOf(
      ManagedSettingLockedError,
    );
  });
});

describe('route and project helpers', () => {
  const managed = managedAppSettingsOf(
    policy({
      defaultMaxTurns: { value: 40, locked: true },
      defaultWorkspaceIsolation: { value: 'shared', locked: true },
    }),
  );

  test('withoutLockedNoOps drops the locked value itself and refuses any other', () => {
    expect(
      withoutLockedNoOps({ defaultMaxTurns: 40, logLevel: 'info' }, managed),
    ).toEqual({ updates: { logLevel: 'info' } });
    const refused = withoutLockedNoOps({ defaultMaxTurns: 41 }, managed);
    expect(refused.refused?.key).toBe('defaultMaxTurns');
    expect(refused.refused?.message).toBe(DENIAL);
  });

  test('a project read hides a locked override; a project write may not change it', () => {
    const record = {
      slug: 'p',
      defaultWorkspaceIsolation: 'worktree' as const,
    };
    expect(withoutLockedProjectOverrides(record, managed)).not.toHaveProperty(
      'defaultWorkspaceIsolation',
    );
    expect(record.defaultWorkspaceIsolation).toBe('worktree');
    expect(() =>
      assertProjectOverridesUnlocked(
        { defaultWorkspaceIsolation: 'shared' },
        record,
        managed,
      ),
    ).toThrow(DENIAL);
    expect(() =>
      assertProjectOverridesUnlocked(
        { defaultWorkspaceIsolation: null },
        record,
        managed,
      ),
    ).toThrow(ManagedSettingLockedError);
    // Resending what is stored changes nothing.
    expect(() =>
      assertProjectOverridesUnlocked(
        { defaultWorkspaceIsolation: 'worktree', name: 'x' },
        record,
        managed,
      ),
    ).not.toThrow();
  });
});

describe('assertManagedSettingsValid (startup)', () => {
  const validate = (config: unknown) => validator.validateAppConfig(config);

  test('accepts schema-valid composite values', () => {
    expect(() =>
      assertManagedSettingsValid(
        policy({
          approvalGuardian: { value: { enabled: true }, locked: true },
        }),
        validate,
        APP_CONFIG_SEED,
      ),
    ).not.toThrow();
  });

  test('refuses a composite value the settings schema rejects, with the policy marker', () => {
    expect(() =>
      assertManagedSettingsValid(
        policy({
          approvalGuardian: { value: { mode: 'sometimes' }, locked: true },
        }),
        validate,
        APP_CONFIG_SEED,
      ),
    ).toThrow(
      /^STATION_MANAGED_POLICY_INVALID: .*a managed setting does not match the settings schema/,
    );
  });
});

describe('project overrides of a locked setting, through the real project service', () => {
  async function projects() {
    const home = makeTempDir('station-managed-project-');
    const storage = new FileStorageAdapter(home);
    const service = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    await service.createProject({ name: 'Locked', slug: 'locked' });
    await service.updateProject('locked', {
      defaultWorkspaceIsolation: 'shared',
    });
    const storedRecord = () =>
      JSON.parse(
        readFileSync(join(home, 'projects', 'locked', 'project.json'), 'utf8'),
      );
    return { storage, service, storedRecord };
  }

  test('readers lose the override while locked; the stored record keeps it for after removal', async () => {
    const { storage, storedRecord } = await projects();
    installManagedAppSettings(
      policy({
        defaultWorkspaceIsolation: { value: 'worktree', locked: true },
      }),
    );
    expect(storage.getProject('locked')).not.toHaveProperty(
      'defaultWorkspaceIsolation',
    );
    expect(storedRecord().defaultWorkspaceIsolation).toBe('shared');

    installManagedAppSettings(null);
    expect(storage.getProject('locked').defaultWorkspaceIsolation).toBe(
      'shared',
    );
  });

  test('a project write that changes a locked override is refused; other fields save', async () => {
    const { service, storedRecord } = await projects();
    installManagedAppSettings(
      policy({
        defaultWorkspaceIsolation: { value: 'worktree', locked: true },
      }),
    );
    await expect(
      service.updateProject('locked', {
        defaultWorkspaceIsolation: 'worktree',
      }),
    ).rejects.toThrow(DENIAL);
    await expect(
      service.createProject({
        name: 'Other',
        slug: 'other',
        defaultWorkspaceIsolation: 'shared',
      }),
    ).rejects.toBeInstanceOf(ManagedSettingLockedError);
    await service.updateProject('locked', { description: 'still editable' });
    expect(storedRecord()).toMatchObject({
      defaultWorkspaceIsolation: 'shared',
      description: 'still editable',
    });
  });
});
