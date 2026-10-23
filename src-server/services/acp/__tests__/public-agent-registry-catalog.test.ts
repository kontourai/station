/**
 * Mapping the real 2026-10-21 registry index onto the Add engine catalogue,
 * against Station's real built-in engine list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import { parsePublicAgentRegistry } from '../public-agent-registry.js';
import {
  BUILTIN_REGISTRY_ALIASES,
  mapPublicRegistryListings,
  NATIVE_ENGINE_LISTINGS,
  publicRegistryProgramName,
  REVIEWED_REGISTRY_LISTINGS,
} from '../public-agent-registry-catalog.js';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'public-agent-registry-20261021.json'),
  'utf8',
);

/** Binary builds across all listings in the 2026-10-21 snapshot. */
const BINARY_BUILDS_IN_SNAPSHOT = 107;

function fixtureAgents() {
  const parsed = parsePublicAgentRegistry(FIXTURE);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.agents;
}

function map(
  overrides: Partial<Parameters<typeof mapPublicRegistryListings>[0]> = {},
) {
  return mapPublicRegistryListings({
    agents: fixtureAgents(),
    builtins: BUILTIN_ACP_ENGINES,
    takenIds: new Set(),
    platform: 'darwin',
    arch: 'arm64',
    commandExists: () => false,
    ...overrides,
  });
}

function entry(catalog: ReturnType<typeof map>, id: string) {
  return catalog.entries.find((candidate) => candidate.id === id);
}

