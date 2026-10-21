import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../config-loader.js';

const tempDir = trackTempDirs();

async function fixture() {
  const home = await realpath(tempDir('preparation-configuration-'));
  const loader = new ConfigLoader({ projectHomeDir: home });
  await loader.saveAppConfig({
    defaultModel: 'default/model',
    invokeModel: '',
    structureModel: '',
    systemPrompt: 'Fixture',
  });
  await loader.saveAgent('coordinator', {
    name: 'Coordinator',
    prompt: 'Fixture',
  });
  return { home, loader };
}

describe('ConfigLoader preparation source fence', () => {
  test('unchanged owner bytes remain current without a watcher or write lock', async () => {
    const f = await fixture();
    const current = f.loader.capturePreparationConfigurationFence([
      'coordinator',
    ]);
    await f.loader.loadAgent('coordinator');
    await f.loader.loadAppConfig();
    expect(current).not.toThrow();
  });

  test.each([
    'config/app.json',
    'config/agent-registry.json',
    'config/acp.json',
    'agents/coordinator/agent.json',
  ])(
    'retires the fence when %s changes, including absent-file creation',
    async (path) => {
      const f = await fixture();
      const current = f.loader.capturePreparationConfigurationFence([
        'coordinator',
      ]);
      const file = join(f.home, path);
      const temporary = `${file}.next`;
      await writeFile(temporary, '{}');
      await rename(temporary, file);
      expect(current).toThrow('Preparation configuration changed');
    },
  );

  test.each(['config/app.json', 'agents/coordinator/agent.json'])(
    'rejects %s A-to-B-to-A even after the original JSON bytes return',
    async (path) => {
      const f = await fixture();
      const file = join(f.home, path);
      const original = await readFile(file);
      const current = f.loader.capturePreparationConfigurationFence([
        'coordinator',
      ]);
      await writeFile(`${file}.b`, '{}');
      await rename(`${file}.b`, file);
      await writeFile(`${file}.a`, original);
      await rename(`${file}.a`, file);
      expect(current).toThrow('Preparation configuration changed');
      expect(
        f.loader.capturePreparationConfigurationFence(['coordinator']),
      ).not.toThrow();
    },
  );

  test('refuses a deleted source, plugin-owned sources, symlinks and unsafe identities', async () => {
    const f = await fixture();
    const current = f.loader.capturePreparationConfigurationFence([
      'coordinator',
    ]);
    const file = join(f.home, 'agents/coordinator/agent.json');
    await rm(file);
    expect(current).toThrow();
    await writeFile(
      file,
      JSON.stringify({ name: 'Coordinator', prompt: 'Fixture' }),
    );
    const marker = join(
      f.home,
      'agents/coordinator/.station-plugin-owner.json',
    );
    await writeFile(marker, '{}');
    expect(() =>
      f.loader.capturePreparationConfigurationFence(['coordinator']),
    ).toThrow('Plugin');
    await rm(marker);
    await rename(file, `${file}.target`);
    await symlink(`${file}.target`, file);
    expect(() =>
      f.loader.capturePreparationConfigurationFence(['coordinator']),
    ).toThrow();
    expect(() =>
      f.loader.capturePreparationConfigurationFence(['../coordinator']),
    ).toThrow();
    const absent = f.loader.capturePreparationConfigurationFence(['missing']);
    await mkdir(join(f.home, 'agents/missing'));
    await writeFile(join(f.home, 'agents/missing/agent.json'), '{}');
    expect(absent).toThrow('Preparation configuration changed');
  });
});
