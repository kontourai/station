import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FilesystemSkillRegistryProvider } from '../filesystem-skill-registry';
import { MultiSourceSkillRegistryProvider } from '../multi-source-skill-registry';

describe('MultiSourceSkillRegistryProvider', () => {
  test('lists local filesystem skills without requiring the remote registry', async () => {
    const root = join(tmpdir(), `station-skill-registry-${Date.now()}`);
    const skillDir = join(root, 'demo-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: demo-skill\ndescription: Local filesystem skill\n---\n\n# Demo`,
      'utf-8',
    );

    const provider = new MultiSourceSkillRegistryProvider([
      new FilesystemSkillRegistryProvider([root]),
    ]);

    const items = await provider.listAvailable();

    expect(items).toEqual([
      expect.objectContaining({
        id: 'demo-skill',
        description: 'Local filesystem skill',
        source: root,
      }),
    ]);
  });
});