describe('public registry listings as catalogue entries', () => {
  test('a listing whose id is a built-in only enriches it with display facts', () => {
    const catalog = map();
    for (const id of ['goose', 'cursor', 'kimi', 'factory-droid', 'opencode']) {
      expect(entry(catalog, id)).toBeUndefined();
    }
    const goose = catalog.enrichments.get('goose');
    expect(goose).toMatchObject({
      id: 'goose',
      version: '1.55.0',
      publishers: ['Block'],
      distributions: ['binary'],
    });
    // Enrichment carries no launch, environment or install facts.
    expect(goose).not.toHaveProperty('hostLaunch');
    expect(goose).not.toHaveProperty('recommendedEnv');
    expect(catalog.enrichments.get('factory-droid')).not.toHaveProperty(
      'recommendedEnv',
    );
  });

  test('a built-in listed under another registry id is not shown twice', () => {
    const catalog = map();
    for (const [registryId, builtinId] of Object.entries(
      BUILTIN_REGISTRY_ALIASES,
    )) {
      expect(entry(catalog, registryId)).toBeUndefined();
      expect(catalog.enrichments.get(builtinId)?.id).toBe(registryId);
    }
  });

  test('every alias names a real built-in engine', () => {
    const builtinIds = new Set(BUILTIN_ACP_ENGINES.map(({ id }) => id));
    expect(Object.values(BUILTIN_REGISTRY_ALIASES).sort()).toEqual([
      'antigravity',
      'copilot',
      'pi',
    ]);
    for (const id of Object.values(BUILTIN_REGISTRY_ALIASES)) {
      expect(builtinIds.has(id)).toBe(true);
    }
  });

  test('a reviewed listing connects the reviewed program found by name with the reviewed arguments', () => {
    const catalog = map({
      commandExists: (command) => command === 'stakpak',
    });
    expect(entry(catalog, 'stakpak')).toMatchObject({
      name: 'Stakpak',
      command: 'stakpak',
      args: ['acp'],
      detected: true,
      source: 'registry',
      sourceName: 'Public agent registry',
      publicRegistry: {
        version: '0.3.88',
        publishers: ['Stakpak Team <contact@stakpak.dev>'],
        hostLaunch: { command: 'stakpak', args: ['acp'] },
      },
    });
    expect(entry(catalog, 'stakpak')?.publicRegistry).not.toHaveProperty(
      'unavailableReason',
    );
    expect(entry(catalog, 'stakpak')?.hostInstall?.note).toBe(
      "Install Stakpak by following Stakpak Team's instructions, so stakpak is on the PATH of the computer Station runs on. Station does not download it.",
    );
    expect(entry(catalog, 'cortex-code')?.publicRegistry?.hostLaunch).toEqual({
      command: 'cortex',
      args: ['acp', 'serve'],
    });
  });

  test('every reviewed listing in the 2026-10-21 snapshot connects on each platform it has a build for', () => {
    expect(Object.keys(REVIEWED_REGISTRY_LISTINGS).sort()).toEqual([
      'cortex-code',
      'crow-cli',
      'stakpak',
      'vtcode',
    ]);
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['win32', 'x64'],
    ] as const) {
      const catalog = map({ platform, arch });
      for (const [id, reviewed] of Object.entries(REVIEWED_REGISTRY_LISTINGS)) {
        expect(entry(catalog, id)?.publicRegistry?.hostLaunch).toEqual({
          command: reviewed.program,
          args: [...reviewed.args],
        });
      }
    }
  });

  test('every argument in the snapshot passes the argument grammar or belongs to an unreviewed listing', () => {
    // The grammar admits the arguments real listings use, including flags
    // with values (`--acp=true`, `--uid=`) and pairs (`--mode acp`).
    let checked = 0;
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'arm64'],
      ['linux', 'x64'],
      ['win32', 'arm64'],
      ['win32', 'x64'],
    ] as const) {
      const catalog = map({
        platform,
        arch,
        agents: fixtureAgents().map((agent) => ({
          ...agent,
          id: 'stakpak',
          name: 'Stakpak',
          binary: Object.fromEntries(
            Object.entries(agent.binary).map(([key, target]) => [
              key,
              { ...target, cmd: './stakpak' },
            ]),
          ),
        })),
      });
      for (const listed of catalog.entries) {
        const reason = listed.publicRegistry?.unavailableReason ?? '';
        expect(reason).not.toContain('not plain words or flags');
        if (
          listed.publicRegistry?.hostLaunch ||
          reason.includes('different arguments')
        )
          checked += 1;
      }
    }
    // Every binary build in the snapshot reached the grammar check.
    expect(checked).toBe(BINARY_BUILDS_IN_SNAPSHOT);
  });

  test('an unreviewed binary listing is shown, unconnectable, with its details', () => {
    const catalog = map({ commandExists: () => true });
    const amp = entry(catalog, 'amp-acp');
    expect(amp).toMatchObject({ command: '', detected: false });
    expect(amp?.publicRegistry?.hostLaunch).toBeUndefined();
    expect(amp?.publicRegistry?.unavailableReason).toMatch(
      /^Not yet reviewed by Station\./,
    );
    expect(amp?.publicRegistry).toMatchObject({
      version: '0.10.0',
      repositoryUrl: 'https://github.com/tao12345666333/amp-acp',
    });
  });

  test('reads the reviewed program name out of the registry path on Windows', () => {
    const catalog = map({ platform: 'win32', arch: 'x64' });
    expect(entry(catalog, 'stakpak')?.command).toBe('stakpak');
    expect(entry(catalog, 'cortex-code')?.command).toBe('cortex');
    expect(publicRegistryProgramName('./dist-package\\cursor-agent.cmd')).toBe(
      'cursor-agent',
    );
    // A PowerShell script is not the reviewed program.
    expect(publicRegistryProgramName('./stakpak.ps1')).toBe('stakpak.ps1');
  });

  test('a listing with no build for this host is listed unavailable with the reason, not dropped', () => {
    const catalog = map({ platform: 'win32', arch: 'arm64' });
    const stakpak = entry(catalog, 'stakpak');
    expect(stakpak).toMatchObject({ command: '', detected: false });
    expect(stakpak?.publicRegistry?.hostLaunch).toBeUndefined();
    expect(stakpak?.publicRegistry?.unavailableReason).toBe(
      'The registry has no Stakpak build for Windows on ARM64. It lists builds for Linux on ARM64, Linux on x86-64, macOS on Apple silicon, macOS on Intel, Windows on x86-64.',
    );
  });

  test('a host the registry has no platform key for lists binaries as unavailable', () => {
    const catalog = map({ platform: 'freebsd', arch: 'x64' });
    expect(entry(catalog, 'stakpak')?.publicRegistry?.unavailableReason).toBe(
      'Station runs on freebsd on x64, which the registry has no builds for.',
    );
  });

  test('package-runner listings are listed with a reason and never connectable', () => {
    const catalog = map();
    const gemini = entry(catalog, 'gemini');
    expect(gemini?.publicRegistry?.hostLaunch).toBeUndefined();
    expect(gemini?.publicRegistry?.packages).toEqual([
      { kind: 'npx', package: '@google/gemini-cli@0.65.0', args: ['--acp'] },
    ]);
    expect(gemini?.publicRegistry?.unavailableReason).toBe(
      'Gemini CLI runs from the @google/gemini-cli@0.65.0 package, which Station would have to download and run (npx). Station does not do that; install Gemini CLI yourself, then add it as a custom engine.',
    );
    expect(
      entry(catalog, 'fast-agent')?.publicRegistry?.unavailableReason,
    ).toContain('fast-agent-acp==0.10.1 package');
  });

  test('a listing for a natively connected engine says so', () => {
    const catalog = map();
    for (const [id, name] of Object.entries(NATIVE_ENGINE_LISTINGS)) {
      expect(entry(catalog, id)?.publicRegistry?.unavailableReason).toBe(
        `Station connects to ${name} directly. Add ${name} from the engine list instead.`,
      );
    }
  });

  test('registry environment is shown as a recommendation, never as launch environment', () => {
    const vtcode = entry(map(), 'vtcode');
    expect(vtcode?.publicRegistry?.recommendedEnv).toEqual({
      VT_ACP_ENABLED: '1',
      VT_ACP_ZED_ENABLED: '1',
    });
    expect(vtcode).not.toHaveProperty('launchEnv');
  });

  test('refuses a listing that reads as a built-in, or takes an id another source holds', () => {
    const [agent] = fixtureAgents().filter((a) => a.id === 'stakpak');
    const catalog = map({
      agents: [
        { ...agent, id: 'goose-pro', name: 'Gооse' },
        { ...agent, id: 'plugin-engine' },
      ],
      takenIds: new Set(['plugin-engine']),
    });
    expect(catalog.entries).toEqual([]);
    expect(catalog.refused).toEqual([
      {
        id: 'goose-pro',
        reasons: ["name 'Gооse' reads as a built-in engine"],
      },
      {
        id: 'plugin-engine',
        reasons: [
          "id 'plugin-engine' is already used by another engine source",
        ],
      },
    ]);
  });

  // A reviewed id runs only the reviewed program with the reviewed, plain
  // arguments; a wrapper, runner, shell or changed argument list does not.
  test.each([
    ['a wrapper around a runner', './nice', ['npx', '-y', 'evil'], 'now names'],
    ['a wrapper with the reviewed arguments', './nice', ['acp'], 'now names'],
    ['a package runner', './bin/npx', ['acp'], 'now names'],
    [
      'a package runner on Windows',
      'C:\\Windows\\uvx.exe',
      ['acp'],
      'now names',
    ],
    ['a shell', './sh', ['acp'], 'now names'],
    ['a PowerShell script', './stakpak.ps1', ['acp'], 'now names'],
    [
      'an argument with a path',
      './stakpak',
      ['acp', '--config=../x y'],
      'not plain words or flags',
    ],
    [
      'too many arguments',
      './stakpak',
      ['acp', 'a', 'b', 'c', 'd'],
      'not plain words or flags',
    ],
    [
      'a shell construct in an argument',
      './stakpak',
      ['acp;id'],
      'not plain words or flags',
    ],
    ['other plain arguments', './stakpak', ['serve'], 'different arguments'],
  ])('a reviewed id with %s is unavailable', (_, cmd, args, reason) => {
    const [agent] = fixtureAgents().filter((a) => a.id === 'stakpak');
    for (const [platform, arch, key] of [
      ['darwin', 'arm64', 'darwin-aarch64'],
      ['win32', 'x64', 'windows-x86_64'],
    ] as const) {
      const catalog = map({
        platform,
        arch,
        agents: [{ ...agent, binary: { [key]: { cmd, args } } }],
        commandExists: () => true,
      });
      const listed = catalog.entries[0];
      expect(listed.publicRegistry?.hostLaunch).toBeUndefined();
      expect(listed.command).toBe('');
      expect(listed.publicRegistry?.unavailableReason).toContain(reason);
    }
  });

  test('an unreviewed id is unavailable whatever it runs, a wrapped runner included', () => {
    const [agent] = fixtureAgents().filter((a) => a.id === 'stakpak');
    const catalog = map({
      agents: [
        {
          ...agent,
          id: 'nice-agent',
          name: 'Nice Agent',
          binary: {
            'darwin-aarch64': { cmd: './nice', args: ['npx', '-y', 'evil'] },
          },
        },
      ],
      commandExists: () => true,
    });
    expect(catalog.entries[0].publicRegistry?.hostLaunch).toBeUndefined();
    expect(catalog.entries[0].publicRegistry?.unavailableReason).toMatch(
      /^Not yet reviewed by Station\./,
    );
  });

  test('refuses a listing whose name reads as Station or Kontour', () => {
    const [agent] = fixtureAgents().filter((a) => a.id === 'stakpak');
    const catalog = map({
      agents: [
        { ...agent, id: 'station-agent', name: 'Statiоn' },
        { ...agent, id: 'kontour-agent', name: 'KONTOUR' },
      ],
    });
    expect(catalog.entries).toEqual([]);
    expect(catalog.refused.map((refusal) => refusal.id)).toEqual([
      'station-agent',
      'kontour-agent',
    ]);
  });
});
