import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ISkillRegistryProvider } from '../../provider-interfaces.js';
import { FilesystemSkillRegistryProvider } from '../filesystem-skill-registry';
import { MultiSourceSkillRegistryProvider } from '../multi-source-skill-registry';

const makeTempDir = trackTempDirs();

async function localSkillRoot(): Promise<string> {
  const root = makeTempDir('station-skill-registry-');
  const skillDir = join(root, 'demo-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: demo-skill\ndescription: Local filesystem skill\n---\n\n# Demo`,
    'utf-8',
  );
  return root;
}

/** A remote source's catalog as the GitHub registry returns it. */
function remoteSource(items: RegistryItem[]): ISkillRegistryProvider {
  return {
    listAvailable: async () => items,
    listInstalled: async () => [],
    install: async () => ({ success: false, message: 'remote' }),
    uninstall: async () => ({ success: false, message: 'remote' }),
  };
}

describe('MultiSourceSkillRegistryProvider', () => {
  test('lists local skills when the remote registry has nothing', async () => {
    const root = await localSkillRoot();
    const provider = new MultiSourceSkillRegistryProvider([
      new FilesystemSkillRegistryProvider([root]),
      remoteSource([]),
    ]);

    expect(await provider.listAvailable()).toEqual([
      expect.objectContaining({
        id: 'demo-skill',
        description: 'Local filesystem skill',
        source: root,
      }),
    ]);
  });

  test('keeps one entry per id, the first source winning', async () => {
    const root = await localSkillRoot();
    const provider = new MultiSourceSkillRegistryProvider([
      new FilesystemSkillRegistryProvider([root]),
      remoteSource([
        {
          id: 'demo-skill',
          description: 'Remote copy',
          source: 'github',
          installed: false,
        },
        {
          id: 'remote-only',
          description: 'Remote skill',
          source: 'github',
          installed: false,
        },
      ]),
    ]);

    const items = await provider.listAvailable();

    expect(items.map((item) => [item.id, item.source])).toEqual([
      ['demo-skill', root],
      ['remote-only', 'github'],
    ]);
  });
});
