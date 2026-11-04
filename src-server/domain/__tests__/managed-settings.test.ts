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
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { afterEach, describe, expect, test } from 'vitest';
import { captureLoggerLines } from '../../__test-utils__/logger-capture.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../services/projects/project-service.js';
import {
  applyConfiguredLogLevel,
  createLogger,
  resolveLogLevel,
  setGlobalLogLevel,
} from '../../utils/logger.js';
import { APP_CONFIG_SEED } from '../app-config-seed.js';
import { ConfigLoader } from '../config-loader.js';
import { observeAppConfigFile } from '../config-loader-app.js';
import { FileStorageAdapter } from '../file-storage-adapter.js';
import {
  assertManagedSettingsValid,
  installManagedAppSettings,
  ManagedSettingLockedError,
  managedAppSettingsOf,
  overlayManagedAppSettings,
  projectUpdatesWithoutLockedFields,
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
      projectUpdatesWithoutLockedFields(
        { defaultWorkspaceIsolation: 'shared' },
        record,
        managed,
      ),
    ).toThrow(DENIAL);
    // "No choice", as a form that saw the field hidden sends it, and the
    // stored value itself are dropped: the stored record keeps its value.
    for (const resent of [null, '', 'worktree'])
      expect(
        projectUpdatesWithoutLockedFields(
          { defaultWorkspaceIsolation: resent, name: 'x' },
          record,
          managed,
        ),
      ).toEqual({ name: 'x' });
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

describe('a lock takes the whole project choice it outranks', () => {
  async function storedProject(fields: Partial<ProjectConfig>) {
    const home = makeTempDir('station-managed-project-pair-');
    const storage = new FileStorageAdapter(home);
    const service = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    await service.createProject({ name: 'Pair', slug: 'pair' });
    await service.updateProject('pair', fields);
    const storedRecord = () =>
      JSON.parse(
        readFileSync(join(home, 'projects', 'pair', 'project.json'), 'utf8'),
      );
    return { storage, service, storedRecord };
  }

  const MODEL_CHOICE = {
    defaultProviderId: 'project-provider',
    defaultModel: 'project-model',
    defaultModelSelection: 'last-used',
  } as const;

  for (const lockedKey of ['defaultModel', 'defaultLLMProvider'] as const) {
    test(`locking ${lockedKey} hides the project's model, provider and model selection`, async () => {
      const { storage, service, storedRecord } =
        await storedProject(MODEL_CHOICE);
      installManagedAppSettings(
        policy({ [lockedKey]: { value: 'managed-value', locked: true } }),
      );
      const read = storage.getProject('pair');
      for (const field of Object.keys(MODEL_CHOICE))
        expect(read).not.toHaveProperty(field);
      expect(
        storage.listProjects().find((p) => p.slug === 'pair')
          ?.defaultProviderId,
      ).toBeUndefined();
      // Either half of the pair is refused on write.
      await expect(
        service.updateProject('pair', { defaultProviderId: 'other' }),
      ).rejects.toBeInstanceOf(ManagedSettingLockedError);
      await expect(
        service.updateProject('pair', { defaultModel: 'other' }),
      ).rejects.toBeInstanceOf(ManagedSettingLockedError);
      expect(storedRecord()).toMatchObject(MODEL_CHOICE);
    });
  }

  test('locking defaultApprovalMode hides the project approval default and its selection', async () => {
    const { storage, service, storedRecord } = await storedProject({
      defaultApprovalMode: 'auto',
      defaultApprovalModeSelection: 'last-used',
    });
    installManagedAppSettings(
      policy({ defaultApprovalMode: { value: 'ask', locked: true } }),
    );
    const read = storage.getProject('pair');
    expect(read).not.toHaveProperty('defaultApprovalMode');
    expect(read).not.toHaveProperty('defaultApprovalModeSelection');
    await expect(
      service.updateProject('pair', { defaultApprovalMode: 'ask' }),
    ).rejects.toThrow(DENIAL);
    // Resending the stored (hidden) value changes nothing and is dropped.
    await expect(
      service.updateProject('pair', { defaultApprovalMode: 'auto' }),
    ).resolves.not.toHaveProperty('defaultApprovalMode');
    await expect(
      service.updateProject('pair', {
        defaultApprovalModeSelection: 'last-used',
      }),
    ).resolves.toBeDefined();
    await expect(
      service.updateProject('pair', { defaultApprovalModeSelection: 'fixed' }),
    ).rejects.toBeInstanceOf(ManagedSettingLockedError);
    expect(storedRecord()).toMatchObject({
      defaultApprovalMode: 'auto',
      defaultApprovalModeSelection: 'last-used',
    });
  });

  test('a successful project write answers with what readers see, not the stored override', async () => {
    const { service, storedRecord } = await storedProject({
      defaultWorkspaceIsolation: 'shared',
      ...MODEL_CHOICE,
    });
    installManagedAppSettings(
      policy({
        defaultWorkspaceIsolation: { value: 'worktree', locked: true },
        defaultModel: { value: 'managed-model', locked: true },
      }),
    );
    // The project settings form's own save shape after a masked read.
    const updated = await service.updateProject('pair', {
      description: 'edited under the lock',
      defaultWorkspaceIsolation: null,
      defaultModelSelection: null,
      defaultModel: '',
      defaultProviderId: '',
    } as never);
    expect(updated.description).toBe('edited under the lock');
    for (const field of [
      'defaultWorkspaceIsolation',
      ...Object.keys(MODEL_CHOICE),
    ])
      expect(updated).not.toHaveProperty(field);
    expect(storedRecord()).toMatchObject({
      defaultWorkspaceIsolation: 'shared',
      ...MODEL_CHOICE,
      description: 'edited under the lock',
    });
  });
});

