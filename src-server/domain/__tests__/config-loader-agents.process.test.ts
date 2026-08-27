// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, test } from 'vitest';
import { loadAgentConfig, updateAgentConfig } from '../config-loader-agents.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('agent configuration cross-process mutation', () => {
  test('a held agent lock does not serialize persistence for another agent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-agent-process-'));
    roots.push(home);
    const lockDir = join(home, 'config', 'agent-persistence');
    mkdirSync(lockDir, { recursive: true });
    for (const slug of ['held-agent', 'free-agent']) {
      const agentDir = join(home, 'agents', slug);
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'agent.json'),
        JSON.stringify({ name: slug, prompt: 'Original prompt' }),
      );
    }

    const release = await acquireFileMutationLockAsync(
      join(lockDir, 'held-agent.lock'),
    );
    try {
      const result = await Promise.race([
        updateAgentConfig(home, 'free-agent', { prompt: 'Independent' }),
        new Promise<'timed-out'>((resolve) =>
          setTimeout(() => resolve('timed-out'), 500),
        ),
      ]);
      expect(result).not.toBe('timed-out');
      expect(await loadAgentConfig(home, 'free-agent')).toMatchObject({
        prompt: 'Independent',
      });
    } finally {
      await release();
    }
  });

  test('distinct edits from two Station processes both survive', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-agent-process-'));
    roots.push(home);
    const agentDir = join(home, 'agents', 'shared-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({ name: 'Original', prompt: 'Original prompt' }),
    );
    const loaderUrl = new URL('../config-loader-agents.ts', import.meta.url)
      .href;
    const child = (updates: object) =>
      spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import { updateAgentConfig } from ${JSON.stringify(loaderUrl)};
           try {
             await updateAgentConfig(process.argv[1], 'shared-agent', JSON.parse(process.argv[2]));
             process.exit(0);
           } catch (error) {
             process.stderr.write(String(error));
             process.exit(2);
           }`,
          home,
          JSON.stringify(updates),
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );

    const first = child({ name: 'Process one' });
    const second = child({ prompt: 'Process two prompt' });
    const [[firstCode], [secondCode]] = await Promise.all([
      once(first, 'exit'),
      once(second, 'exit'),
    ]);
    expect(firstCode).toBe(0);
    expect(secondCode).toBe(0);
    await expect(loadAgentConfig(home, 'shared-agent')).resolves.toMatchObject({
      name: 'Process one',
      prompt: 'Process two prompt',
    });
  });
});
