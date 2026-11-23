import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { ENSEMBLE_PRESET_VERSION } from '@kontourai/station-contracts/ensemble';
import {
  EXECUTION_ENGINE_CHANGED_CODE,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import { GateTestAdapter } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type EnsemblePreparationHost,
  loadEnsemblePreset,
  type PrepareEnsembleInput,
  prepareEnsemble,
} from '../ensemble-presets.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const tempDir = trackTempDirs();
const openFixture = (path: string) => loadEnsemblePreset(path, () => true);
const hash = (json: string) =>
  `sha256:${createHash('sha256').update(json).digest('hex')}`;

async function setup() {
  const directory = await realpath(tempDir('station-ensemble-'));
  const path = join(directory, 'team.json');
  const preset = {
    version: ENSEMBLE_PRESET_VERSION,
    id: 'team',
    name: 'Team',
    stationmaster: 'lead',
    members: [
      {
        id: 'lead',
        codename: 'Rune',
        color: '#123ABC',
        role: 'coordinate',
        engine: 'claude',
        model: 'local-model-one',
        reasoning: null,
        options: {},
        promptAppends: ['  Plan\r\n', '', '🙂'],
      },
      {
        id: 'review',
        codename: 'Flux',
        color: '#987def',
        role: 'review',
        engine: 'claude',
        model: 'local-model-two',
        reasoning: null,
        options: {},
        promptAppends: ['Review independently.'],
      },
    ],
  };
  const json = `${JSON.stringify(preset, null, 2)}\n`;
  await writeFile(path, json);

  const engine = {
    kind: 'connection' as const,
    connectionId: engineConnectionId('claude-local'),
  };
  const input: PrepareEnsembleInput = {
    path,
    expectedPresetHash: hash(json),
    contextKey: 'bound-owner',
    brief: '  Task\r\n',
    bindings: {
      lead: {
        environment: { kind: 'current' },
        agent: agentId('coordinator'),
        expectedEngine: engine,
      },
      review: {
        environment: { kind: 'current' },
        agent: agentId('reviewer'),
        expectedEngine: engine,
      },
    },
  };
  const connection: ConnectionConfig = {
    id: 'claude-local',
    name: 'Claude',
    kind: 'agent',
    type: 'claude',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: { provider: 'claude' },
    prerequisites: [],
  };
  const adapter = new GateTestAdapter();
  const engineMetadata = Object.assign(adapter, {
    metadata: {
      ...adapter.metadata,
      modelLaunch: {
        defaultAtStart: 'engine-selected' as const,
        omissionAtResume: 'engine-selected' as const,
        omissionPerTurn: 'engine-selected' as const,
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      },
    },
  });
  let active = true;
  const getAgent = vi.fn<EnsemblePreparationHost['inventory']['getAgent']>(
    async (_access, id) => ({
      slug: id,
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude-local') },
    }),
  );
  const getConnection = vi.fn(async () => connection);
  const host: EnsemblePreparationHost = {
    inventory: {
      resolveEnvironmentAccess: vi.fn(async () => ({
        apiBase: 'http://127.0.0.1:43141',
        environmentId: 'ensemble-home',
        environmentName: 'Test home',
        kind: 'current' as const,
        requestOptions: {
          headers: { 'x-fixture-internal': 'host-only-value' },
        },
      })),
      getAgent,
      getConnection,
      getProject: async () => undefined,
      getProviderAdapter: () => engineMetadata,
    },
    isCurrent: (binding) =>
      active && binding.contextKey === 'bound-owner' && binding.path === path,
  };
  return {
    directory,
    path,
    preset,
    json,
    input,
    host,
    getAgent,
    getConnection,
    revoke: () => {
      active = false;
    },
  };
}

