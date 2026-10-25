/**
 * Persisted install trust records through the real installer and the real
 * start-time migration (#2998, d1 part 2).
 *
 * Pre-d1 state is built by the writers a pre-d1 installer called, never by
 * running the d1 installer and deleting its output: the plugin tree copied
 * into `plugins/`, `grantPermissions` for a content-bound grant, the local
 * installation service for an agent plugin's EventStore journal entry, and
 * the `string[]` grants entry the pre-archive#4288 writer produced. No trust
 * file and no journal migration row exist.
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  bindOperatorPrincipal,
  withOperatorPrincipal,
} from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { registerPluginInstallRoutes } from '../../../routes/plugins/plugin-install-routes.js';
import { createRegistryRoutes } from '../../../routes/plugins/registry.js';
import { EventStore } from '../../orchestration/event-store.js';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import {
  derivePluginConsentBasis,
  type PluginInstallConsent,
} from '../plugin-install-consent.js';
import {
  installPluginFromSource,
  uninstallInstalledPlugin,
} from '../plugin-install-transaction.js';
import {
  parsePluginsLock,
  type SigstoreSignerPin,
} from '../plugin-install-trust.js';
import { migratePluginInstallTrustAtStartup } from '../plugin-install-trust-migration.js';
import {
  type PluginInstallTrustPolicy,
  PluginInstallTrustRefused,
} from '../plugin-install-trust-recording.js';
import {
  PluginTrustRecordsUnavailableError,
  pluginTrustForInstalledBytes,
  pluginTrustMigrationWitness,
  pluginTrustRecordsPath,
  readPluginTrustRecord,
} from '../plugin-install-trust-store.js';
import {
  captureLocalPluginInstallation,
  createLocalPluginInstallationService,
} from '../plugin-installation-local.js';
import { readPluginManifestFile } from '../plugin-manifest-loader.js';
import { getPluginGrants, grantPermissions } from '../plugin-permissions.js';
import type {
  PluginSigstoreVerifier,
  SigstoreCertificateIdentity,
} from '../plugin-sigstore-verifier.js';
import {
  fetchPluginSource,
  installPluginDependency,
} from '../plugin-source.js';

const failTrustWrite = vi.hoisted(() => ({ next: false }));
vi.mock('../plugin-install-trust-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../plugin-install-trust-store.js')>();
  return {
    ...actual,
    // The reviewer's probe: the record write is the install's last fallible
    // step, so failing it must roll the whole install back.
    writePluginTrustRecord: async (
      ...args: Parameters<typeof actual.writePluginTrustRecord>
    ) => {
      if (failTrustWrite.next) {
        failTrustWrite.next = false;
        throw new Error('injected trust record write failure');
      }
      return actual.writePluginTrustRecord(...args);
    },
  };
});

// Lets a test hold one install after it prepared its trust decision but
// before it takes the content lock, to interleave two installs of a name.
const prepareGate = vi.hoisted(() => ({
  hold: null as null | { reached: () => void; release: Promise<void> },
}));
vi.mock('../plugin-install-trust-recording.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../plugin-install-trust-recording.js')
    >();
  return {
    ...actual,
    preparePluginInstallTrust: async (
      ...args: Parameters<typeof actual.preparePluginInstallTrust>
    ) => {
      const prepared = await actual.preparePluginInstallTrust(...args);
      const hold = prepareGate.hold;
      if (hold) {
        prepareGate.hold = null;
        hold.reached();
        await hold.release;
      }
      return prepared;
    },
  };
});

const agentRegistry = vi.hoisted(() => ({
  provider: {
    listAvailable: async () => [] as unknown[],
  } as Record<string, unknown>,
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  getAgentRegistryProvider: () => agentRegistry.provider,
  getIntegrationRegistryProvider: vi.fn().mockReturnValue({
    getToolDef: vi.fn().mockResolvedValue(null),
    install: vi.fn(),
    installByCommand: vi.fn(),
    listInstalled: vi.fn().mockResolvedValue([]),
  }),
  getPluginRegistryProviders: vi.fn().mockReturnValue([]),
  getSkillRegistryProviders: () => [],
  replacePluginProvidersForSource: vi.fn(),
  pluginProviderSourceGeneration: () => 0,
  replacePluginProvidersForSourceGeneration: async () => 'activated',
}));

const tempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as any;
}

async function home() {
  const root = tempDir('station-trust-records-');
  await ensureStationHomeSchema(root);
  return root;
}

function deps(root: string, extra: Record<string, unknown> = {}) {
  return {
    agentsDir: join(root, 'agents'),
    buildPlugin: vi.fn().mockResolvedValue(undefined),
    logger: logger(),
    pluginsDir: join(root, 'plugins'),
    projectHomeDir: root,
    ...extra,
  };
}

function writeSource(
  root: string,
  dir: string,
  manifest: Record<string, unknown>,
  body = 'export default {};',
): string {
  const source = join(root, dir);
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'index.js'), body);
  return source;
}

async function consentFor(
  source: string,
  root: string,
): Promise<Extract<PluginInstallConsent, { kind: 'operator-decision' }>> {
  const staged = await fetchPluginSource(
    source,
    join(root, 'plugins'),
    logger(),
  );
  if ('error' in staged) throw new Error(staged.error);
  try {
    const manifest = await readPluginManifestFile(
      join(staged.tempDir, 'plugin.json'),
    );
    const basis = derivePluginConsentBasis(staged.tempDir, manifest);
    if (!basis) throw new Error('no consent basis');
    return {
      kind: 'operator-decision',
      permissions: basis.required,
      contentDigest: basis.contentDigest,
      dependencies: basis.dependencies,
    };
  } finally {
    rmSync(staged.tempDir, { recursive: true, force: true });
  }
}

async function install(
  root: string,
  source: string,
  extra: Record<string, unknown> = {},
) {
  const consent = await consentFor(source, root);
  return {
    consent,
    result: await installPluginFromSource(source, [], deps(root, extra), {
      consent,
    }),
  };
}

function recorded(root: string, name: string) {
  const state = readPluginTrustRecord(root, name);
  if (state.state !== 'recorded')
    throw new Error(`no trust record for ${name}: ${state.state}`);
  return state.record;
}

const installedDigest = (root: string, name: string) =>
  computePluginContentDigest(join(root, 'plugins'), name);

const manifest = (name: string, version = '1.0.0') => ({
  name,
  version,
  entrypoint: 'index.js',
});

// A verified identity as plugin-sigstore-verifier.ts returns it for the real
// uv release bundle (part 1's fixtures). The installer cannot be handed a
// real bundle for a fixture plugin's digest, so these tests drive the
// verifier interface; part 1 proves the real verifier.
const IDENTITY: SigstoreCertificateIdentity = {
  issuer: 'https://token.actions.githubusercontent.com',
  subjectAlternativeName:
    'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/heads/main',
  buildConfigUri:
    'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/heads/main',
  sourceRepositoryUri: 'https://github.com/astral-sh/uv',
  sourceRepositoryRef: 'refs/heads/main',
  repositoryId: '699532645',
  ownerId: '115962839',
  trigger: 'workflow_dispatch',
  runnerEnvironment: 'github-hosted',
};
const PIN: SigstoreSignerPin = {
  issuer: IDENTITY.issuer,
  repository: 'astral-sh/uv',
  repositoryId: IDENTITY.repositoryId,
  ownerId: IDENTITY.ownerId,
  workflowPath: '.github/workflows/release.yml',
  refPattern: 'refs/heads/main',
  trigger: 'workflow_dispatch',
  runnerEnvironment: 'github-hosted',
};

function signedPolicy(
  name: string,
  outcome: () => ReturnType<PluginSigstoreVerifier['verify']>,
  bundle: () => Uint8Array | null = () => Buffer.from('{"bundle":true}'),
) {
  const verify = vi.fn<PluginSigstoreVerifier['verify']>(() => outcome());
  const sigstoreBundle = vi.fn(async () => bundle());
  const policy: PluginInstallTrustPolicy = {
    pins: [PIN],
    lock: parsePluginsLock(
      { version: 1, plugins: [{ name, sigstoreIdentity: PIN }] },
      [PIN],
    ),
    verifier: { verify },
    sigstoreBundle,
  };
  return { policy, verify, sigstoreBundle };
}

const verified = () =>
  ({
    state: 'verified',
    identity: IDENTITY,
    signedAt: '2026-10-22T01:35:34.000Z',
  }) as const;

describe('install records a trust decision', () => {
  test('a new unsigned install records tier 3 against the installed digest', async () => {
    const root = await home();
    await install(root, writeSource(root, 'src', manifest('plain')));
    expect(recorded(root, 'plain')).toMatchObject({
      version: 1,
      signer: null,
      provenance: 'unsigned',
      tier: 3,
      decision: 'initial',
      decidedBy: 'station',
      contentDigest: installedDigest(root, 'plain'),
    });
  });

  test('a new kontour install records tier 2, verifying the consented source digest', async () => {
    const root = await home();
    const { policy, verify } = signedPolicy('signed', verified);
    const { consent } = await install(
      root,
      writeSource(root, 'src', manifest('signed')),
      { installTrust: policy },
    );
    expect(verify).toHaveBeenCalledWith({
      bundleBytes: expect.any(Uint8Array),
      artifactDigest: consent.contentDigest,
    });
    expect(recorded(root, 'signed')).toMatchObject({
      provenance: 'kontour',
      tier: 2,
      decision: 'initial',
      signer: {
        kind: 'sigstore',
        identity:
          'https://github.com/astral-sh/uv/.github/workflows/release.yml',
      },
    });
  });

  test('provenance comes from each install’s own verification, never the stored record', async () => {
    const root = await home();
    let bundle: Uint8Array | null = Buffer.from('{}');
    const { policy } = signedPolicy('signed', verified, () => bundle);
    await install(root, writeSource(root, 'src', manifest('signed')), {
      installTrust: policy,
    });
    expect(recorded(root, 'signed').provenance).toBe('kontour');

    // The same name, new bytes, delivered without a bundle: this install
    // verified nothing, so it is unsigned even though the stored record says
    // kontour, and the kontour tier does not carry over.
    bundle = null;
    await install(
      root,
      writeSource(
        root,
        'src',
        manifest('signed', '1.1.0'),
        'export const v = 2;',
      ),
      { installTrust: policy },
    );
    expect(recorded(root, 'signed')).toMatchObject({
      provenance: 'unsigned',
      signer: null,
      tier: 3,
      decision: 'new-decision',
      reason: 'signer-changed',
      priorTier: 2,
    });
  });

  test('a changed digest under the same pinned identity keeps tier 2', async () => {
    const root = await home();
    const { policy } = signedPolicy('signed', verified);
    await install(root, writeSource(root, 'src', manifest('signed')), {
      installTrust: policy,
    });
    await install(
      root,
      writeSource(
        root,
        'src',
        manifest('signed', '1.1.0'),
        'export const v = 2;',
      ),
      { installTrust: policy },
    );
    expect(recorded(root, 'signed')).toMatchObject({
      provenance: 'kontour',
      tier: 2,
      decision: 'inherited',
      contentDigest: installedDigest(root, 'signed'),
    });
  });

  test('a bundle that does not verify refuses the install and keeps the earlier record and bytes', async () => {
    const root = await home();
    const { policy } = signedPolicy('signed', verified);
    await install(root, writeSource(root, 'src', manifest('signed')), {
      installTrust: policy,
    });
    const before = readFileSync(pluginTrustRecordsPath(root), 'utf8');
    const digest = installedDigest(root, 'signed');
    const { policy: refusing } = signedPolicy('signed', () => ({
      state: 'refused',
      reason: 'missing-inclusion-proof',
    }));
    await expect(
      install(
        root,
        writeSource(
          root,
          'src',
          manifest('signed', '1.1.0'),
          'export const v = 2;',
        ),
        { installTrust: refusing },
      ),
    ).rejects.toBeInstanceOf(PluginInstallTrustRefused);
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe(before);
    expect(installedDigest(root, 'signed')).toBe(digest);
  });

  test('an unreadable trust store refuses the install before any effect', async () => {
    const root = await home();
    writeFileSync(pluginTrustRecordsPath(root), '{not json');
    await expect(
      install(root, writeSource(root, 'src', manifest('plain'))),
    ).rejects.toBeInstanceOf(PluginTrustRecordsUnavailableError);
    expect(installedDigest(root, 'plain')).toBeNull();
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe(
      '{not json',
    );
  });
});

describe('migration from pre-d1 state', () => {
  async function preD1Home() {
    const root = await home();
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    // A legacy-path plugin as a pre-d1 install left it: its tree under
    // plugins/ and a grant bound to its content by the grants writer.
    cpSync(
      writeSource(root, 'legacy-src', {
        ...manifest('legacy-local'),
        permissions: ['network.fetch'],
      }),
      join(pluginsDir, 'legacy-local'),
      { recursive: true },
    );
    await grantPermissions(root, 'legacy-local', ['network.fetch']);
    // A grant recorded before content binding (archive#4288): string[].
    cpSync(
      writeSource(root, 'older-src', manifest('legacy-older')),
      join(pluginsDir, 'legacy-older'),
      { recursive: true },
    );
    const grantsPath = join(root, 'plugin-grants.json');
    const grants = JSON.parse(readFileSync(grantsPath, 'utf8'));
    grants['legacy-older'] = ['network.fetch'];
    writeFileSync(grantsPath, JSON.stringify(grants, null, 2));
    // An agent plugin through the local installation service, the journal
    // writer a pre-d1 managed install called.
    const store = new EventStore(join(root, 'events.sqlite'));
    stores.push(store);
    const journal = store.createPackageMcpAdmissionJournal();
    const agentSource = join(root, 'agent-src');
    mkdirSync(join(agentSource, 'skills', 'review'), { recursive: true });
    writeFileSync(
      join(agentSource, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'acme.tools',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      join(agentSource, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review.\n---\nReview.\n',
    );
    await createLocalPluginInstallationService(
      pluginsDir,
      journal,
      agentSource,
    ).install({
      installation: 'acme.tools',
      expected: null,
      artifact: {
        digest: computePluginContentDigest(root, 'agent-src')!,
      },
      origin: 'a'.repeat(64),
    });
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
    expect(journal.installTrustMigration!()).toEqual({ state: 'none' });
    return { root, journal, witness: pluginTrustMigrationWitness(journal)! };
  }

  const migrate = (
    root: string,
    journal: ReturnType<EventStore['createPackageMcpAdmissionJournal']>,
    log = logger(),
  ) =>
    migratePluginInstallTrustAtStartup({
      projectHomeDir: root,
      packageMcpJournal: journal,
      logger: log,
      now: () => new Date('2026-10-25T00:00:00.000Z'),
    });

  test('every pre-d1 plugin is grandfathered at tier 2 with its current digest; grants are untouched', async () => {
    const { root, journal } = await preD1Home();
    const grantsBefore = readFileSync(join(root, 'plugin-grants.json'), 'utf8');
    await migratePluginInstallTrustAtStartup({
      projectHomeDir: root,
      packageMcpJournal: journal,
      logger: logger(),
      now: () => new Date('2026-10-25T00:00:00.000Z'),
    });
    for (const name of ['legacy-local', 'legacy-older', 'acme.tools']) {
      expect(recorded(root, name), name).toEqual({
        version: 1,
        signer: null,
        provenance: 'unsigned',
        contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        tier: 2,
        decision: 'grandfathered',
        decidedBy: 'station',
        decidedAt: '2026-10-25T00:00:00.000Z',
      });
    }
    expect(recorded(root, 'legacy-local').contentDigest).toBe(
      installedDigest(root, 'legacy-local'),
    );
    expect(readFileSync(join(root, 'plugin-grants.json'), 'utf8')).toBe(
      grantsBefore,
    );
    expect(getPluginGrants(root, 'legacy-local')).toEqual(['network.fetch']);
    expect(getPluginGrants(root, 'legacy-older')).toEqual(['network.fetch']);
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
  });

  test('deleting the trust file after the migration grandfathers nothing; records become unavailable', async () => {
    const { root, journal, witness } = await preD1Home();
    await migrate(root, journal);
    await install(root, writeSource(root, 'new-src', manifest('post-d1')), {
      packageMcpJournal: journal,
    });
    expect(recorded(root, 'post-d1').tier).toBe(3);
    for (const suffix of ['', '.previous'])
      rmSync(`${pluginTrustRecordsPath(root)}${suffix}`, { force: true });
    const log = logger();
    await migrate(root, journal, log);
    expect(log.error).toHaveBeenCalled();
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
    expect(() => readPluginTrustRecord(root, 'post-d1', witness)).toThrow(
      PluginTrustRecordsUnavailableError,
    );
    // An install refuses rather than starting a fresh, empty store.
    await expect(
      install(root, writeSource(root, 'other-src', manifest('another')), {
        packageMcpJournal: journal,
      }),
    ).rejects.toBeInstanceOf(PluginTrustRecordsUnavailableError);
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
  });

  test('removing only the migration marker after the migration grandfathers nothing', async () => {
    const { root, journal, witness } = await preD1Home();
    await migrate(root, journal);
    await install(root, writeSource(root, 'new-src', manifest('post-d1')), {
      packageMcpJournal: journal,
    });
    const file = JSON.parse(readFileSync(pluginTrustRecordsPath(root), 'utf8'));
    delete file['post-d1'];
    delete file.$migration;
    writeFileSync(pluginTrustRecordsPath(root), JSON.stringify(file));
    await migrate(root, journal);
    expect(() => readPluginTrustRecord(root, 'post-d1', witness)).toThrow(
      PluginTrustRecordsUnavailableError,
    );
    expect(
      JSON.parse(readFileSync(pluginTrustRecordsPath(root), 'utf8'))['post-d1'],
    ).toBeUndefined();
  });

  test('bytes unreadable at the freeze are never grandfathered, even once readable and changed', async () => {
    const { root, journal, witness } = await preD1Home();
    const legacy = join(root, 'plugins', 'legacy-local');
    const { chmodSync } = await import('node:fs');
    chmodSync(legacy, 0o000);
    try {
      await migrate(root, journal);
    } finally {
      chmodSync(legacy, 0o755);
    }
    expect(recorded(root, 'acme.tools').decision).toBe('grandfathered');
    expect(readPluginTrustRecord(root, 'legacy-local', witness)).toEqual({
      state: 'unrecorded',
    });
    // The reviewer's probe: restore access, rewrite the plugin, migrate again.
    writeFileSync(join(legacy, 'index.js'), 'export const swapped = true;');
    await migrate(root, journal);
    expect(readPluginTrustRecord(root, 'legacy-local', witness)).toEqual({
      state: 'unrecorded',
    });
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
  });

  test('a manifest-name mismatch or bytes that disagree with the journal are unrecorded, not grandfathered', async () => {
    const { root, journal, witness } = await preD1Home();
    writeFileSync(
      join(root, 'plugins', 'legacy-older', 'plugin.json'),
      JSON.stringify(manifest('someone-else')),
    );
    const agentRoot = captureLocalPluginInstallation(
      join(root, 'plugins'),
      journal,
      'acme.tools',
    )!.root.packageRoot;
    writeFileSync(join(agentRoot, 'skills', 'review', 'SKILL.md'), 'changed');
    await migrate(root, journal);
    expect(readPluginTrustRecord(root, 'legacy-older', witness)).toEqual({
      state: 'unrecorded',
    });
    expect(readPluginTrustRecord(root, 'acme.tools', witness)).toEqual({
      state: 'unrecorded',
    });
    expect(recorded(root, 'legacy-local').decision).toBe('grandfathered');
  });

  test('the migration runs once: a plugin placed by hand afterwards is unrecorded, not grandfathered', async () => {
    const { root, journal } = await preD1Home();
    const run = () =>
      migratePluginInstallTrustAtStartup({
        projectHomeDir: root,
        packageMcpJournal: journal,
        logger: logger(),
      });
    await run();
    const after = readFileSync(pluginTrustRecordsPath(root), 'utf8');
    cpSync(join(root, 'legacy-src'), join(root, 'plugins', 'dropped'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'plugins', 'dropped', 'plugin.json'),
      JSON.stringify(manifest('dropped')),
    );
    await run();
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe(after);
    expect(readPluginTrustRecord(root, 'dropped')).toEqual({
      state: 'unrecorded',
    });
  });

  test('an install before the start-time migration ran migrates first, so an update is decided against the grandfathered tier', async () => {
    const { root, journal } = await preD1Home();
    // Same bytes: the grandfathered decision stands.
    await install(root, join(root, 'legacy-src'), {
      packageMcpJournal: journal,
    });
    expect(recorded(root, 'legacy-local')).toMatchObject({
      decision: 'grandfathered',
      tier: 2,
    });
    // New bytes, unsigned: a new decision, with the tier it replaced kept.
    await install(
      root,
      writeSource(
        root,
        'legacy-src',
        {
          ...manifest('legacy-local', '1.1.0'),
          permissions: ['network.fetch'],
        },
        'export const v = 2;',
      ),
      { packageMcpJournal: journal },
    );
    expect(recorded(root, 'legacy-local')).toMatchObject({
      decision: 'new-decision',
      reason: 'unsigned-content-changed',
      tier: 3,
      priorTier: 2,
    });
    // The other pre-d1 plugin was grandfathered by that same first install.
    expect(recorded(root, 'acme.tools').decision).toBe('grandfathered');
  });

  test('a corrupt trust store never reads as empty and is not overwritten by the migration', async () => {
    const { root, journal } = await preD1Home();
    writeFileSync(pluginTrustRecordsPath(root), '[]');
    const log = logger();
    await migratePluginInstallTrustAtStartup({
      projectHomeDir: root,
      packageMcpJournal: journal,
      logger: log,
    });
    expect(log.error).toHaveBeenCalled();
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe('[]');
    expect(() => readPluginTrustRecord(root, 'legacy-local')).toThrow(
      PluginTrustRecordsUnavailableError,
    );
  });
});

describe('records across reinstall, rollback and dependency paths', () => {
  test('a reinstall after uninstall never keeps a tier above its own provenance', async () => {
    const root = await home();
    const { policy } = signedPolicy('signed', verified);
    const source = writeSource(root, 'src', manifest('signed'));
    await install(root, source, { installTrust: policy });
    expect(recorded(root, 'signed')).toMatchObject({ tier: 2 });
    await uninstallInstalledPlugin('signed', deps(root));
    // Same bundle and bytes, but Station no longer pins the identity.
    await install(root, source, {
      installTrust: { ...policy, pins: [], lock: new Map() },
    });
    expect(recorded(root, 'signed')).toMatchObject({
      provenance: 'publisher',
      tier: 3,
      decision: 'new-decision',
      reason: 'tier-exceeds-provenance',
      priorTier: 2,
    });
  });

  test('a tree placed by hand after uninstall does not stand in for the installation the record described', async () => {
    const root = await home();
    await install(root, writeSource(root, 'src', manifest('plain')));
    // Grandfather-like starting point: a tier-2 record for these bytes.
    const original = join(root, 'src');
    const { policy } = signedPolicy('plain', verified);
    await install(root, original, { installTrust: policy });
    expect(recorded(root, 'plain').tier).toBe(2);
    await uninstallInstalledPlugin('plain', deps(root));
    // The reviewer's probe: any tree at plugins/plain, then the original
    // bytes again, now without the pinned identity.
    cpSync(
      writeSource(root, 'other-src', manifest('plain'), 'export const x = 1;'),
      join(root, 'plugins', 'plain'),
      { recursive: true },
    );
    await install(root, original, {
      installTrust: { ...policy, pins: [], lock: new Map() },
    });
    expect(recorded(root, 'plain')).toMatchObject({
      tier: 3,
      decision: 'new-decision',
      reason: 'tier-exceeds-provenance',
      priorTier: 2,
    });
  });

  test("a second install of the name cannot interleave between another install's trust read and its record write", async () => {
    const root = await home();
    const signed = signedPolicy('signed', verified);
    const v1 = writeSource(root, 'v1-src', manifest('signed'));
    await install(root, v1, { installTrust: signed.policy });
    const before = readFileSync(pluginTrustRecordsPath(root), 'utf8');
    const v2 = writeSource(
      root,
      'v2-src',
      manifest('signed', '2.0.0'),
      'export const v = 2;',
    );
    // C has read the tier-2 record and holds before the content lock.
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    prepareGate.hold = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const c = install(root, v1, { installTrust: signed.policy });
    await atGate;
    // B is refused while C holds the installation's locks, so it cannot
    // write a decision C's earlier read would then overwrite.
    await expect(
      install(root, v2, {
        installTrust: signedPolicy('signed', verified, () => null).policy,
      }),
    ).rejects.toThrow(/lock/);
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe(before);
    release();
    await c;
    // Same bytes and signer: the earlier decision stands as it was.
    expect(recorded(root, 'signed')).toMatchObject({
      decision: 'initial',
      tier: 2,
      contentDigest: installedDigest(root, 'signed'),
    });
  });

  test('a same-bytes reinstall keeps a pending new decision, its reason and prior tier', async () => {
    const root = await home();
    let bundle: Uint8Array | null = Buffer.from('{}');
    const { policy } = signedPolicy('signed', verified, () => bundle);
    await install(root, writeSource(root, 'src', manifest('signed')), {
      installTrust: policy,
    });
    bundle = null;
    const unsigned = writeSource(
      root,
      'src',
      manifest('signed', '1.1.0'),
      'export const v = 2;',
    );
    await install(root, unsigned, { installTrust: policy });
    const pending = recorded(root, 'signed');
    expect(pending).toMatchObject({
      decision: 'new-decision',
      reason: 'signer-changed',
      priorTier: 2,
      tier: 3,
    });
    await install(root, unsigned, { installTrust: policy });
    expect(recorded(root, 'signed')).toEqual(pending);
  });

  test('a failed record write rolls the install back: no tree, no grant, no record', async () => {
    const root = await home();
    failTrustWrite.next = true;
    await expect(
      install(
        root,
        writeSource(root, 'src', {
          ...manifest('plain'),
          permissions: ['network.fetch'],
        }),
      ),
    ).rejects.toThrow('injected trust record write failure');
    expect(installedDigest(root, 'plain')).toBeNull();
    expect(getPluginGrants(root, 'plain')).toEqual([]);
    expect(readPluginTrustRecord(root, 'plain').state).not.toBe('recorded');
  });

  test('a failed record write on an update restores the earlier bytes and record', async () => {
    const root = await home();
    await install(root, writeSource(root, 'src', manifest('plain')));
    const digest = installedDigest(root, 'plain');
    const before = readFileSync(pluginTrustRecordsPath(root), 'utf8');
    failTrustWrite.next = true;
    await expect(
      install(
        root,
        writeSource(
          root,
          'src',
          manifest('plain', '2.0.0'),
          'export const v = 2;',
        ),
      ),
    ).rejects.toThrow('injected trust record write failure');
    expect(installedDigest(root, 'plain')).toBe(digest);
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe(before);
  });

  test('a Station-format dependency installed by a parent is unrecorded, and a rebuild in place makes a record stale', async () => {
    const root = await home();
    // No entrypoint: a dependency with no executable contribution.
    const dependency = writeSource(root, 'dep-src', {
      name: 'dep',
      version: '1.0.0',
    });
    const parent = writeSource(root, 'parent-src', {
      ...manifest('parent'),
      dependencies: [{ id: 'dep', source: dependency }],
    });
    await install(root, parent);
    expect(recorded(root, 'parent').decision).toBe('initial');
    // The dependency branch copies the tree itself and writes no record.
    expect(readPluginTrustRecord(root, 'dep')).toEqual({ state: 'unrecorded' });

    // Installed directly (with an entrypoint), the dependency gets a record.
    // A later parent's dependency pass rebuilds it in place, changing its
    // bytes outside the installer.
    const built = writeSource(root, 'dep-built-src', manifest('dep-built'));
    await install(root, built);
    const rebuildState = () =>
      pluginTrustForInstalledBytes(
        readPluginTrustRecord(root, 'dep-built'),
        installedDigest(root, 'dep-built'),
      );
    expect(rebuildState().state).toBe('recorded');
    const rebuild = vi.fn(async (pluginDir: string) => {
      mkdirSync(join(pluginDir, 'dist'), { recursive: true });
      writeFileSync(join(pluginDir, 'dist', 'bundle.js'), 'rebuilt');
    });
    const result = await installPluginDependency(
      { id: 'dep-built' },
      join(root, 'plugins'),
      () => ({}) as never,
      rebuild,
      logger(),
    );
    expect(result).toEqual({ success: true });
    expect(rebuild).toHaveBeenCalled();
    expect(rebuildState()).toMatchObject({ state: 'stale' });
  });

  test('the raw registry copy freezes the migration first, so its tree is never grandfathered', async () => {
    const root = await home();
    const store = new EventStore(join(root, 'events.sqlite'));
    stores.push(store);
    const journal = store.createPackageMcpAdmissionJournal();
    const witness = pluginTrustMigrationWitness(journal)!;
    const source = writeSource(root, 'raw-src', manifest('raw-agent'));
    const install = vi.fn(async () => {
      cpSync(source, join(root, 'plugins', 'raw-agent'), { recursive: true });
      return { success: true };
    });
    agentRegistry.provider = { listAvailable: async () => [], install };
    const app = withOperatorPrincipal(
      createRegistryRoutes(
        new ConfigLoader({ projectHomeDir: root }),
        async () => {},
        undefined,
        undefined,
        { logger: logger(), packageMcpJournal: journal },
      ),
    );
    const response = await app.request('/agents/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'raw-agent' }),
    });
    expect(response.status, await response.text()).toBe(200);
    expect(install).toHaveBeenCalled();
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
    await migratePluginInstallTrustAtStartup({
      projectHomeDir: root,
      packageMcpJournal: journal,
      logger: logger(),
    });
    expect(readPluginTrustRecord(root, 'raw-agent', witness)).toEqual({
      state: 'unrecorded',
    });

    // And with the trust store unreadable, the raw copy is refused.
    writeFileSync(pluginTrustRecordsPath(root), '{not json');
    install.mockClear();
    const refused = await app.request('/agents/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'raw-agent' }),
    });
    expect(refused.status).toBe(503);
    expect(install).not.toHaveBeenCalled();
  });
});

describe('install route answers trust refusals as closed outcomes', () => {
  async function post(root: string, source: string, extra = {}) {
    const consent = await consentFor(source, root);
    const app = new Hono();
    bindOperatorPrincipal(app);
    registerPluginInstallRoutes(app, {
      ...deps(root),
      projectVisiblePlugins: () => (installed: readonly string[]) => installed,
      ...extra,
    } as any);
    const response = await app.request('/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        consent: {
          permissions: consent.permissions,
          contentDigest: consent.contentDigest,
          dependencies: consent.dependencies,
        },
      }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  test('a refused bundle is 409 with its reason and nothing is installed', async () => {
    const root = await home();
    const { policy } = signedPolicy('signed', () => ({
      state: 'refused',
      reason: 'timestamp-outside-certificate-window',
    }));
    const { status, body } = await post(
      root,
      writeSource(root, 'src', manifest('signed')),
      { installTrust: policy },
    );
    expect({ status, body }).toMatchObject({
      status: 409,
      body: {
        success: false,
        code: 'plugin-install-trust-refused',
        reason: 'timestamp-outside-certificate-window',
      },
    });
    expect(installedDigest(root, 'signed')).toBeNull();
  });

  test('an install over a record a newer build wrote is 409, and neither the record nor the bytes change', async () => {
    const root = await home();
    const { policy } = signedPolicy('signed', verified);
    await install(root, writeSource(root, 'src', manifest('signed')), {
      installTrust: policy,
    });
    // A newer Station lowered this pinned plugin to tier 3 in a record shape
    // this build cannot read. Reinstalling here would record tier 2 again.
    const file = JSON.parse(readFileSync(pluginTrustRecordsPath(root), 'utf8'));
    file.signed = {
      ...file.signed,
      version: 2,
      tier: 3,
      decision: 'a-newer-kind',
    };
    writeFileSync(pluginTrustRecordsPath(root), JSON.stringify(file));
    const before = readFileSync(pluginTrustRecordsPath(root), 'utf8');
    const digest = installedDigest(root, 'signed');
    const { status, body } = await post(
      root,
      writeSource(
        root,
        'src2',
        manifest('signed', '1.1.0'),
        'export const v = 2;',
      ),
      { installTrust: policy },
    );
    expect({ status, body }).toMatchObject({
      status: 409,
      body: { success: false, code: 'plugin-trust-record-newer' },
    });
    expect(readFileSync(pluginTrustRecordsPath(root), 'utf8')).toBe(before);
    expect(installedDigest(root, 'signed')).toBe(digest);
  });

  test('an unreadable trust store is 503, not a generic failure', async () => {
    const root = await home();
    writeFileSync(pluginTrustRecordsPath(root), '{not json');
    const { status, body } = await post(
      root,
      writeSource(root, 'src', manifest('plain')),
    );
    expect({ status, body }).toMatchObject({
      status: 503,
      body: { success: false, code: 'plugin-trust-records-unavailable' },
    });
    expect(body.error).not.toContain(root);
  });
});
