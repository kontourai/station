/**
 * Persisted install trust records through the real installer and the real
 * start-time migration (#2998, d1 part 2).
 *
 * Pre-d1 state is produced by today's writers: a real install through
 * `installPluginFromSource` writes the plugin tree, `plugin-grants.json` and,
 * for an agent plugin, the EventStore journal; deleting `plugin-trust.json`
 * then leaves exactly what a pre-d1 Station has on disk. The legacy
 * `string[]` grants entry is written in the shape the pre-archive#4288 writer
 * produced.
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { EventStore } from '../../orchestration/event-store.js';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import {
  derivePluginConsentBasis,
  type PluginInstallConsent,
} from '../plugin-install-consent.js';
import { installPluginFromSource } from '../plugin-install-transaction.js';
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
  pluginTrustRecordsPath,
  readPluginTrustRecord,
} from '../plugin-install-trust-store.js';
import { readPluginManifestFile } from '../plugin-manifest-loader.js';
import { getPluginGrants } from '../plugin-permissions.js';
import type {
  PluginSigstoreVerifier,
  SigstoreCertificateIdentity,
} from '../plugin-sigstore-verifier.js';
import { fetchPluginSource } from '../plugin-source.js';

vi.mock('../../../providers/registries/registry.js', () => ({
  getAgentRegistryProvider: vi.fn().mockReturnValue({
    listAvailable: vi.fn().mockResolvedValue([]),
  }),
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
    // A legacy-path install with a bound grant, written by today's installer.
    await install(
      root,
      writeSource(root, 'legacy-src', {
        ...manifest('legacy-local'),
        permissions: ['network.fetch'],
      }),
    );
    // An agent plugin through the EventStore journal, today's managed path.
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
    await installPluginFromSource(agentSource, [], {
      ...deps(root),
      packageMcpJournal: journal,
    });
    // A grant recorded before content binding (archive#4288): string[].
    const grantsPath = join(root, 'plugin-grants.json');
    const grants = JSON.parse(readFileSync(grantsPath, 'utf8'));
    grants['legacy-local'] = ['network.fetch'];
    writeFileSync(grantsPath, JSON.stringify(grants, null, 2));
    // Pre-d1 Stations have no trust store at all.
    for (const suffix of ['', '.previous', '.mutation'])
      rmSync(`${pluginTrustRecordsPath(root)}${suffix}`, { force: true });
    return { root, journal };
  }

  test('every pre-d1 plugin is grandfathered at tier 2 with its current digest; grants are untouched', async () => {
    const { root, journal } = await preD1Home();
    const grantsBefore = readFileSync(join(root, 'plugin-grants.json'), 'utf8');
    await migratePluginInstallTrustAtStartup({
      projectHomeDir: root,
      packageMcpJournal: journal,
      logger: logger(),
      now: () => new Date('2026-10-25T00:00:00.000Z'),
    });
    for (const name of ['legacy-local', 'acme.tools']) {
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
