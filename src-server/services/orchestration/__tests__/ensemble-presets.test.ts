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
import {
  ENSEMBLE_PRESET_VERSION,
  parseEnsemblePreset,
} from '@kontourai/station-contracts/ensemble';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import { CodexAdapter } from '../../../providers/adapters/codex-adapter.js';
import {
  type EnsembleAuthenticationReceipt,
  type EnsembleAuthenticationRequest,
  type EnsemblePreparationHost,
  loadEnsemblePreset,
  type PrepareEnsembleInput,
  prepareEnsemble,
} from '../ensemble-presets.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  query: mockQuery,
}));

const tempDir = trackTempDirs();

async function setup() {
  const directory = await realpath(tempDir('station-ensemble-'));
  const path = join(directory, 'team.json');
  const json = `${JSON.stringify(
    {
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
          engine: 'codex',
          model: 'gpt-6.1-sol',
          reasoning: { option: 'reasoningEffort', value: 'high' },
          options: { fastMode: false },
          promptAppends: ['  Plan\r\n', '', '🙂'],
        },
        {
          id: 'review',
          codename: 'Flux',
          color: '#987def',
          role: 'review',
          engine: 'codex',
          model: 'gpt-6-sol',
          reasoning: { option: 'effort', value: 'medium' },
          options: {},
          promptAppends: ['Review independently.'],
        },
      ],
    },
    null,
    2,
  )}\n`;
  await writeFile(path, json);
  const input: PrepareEnsembleInput = {
    path,
    expectedPresetHash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
    contextKey: 'host:workspace:principal:credential-generation-7',
    brief: '  Task\r\n',
    bindings: {
      lead: { environment: { kind: 'current' }, agent: agentId('coordinator') },
      review: { environment: { kind: 'current' }, agent: agentId('reviewer') },
    },
  };
  const connection: ConnectionConfig = {
    id: 'codex-main',
    name: 'Codex',
    kind: 'agent',
    type: 'codex',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: { provider: 'codex' },
    prerequisites: [],
  };
  let now = 1000;
  const observations: EnsembleAuthenticationRequest[] = [];
  const authenticateMember = vi.fn(
    async (
      request: EnsembleAuthenticationRequest,
    ): Promise<EnsembleAuthenticationReceipt> => {
      observations.push(request);
      return {
        authenticated: true,
        contextKey: request.contextKey,
        presetHash: request.presetHash,
        memberId: request.member.id,
        selectionHash: request.selectionHash,
        checkedAt: now,
      };
    },
  );
  const host: EnsemblePreparationHost = {
    inventory: {
      resolveEnvironmentAccess: async () => ({
        apiBase: 'http://127.0.0.1:43141',
        environmentId: 'ensemble-home',
        environmentName: 'Test home',
        kind: 'current',
        requestOptions: { headers: { Authorization: 'Bearer host-only' } },
      }),
      getAgent: vi.fn(async (_access, id) => ({
        slug: id,
        available: true,
        execution: { agentConnectionId: engineConnectionId('codex-main') },
      })),
      getConnection: vi.fn(async () => connection),
      getProject: async () => undefined,
      getProviderAdapter: () => {
        const adapter = new CodexAdapter();
        vi.spyOn(adapter, 'listModelCatalog').mockResolvedValue({
          models: ['gpt-6.1-sol', 'gpt-6-sol'].map((id) => ({
            id,
            name: id,
            originalId: id,
            capabilities: {
              supportsEffort: true,
              supportedEffortLevels: ['medium', 'high'],
              supportsFastMode: true,
            },
          })),
        });
        return adapter;
      },
    },
    authenticateMember,
    now: () => now,
  };
  return {
    directory,
    path,
    json,
    input,
    host,
    connection,
    observations,
    authenticateMember,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Ensemble file preparation', () => {
  test.each(['ultra', 'max'])(
    'checks Claude %s against the real catalog and mapper before authenticating',
    async (effort) => {
      const fixture = await setup();
      const declaration = parseEnsemblePreset(fixture.json);
      const json = JSON.stringify({
        ...declaration,
        members: [
          {
            ...declaration.members[0],
            engine: 'claude',
            model: 'sonnet',
            reasoning: { option: 'effort', value: effort },
            options: {},
          },
        ],
      });
      await writeFile(fixture.path, json);
      const input = {
        ...fixture.input,
        bindings: { lead: fixture.input.bindings.lead },
        expectedPresetHash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
      };
      fixture.connection.type = 'claude';
      fixture.connection.config = { provider: 'claude' };
      mockQuery.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {},
        supportedModels: async () => [
          {
            value: 'sonnet',
            displayName: 'Sonnet',
            supportsEffort: true,
            supportedEffortLevels: ['high', 'max', 'ultra'],
          },
        ],
        close: vi.fn(),
      }));
      const adapter = new ClaudeAdapter({ findBinary: async () => null });
      const host: EnsemblePreparationHost = {
        ...fixture.host,
        inventory: {
          ...fixture.host.inventory,
          getProviderAdapter: () => adapter,
        },
      };
      try {
        await adapter.startSession({
          threadId: `ensemble-mapper-${effort}`,
          provider: 'claude',
          modelId: 'sonnet',
          modelOptions: { effort },
        });
        expect(mockQuery.mock.calls.at(-1)?.[0].options.effort).toBe(
          effort === 'max' ? 'max' : undefined,
        );
        if (effort === 'ultra') {
          await expect(prepareEnsemble(input, host)).rejects.toThrow(
            'unsupported model option value',
          );
          expect(fixture.authenticateMember).not.toHaveBeenCalled();
        } else {
          const plan = await prepareEnsemble(input, host);
          expect(plan.members[0].target.model?.options).toEqual({
            effort: 'max',
          });
          expect(Object.isFrozen(plan.members[0].target.model?.options)).toBe(
            true,
          );
          expect(fixture.authenticateMember).toHaveBeenCalledTimes(1);
        }
      } finally {
        await adapter.stopSession(`ensemble-mapper-${effort}`);
      }
    },
  );

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
      await expect(loadEnsemblePreset(path)).rejects.toThrow(
        'preset file identity changed',
      );
      expect(injected).toBe(true);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
    }
  });

  test.each([
    'unknown-effort',
    'missing-catalog',
    'missing-capabilities',
    'unsupported-fast-mode',
  ])(
    'refuses %s without dropping or translating authored options',
    async (failure) => {
      const fixture = await setup();
      const json =
        failure === 'unknown-effort'
          ? fixture.json.replace('"value": "high"', '"value": "invented"')
          : fixture.json;
      await writeFile(fixture.path, json);
      const adapter = new CodexAdapter();
      vi.spyOn(adapter, 'listModelCatalog').mockResolvedValue({
        models:
          failure === 'missing-catalog'
            ? []
            : [
                {
                  id: 'gpt-6.1-sol',
                  name: 'Lead',
                  originalId: 'gpt-6.1-sol',
                  ...(failure === 'missing-capabilities'
                    ? {}
                    : {
                        capabilities: {
                          supportsEffort: true,
                          supportedEffortLevels: ['high'],
                          supportsFastMode: failure !== 'unsupported-fast-mode',
                        },
                      }),
                },
              ],
      });
      await expect(
        prepareEnsemble(
          {
            ...fixture.input,
            expectedPresetHash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
          },
          {
            ...fixture.host,
            inventory: {
              ...fixture.host.inventory,
              getProviderAdapter: () => adapter,
            },
          },
        ),
      ).rejects.toThrow('unsupported model option value');
      expect(fixture.authenticateMember).not.toHaveBeenCalled();
    },
  );

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
      await expect(loadEnsemblePreset(fixture.path)).rejects.toThrow(
        'preset file identity changed',
      );
      expect(injected).toBe(true);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
    }
  });

  test('reopens exact bytes and prepares every resolved member with immutable identities, options and roster briefs', async () => {
    const fixture = await setup();
    const first = await loadEnsemblePreset(fixture.path);
    const reopened = await loadEnsemblePreset(fixture.path);
    expect(reopened.json).toBe(fixture.json);
    expect(reopened.sha256).toBe(fixture.input.expectedPresetHash);
    expect(reopened.path).toBe(first.path);
    expect(reopened.preset).toEqual(first.preset);
    expect(() => reopened.assertCurrent()).not.toThrow();
    expect(() => first.assertCurrent()).not.toThrow();
    const plan = await prepareEnsemble(fixture.input, fixture.host);
    expect(plan.stationmaster).toBe('lead');
    expect(plan.source.sha256).toBe(first.sha256);
    expect(
      plan.members.map((entry) => [
        entry.member.id,
        entry.member.codename,
        entry.member.color,
        entry.target.agent,
        entry.target.model,
      ]),
    ).toEqual([
      [
        'lead',
        'Rune',
        '#123ABC',
        'coordinator',
        {
          override: 'gpt-6.1-sol',
          options: { fastMode: false, reasoningEffort: 'high' },
        },
      ],
      [
        'review',
        'Flux',
        '#987def',
        'reviewer',
        { override: 'gpt-6-sol', options: { effort: 'medium' } },
      ],
    ]);
    expect(
      fixture.observations.map((entry) => [
        entry.member.id,
        entry.resolution.agentId,
        entry.resolution.engine,
        entry.resolution.provider,
      ]),
    ).toEqual([
      [
        'lead',
        'coordinator',
        { kind: 'connection', connectionId: 'codex-main' },
        'codex',
      ],
      [
        'review',
        'reviewer',
        { kind: 'connection', connectionId: 'codex-main' },
        'codex',
      ],
    ]);
    expect(plan.members[0].brief).toBe(
      `  Task\r\n\n\n  Plan\r\n\n\n\n\n🙂\n\nYour Ensemble member assignment:\n{"id":"lead","codename":"Rune","role":"coordinate","stationmaster":true}\n\n${plan.roster}`,
    );
    expect(plan.members[1].brief).toBe(
      `  Task\r\n\n\nReview independently.\n\nYour Ensemble member assignment:\n{"id":"review","codename":"Flux","role":"review","stationmaster":false}\n\n${plan.roster}`,
    );
    expect(JSON.stringify(plan)).not.toContain('host-only');
    expect(() =>
      Object.assign(plan.members[0].target.model?.options ?? {}, {
        fastMode: true,
      }),
    ).toThrow();
    expect(() =>
      Object.assign(plan.members[0].member, { color: '#ffffff' }),
    ).toThrow();
  });

  test('requires exact canonical file paths, regular UTF-8 JSON and supported versions', async () => {
    const fixture = await setup();
    await expect(loadEnsemblePreset('team.json')).rejects.toThrow(
      'explicit canonical',
    );
    const alias = join(fixture.directory, 'alias.json');
    await symlink(fixture.path, alias);
    const directoryAlias = join(fixture.directory, 'directory-alias');
    await symlink(fixture.directory, directoryAlias);
    await expect(
      loadEnsemblePreset(join(directoryAlias, 'team.json')),
    ).rejects.toThrow('explicit canonical');
    await expect(loadEnsemblePreset(alias)).rejects.toThrow(
      'explicit canonical',
    );
    await expect(
      loadEnsemblePreset(join(fixture.directory, 'missing.json')),
    ).rejects.toThrow();
    await writeFile(fixture.path, Buffer.from([0x22, 0xff, 0x22]));
    await expect(loadEnsemblePreset(fixture.path)).rejects.toThrow('UTF-8');
    await writeFile(
      fixture.path,
      fixture.json.replace(ENSEMBLE_PRESET_VERSION, 'station.ensemble/v2'),
    );
    await expect(loadEnsemblePreset(fixture.path)).rejects.toThrow(
      'unsupported version',
    );
    await writeFile(fixture.path, ' '.repeat(128 * 1024 + 1));
    await expect(loadEnsemblePreset(fixture.path)).rejects.toThrow(
      'invalid preset file',
    );
  });

  test('refuses missing host bindings and stale exact bytes before authentication', async () => {
    const fixture = await setup();
    await expect(
      prepareEnsemble(
        { ...fixture.input, bindings: { lead: fixture.input.bindings.lead } },
        fixture.host,
      ),
    ).rejects.toThrow('exact host binding');
    await writeFile(fixture.path, `${fixture.json}\n`);
    await expect(prepareEnsemble(fixture.input, fixture.host)).rejects.toThrow(
      'stale preset bytes',
    );
    expect(fixture.authenticateMember).not.toHaveBeenCalled();
  });

  test.each([
    'missing-agent',
    'unready-connection',
    'changed-engine',
    'unsupported-option',
  ])('uses real inventory resolution to refuse %s', async (failure) => {
    const fixture = await setup();
    let host = fixture.host;
    if (failure === 'missing-agent')
      host = {
        ...host,
        inventory: {
          ...host.inventory,
          getAgent: async () => {
            throw new Error('Agent missing');
          },
        },
      };
    if (failure === 'unready-connection') fixture.connection.status = 'error';
    if (failure === 'changed-engine' || failure === 'unsupported-option') {
      const json =
        failure === 'changed-engine'
          ? fixture.json.replace('"engine": "codex"', '"engine": "claude"')
          : fixture.json.replace(
              '"fastMode": false',
              '"serviceTier": "priority"',
            );
      await writeFile(fixture.path, json);
      fixture.input = {
        ...fixture.input,
        expectedPresetHash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
      };
    }
    const reason = {
      'missing-agent': 'Agent missing',
      'unready-connection': 'not ready for execution',
      'changed-engine': 'lead engine/model changed',
      'unsupported-option': "unsupported model option value 'serviceTier'",
    }[failure];
    await expect(prepareEnsemble(fixture.input, host)).rejects.toThrow(reason);
    expect(fixture.authenticateMember).not.toHaveBeenCalled();
  });

  test.each([
    'unauthenticated',
    'old-time',
    'future-time',
    'context',
    'preset',
    'member',
    'selection',
  ])(
    'refuses the second member with %s authentication despite ready inventory',
    async (failure) => {
      const fixture = await setup();
      const authenticate = fixture.host.authenticateMember;
      const host: EnsemblePreparationHost = {
        ...fixture.host,
        authenticateMember: async (request) => {
          const receipt = await authenticate(request);
          if (request.member.id !== 'review') return receipt;
          return {
            ...receipt,
            ...(failure === 'unauthenticated' ? { authenticated: false } : {}),
            ...(failure === 'old-time' ? { checkedAt: 999 } : {}),
            ...(failure === 'future-time' ? { checkedAt: 1001 } : {}),
            ...(failure === 'context' ? { contextKey: 'another-host' } : {}),
            ...(failure === 'preset' ? { presetHash: 'old' } : {}),
            ...(failure === 'member' ? { memberId: 'lead' } : {}),
            ...(failure === 'selection'
              ? { selectionHash: 'another-selection' }
              : {}),
          };
        },
      };
      await expect(prepareEnsemble(fixture.input, host)).rejects.toThrow(
        'review lacks fresh actual-context authentication',
      );
      expect(fixture.observations.map((entry) => entry.member.id)).toEqual([
        'lead',
        'review',
      ]);
    },
  );

  test('fails closed when context authentication is unwired or throws', async () => {
    const fixture = await setup();
    const unwired = { ...fixture.host };
    Reflect.deleteProperty(unwired, 'authenticateMember');
    await expect(prepareEnsemble(fixture.input, unwired)).rejects.toThrow(
      'authentication is required',
    );
    await expect(
      prepareEnsemble(fixture.input, {
        ...fixture.host,
        authenticateMember: async () => {
          throw new Error('context unavailable');
        },
      }),
    ).rejects.toThrow('context unavailable');
  });

  test.each(['expired-auth', 'edited-file'])(
    'refuses %s before returning a plan',
    async (failure) => {
      const fixture = await setup();
      const host: EnsemblePreparationHost = {
        ...fixture.host,
        authenticateMember: async (request) => {
          if (request.member.id === 'review') {
            if (failure === 'expired-auth') fixture.advance(30_001);
            else await writeFile(fixture.path, `${fixture.json}\n`);
          }
          return fixture.host.authenticateMember(request);
        },
      };
      await expect(prepareEnsemble(fixture.input, host)).rejects.toThrow(
        failure === 'expired-auth' ? 'expired' : 'changed during preparation',
      );
    },
  );
});