describe('Ensemble file preparation', () => {
  test.each([
    'symlink-left',
    'restored-before-validation',
    'replacement-directory',
  ])('refuses ancestor substitution at open: %s', async (race) => {
    const fixture = await setup();
    const directory = join(fixture.directory, 'selected');
    const saved = join(fixture.directory, 'saved');
    const peer = join(fixture.directory, 'peer');
    await mkdir(directory);
    await mkdir(peer);
    const path = join(directory, 'team.json');
    const peerJson = fixture.json.replace('"name": "Team"', '"name": "Peer"');
    await writeFile(path, fixture.json);
    if (race === 'replacement-directory')
      await link(path, join(peer, 'team.json'));
    else await writeFile(join(peer, 'team.json'), peerJson);
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let injected = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] !== path || injected) return actual.open(...args);
      injected = true;
      await rename(directory, saved);
      if (race === 'replacement-directory') await rename(peer, directory);
      else await symlink(peer, directory);
      const file = await actual.open(...args);
      if (race === 'restored-before-validation') {
        await unlink(directory);
        await rename(saved, directory);
      }
      return file;
    });
    try {
      await expect(openFixture(path)).rejects.toThrow(
        'preset file identity changed',
      );
      expect(injected).toBe(true);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
    }
  });

  test('refuses bytes rewritten while the opened file is being read', async () => {
    const fixture = await setup();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let injected = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      if (args[0] === fixture.path) {
        const read = file.read.bind(file);
        vi.spyOn(file, 'read').mockImplementationOnce(async (...readArgs) => {
          injected = true;
          await writeFile(
            fixture.path,
            fixture.json.replace('"name": "Team"', '"name": "Peer"'),
          );
          return read(...readArgs);
        });
      }
      return file;
    });
    try {
      await expect(openFixture(fixture.path)).rejects.toThrow(
        'preset file identity changed',
      );
      expect(injected).toBe(true);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
    }
  });

  test('requires exact canonical file paths, regular UTF-8 JSON and supported versions', async () => {
    const fixture = await setup();
    await expect(openFixture('team.json')).rejects.toThrow(
      'explicit canonical',
    );
    const alias = join(fixture.directory, 'alias.json');
    await symlink(fixture.path, alias);
    const directoryAlias = join(fixture.directory, 'directory-alias');
    await symlink(fixture.directory, directoryAlias);
    await expect(
      openFixture(join(directoryAlias, 'team.json')),
    ).rejects.toThrow('explicit canonical');
    await expect(openFixture(alias)).rejects.toThrow('explicit canonical');
    await expect(
      openFixture(join(fixture.directory, 'missing.json')),
    ).rejects.toThrow();
    await writeFile(fixture.path, Buffer.from([0x22, 0xff, 0x22]));
    await expect(openFixture(fixture.path)).rejects.toThrow('UTF-8');
    await writeFile(
      fixture.path,
      fixture.json.replace(ENSEMBLE_PRESET_VERSION, 'station.ensemble/v2'),
    );
    await expect(openFixture(fixture.path)).rejects.toThrow(
      'unsupported version',
    );
    await writeFile(fixture.path, ' '.repeat(128 * 1024 + 1));
    await expect(openFixture(fixture.path)).rejects.toThrow(
      'invalid preset file',
    );
  });

  test('refuses an identical file placed at the selected name while the descriptor closes', async () => {
    const fixture = await setup();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const replacement = join(fixture.directory, 'replacement.json');
    await writeFile(replacement, fixture.json);
    let changed = false;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementationOnce(async () => {
        await close();
        await rename(replacement, fixture.path);
        changed = true;
      });
      return file;
    });
    await expect(openFixture(fixture.path)).rejects.toThrow(
      'preset file identity changed',
    );
    expect(changed).toBe(true);
  });

  test('rejects a wrong caller binding before opening the preset', async () => {
    const fixture = await setup();
    vi.mocked(open).mockClear();
    await expect(
      prepareEnsemble(
        { ...fixture.input, contextKey: 'unbound-owner' },
        fixture.host,
      ),
    ).rejects.toThrow('current caller binding required');
    expect(open).not.toHaveBeenCalled();
    expect(fixture.getAgent).not.toHaveBeenCalled();
  });

  test('withdrawal after opening prevents reading file bytes', async () => {
    const fixture = await setup();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const read = vi.fn();
    vi.mocked(open)
      .mockClear()
      .mockImplementationOnce(async (...args) => {
        const file = await actual.open(...args);
        const actualRead = file.read.bind(file);
        vi.spyOn(file, 'read').mockImplementation((...parameters) => {
          read();
          return actualRead(...parameters);
        });
        fixture.revoke();
        return file;
      });
    await expect(prepareEnsemble(fixture.input, fixture.host)).rejects.toThrow(
      'current caller binding required',
    );
    expect(open).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  test('assembles frozen exact inventory observations and the current member briefs', async () => {
    const fixture = await setup();
    const file = await openFixture(fixture.path);
    expect(file.json).toBe(fixture.json);
    expect(file.sha256).toBe(fixture.input.expectedPresetHash);
    expect(() => file.assertCurrent()).not.toThrow();

    const plan = await prepareEnsemble(fixture.input, fixture.host);
    expect(plan.source.sha256).toBe(file.sha256);
    expect(plan.stationmaster).toBe('lead');
    expect(
      plan.members.map((member) => [
        member.member.id,
        member.target.model,
        member.resolution.agentId,
        member.resolution.engine,
        member.resolution.provider,
      ]),
    ).toEqual([
      [
        'lead',
        { override: 'local-model-one' },
        'coordinator',
        { kind: 'connection', connectionId: 'claude-local' },
        'claude',
      ],
      [
        'review',
        { override: 'local-model-two' },
        'reviewer',
        { kind: 'connection', connectionId: 'claude-local' },
        'claude',
      ],
    ]);
    expect(plan.members[0].brief).toBe(
      `  Task\r\n\n\n  Plan\r\n\n\n\n\n🙂\n\nYour Ensemble member assignment:\n{"id":"lead","codename":"Rune","role":"coordinate","stationmaster":true}\n\n${plan.roster}`,
    );
    expect(plan.members[1].brief).toBe(
      `  Task\r\n\n\nReview independently.\n\nYour Ensemble member assignment:\n{"id":"review","codename":"Flux","role":"review","stationmaster":false}\n\n${plan.roster}`,
    );
    expect(JSON.stringify(plan)).not.toContain('host-only-value');
    expect(() =>
      Object.assign(plan.members[0].target.model!, { override: 'other' }),
    ).toThrow();
    expect(() =>
      Object.assign(plan.members[0].resolution.engine, { kind: 'station' }),
    ).toThrow();
  });

  test('rejects stale bytes and missing or remote targets before inspecting inventory', async () => {
    const fixture = await setup();
    await expect(
      prepareEnsemble(
        { ...fixture.input, bindings: { lead: fixture.input.bindings.lead } },
        fixture.host,
      ),
    ).rejects.toThrow('exact host binding');
    await expect(
      prepareEnsemble(
        {
          ...fixture.input,
          bindings: {
            ...fixture.input.bindings,
            review: {
              ...fixture.input.bindings.review,
              environment: { kind: 'saved', id: environmentId('not-local') },
            },
          },
        },
        fixture.host,
      ),
    ).rejects.toThrow('exact local host binding');
    await writeFile(fixture.path, `${fixture.json}\n`);
    await expect(prepareEnsemble(fixture.input, fixture.host)).rejects.toThrow(
      'stale preset bytes',
    );
    expect(fixture.getAgent).not.toHaveBeenCalled();
  });

  test('refuses options that would need catalog qualification before inventory', async () => {
    const f = await setup();
    const preset = {
      ...f.preset,
      members: f.preset.members.map((member) =>
        member.id === 'review'
          ? { ...member, options: { fastMode: false } }
          : member,
      ),
    };
    const json = JSON.stringify(preset);
    await writeFile(f.path, json);
    await expect(
      prepareEnsemble({ ...f.input, expectedPresetHash: hash(json) }, f.host),
    ).rejects.toThrow('model option values require catalog validation');
    expect(f.getAgent).not.toHaveBeenCalled();
  });

  test.each(['withdrawal', 'same-bytes replacement'] as const)(
    'stops before the next inventory read after %s',
    async (change) => {
      const fixture = await setup();
      const original = fixture.getAgent.getMockImplementation()!;
      fixture.getAgent.mockImplementationOnce(async (access, id) => {
        if (change === 'withdrawal') fixture.revoke();
        else {
          const replacement = join(fixture.directory, 'replacement.json');
          await writeFile(replacement, fixture.json);
          await rename(replacement, fixture.path);
        }
        return original(access, id);
      });
      await expect(
        prepareEnsemble(fixture.input, fixture.host),
      ).rejects.toThrow(
        change === 'withdrawal'
          ? 'current caller binding required'
          : 'preset file identity changed',
      );
      expect(fixture.getAgent).toHaveBeenCalledOnce();
      expect(fixture.getConnection).not.toHaveBeenCalled();
    },
  );

  test('inventory awaits cannot replace the input context, binding or caller brief', async () => {
    const fixture = await setup();
    const original = fixture.getAgent.getMockImplementation()!;
    fixture.getAgent.mockImplementationOnce(async (access, id) => {
      Object.assign(fixture.input, {
        contextKey: 'other-owner',
        brief: 'other brief',
      });
      Object.assign(fixture.input.bindings.review, {
        agent: agentId('other-reviewer'),
      });
      return original(access, id);
    });
    const plan = await prepareEnsemble(fixture.input, fixture.host);
    expect(plan.contextKey).toBe('bound-owner');
    expect(plan.members[1].resolution.agentId).toBe('reviewer');
    expect(plan.members[1].brief.startsWith('  Task\r\n')).toBe(true);
    expect(plan.members[1].brief).not.toContain('other brief');
  });

  test('refuses a resolver binding changed from the named Engine', async () => {
    const fixture = await setup();
    fixture.getAgent.mockResolvedValueOnce({
      slug: agentId('coordinator'),
      available: true,
      execution: { agentConnectionId: engineConnectionId('another-engine') },
    });
    await expect(
      prepareEnsemble(fixture.input, fixture.host),
    ).rejects.toMatchObject({
      code: EXECUTION_ENGINE_CHANGED_CODE,
    });
    expect(fixture.getConnection).not.toHaveBeenCalled();
  });
});