describe('real environment readers keep the precedence', () => {
  const ENV = ['STATION_LOG_LEVEL'] as const;
  const saved = Object.fromEntries(
    ENV.map((name) => [name, process.env[name]]),
  );
  afterEach(() => {
    for (const name of ENV)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    setGlobalLogLevel('info');
  });

  test('a logLevel lock outranks STATION_LOG_LEVEL in the logger itself', () => {
    process.env.STATION_LOG_LEVEL = 'debug';
    const capture = captureLoggerLines();
    try {
      // A logger created before the policy loads, as the entrypoint's are.
      const early = createLogger({ name: 'managed-lock-early' });
      early.debug('before the policy');
      expect(capture.at('debug').map((line) => line.msg)).toEqual([
        'before the policy',
      ]);

      installManagedAppSettings(
        policy({ logLevel: { value: 'error', locked: true } }),
      );
      expect(resolveLogLevel()).toBe('error');
      const late = createLogger({ name: 'managed-lock-late' });
      for (const logger of [early, late]) {
        logger.debug('dropped debug');
        logger.warn('dropped warn');
        logger.error('kept error');
      }
      // A configured-level change (the log-level route's path) cannot
      // lower it either.
      applyConfiguredLogLevel('trace', late);
      late.debug('dropped after apply');
      expect(capture.lines().map((line) => line.msg)).toEqual([
        'before the policy',
        'kept error',
        'kept error',
      ]);

      installManagedAppSettings(null);
      expect(resolveLogLevel()).toBe('debug');
    } finally {
      capture.stop();
    }
  });

  test('a logLevel or terminalShell default loses to the variable its consumer reads', () => {
    const managed = managedAppSettingsOf(
      policy({
        logLevel: { value: 'warn', locked: false },
        terminalShell: { value: '/bin/managed-sh', locked: false },
      }),
    );
    const withEnv = overlayManagedAppSettings(stored({}), managed, {
      STATION_LOG_LEVEL: 'debug',
      SHELL: '/bin/zsh',
    });
    expect(withEnv.logLevel).toBeUndefined();
    expect(withEnv.terminalShell).toBeUndefined();
    const provenance = buildAppConfigProvenance(stored({}), {
      injected: {},
      managed,
    });
    // Provenance reads this process's environment, like the overlay's default.
    expect(provenance.terminalShell?.source === 'managed').toBe(
      !process.env.SHELL,
    );
    // An invalid level is not a decision; the default applies.
    expect(
      overlayManagedAppSettings(stored({}), managed, {
        STATION_LOG_LEVEL: 'loud',
      }).logLevel,
    ).toBe('warn');
  });
});
