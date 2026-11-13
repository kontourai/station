import { afterEach, describe, expect, test } from 'vitest';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import {
  listValidatedACPRegistryEntries,
  nameSkeleton,
  registryLaunchEnvFor,
} from '../acp-engine-descriptors.js';

/**
 * Which connections get a built-in entry's launch variables: the ones whose
 * executable is that entry's program, however the connection names it.
 */
describe('registryLaunchEnvFor executable matching', () => {
  afterEach(() => clearAll());

  function registerGoose() {
    registerACPConnectionRegistryProvider(
      {
        listAvailable: () => [
          {
            id: 'goose',
            name: 'Goose',
            command: 'goose',
            launchEnv: { GOOSE_DISABLE_KEYRING: '1' },
          },
        ],
      },
      'builtin-acp-connections',
      true,
    );
  }
  const GOOSE_ENV = { GOOSE_DISABLE_KEYRING: '1' };

  test.each([
    ['goose', 'linux'],
    ['/opt/homebrew/bin/goose', 'darwin'],
    ['goose.exe', 'win32'],
    ['goose.cmd', 'win32'],
    ['C:\\tools\\goose\\goose.exe', 'win32'],
    ['C:\\tools\\Goose.EXE', 'win32'],
  ])('%s on %s gets the built-in variables', (command, platform) => {
    registerGoose();
    expect(registryLaunchEnvFor({ command }, platform)).toEqual(GOOSE_ENV);
  });

  test.each([
    // POSIX names are case-sensitive and keep their extension and backslashes.
    ['Goose', 'darwin'],
    ['goose.exe', 'linux'],
    ['tools\\goose', 'linux'],
    ['goose-wrapper', 'win32'],
  ])('%s on %s does not', (command, platform) => {
    registerGoose();
    expect(registryLaunchEnvFor({ command }, platform)).toBeUndefined();
  });
});

describe('nameSkeleton', () => {
  test('drops characters that render as nothing before comparing names', () => {
    for (const name of [
      'Go\u00ADose',
      'Go\u034Fose',
      'Goose\u3164',
      'Goose\uFFA0',
      'Go\u200Dose',
      'Goose\uFE0F',
    ]) {
      expect(nameSkeleton(name)).toBe('goose');
    }
  });
});

describe('managedRuntime admission', () => {
  afterEach(() => clearAll());

  const managedRuntime = {
    installId: 'example-engine',
    argv: ['--experimental-wasm-modules', '{script}', '--transport=stdio'],
  };

  test('a built-in entry may name a managed runtime; a plugin entry may not', () => {
    registerACPConnectionRegistryProvider(
      {
        listAvailable: () => [
          {
            id: 'managed-builtin',
            name: 'Managed',
            command: 'node',
            managedRuntime,
          },
        ],
      },
      'builtin-acp-connections',
      true,
    );
    registerACPConnectionRegistryProvider(
      {
        listAvailable: () => [
          {
            id: 'managed-plugin',
            name: 'Plugin Engine',
            command: 'node',
            managedRuntime,
          },
          { id: 'plain-plugin', name: 'Plain Engine', command: 'plain' },
        ],
      },
      'example-plugin',
      false,
    );
    expect(
      listValidatedACPRegistryEntries().map(({ entry }) => entry.id),
    ).toEqual(['managed-builtin', 'plain-plugin']);
  });

  test('a built-in entry with an invalid managed runtime is refused whole', () => {
    registerACPConnectionRegistryProvider(
      {
        listAvailable: () => [
          {
            id: 'managed-builtin',
            name: 'Managed',
            command: 'node',
            managedRuntime: { installId: 'example-engine', argv: ['run'] },
          },
        ],
      },
      'builtin-acp-connections',
      true,
    );
    expect(listValidatedACPRegistryEntries()).toEqual([]);
  });
});
