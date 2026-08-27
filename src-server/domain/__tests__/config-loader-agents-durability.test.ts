// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncFault = vi.hoisted(() => ({ remaining: 0 }));

vi.mock(
  '@kontourai/station-shared/fs-windows-compat',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/fs-windows-compat')
      >();
    return {
      ...actual,
      fsyncDirectorySync(path: string) {
        if (syncFault.remaining > 0) {
          syncFault.remaining -= 1;
          throw new Error('injected parent directory sync failure');
        }
        return actual.fsyncDirectorySync(path);
      },
    };
  },
);

import {
  deleteAgentConfig,
  deleteAgentWorkflow,
  loadAgentConfig,
  readAgentWorkflow,
  updateAgentConfig,
  updateAgentWorkflow,
} from '../config-loader-agents.js';

describe('agent persistence durability faults', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-agent-durability-'));
    const agentDir = join(home, 'agents', 'durable-agent');
    mkdirSync(join(agentDir, 'workflows'), { recursive: true });
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({ name: 'Durable Agent', prompt: 'old prompt' }, null, 2),
    );
    writeFileSync(join(agentDir, 'workflows', 'build.ts'), 'old workflow');
  });

  afterEach(() => {
    syncFault.remaining = 0;
    rmSync(home, { recursive: true, force: true });
  });

  it('loads a prior Agent carrying a safe local image icon unchanged', async () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    writeFileSync(
      join(home, 'agents', 'durable-agent', 'agent.json'),
      JSON.stringify(
        { name: 'Durable Agent', prompt: 'old prompt', icon },
        null,
        2,
      ),
    );
    await expect(loadAgentConfig(home, 'durable-agent')).resolves.toMatchObject(
      { icon },
    );
  });

  it('fails loudly after an agent JSON rename whose directory sync fails, leaves complete bytes, and retries', async () => {
    syncFault.remaining = 1;
    await expect(
      updateAgentConfig(home, 'durable-agent', { prompt: 'new prompt' }),
    ).rejects.toThrow('injected parent directory sync failure');

    expect(await loadAgentConfig(home, 'durable-agent')).toMatchObject({
      name: 'Durable Agent',
      prompt: 'new prompt',
    });
    expect(
      readFileSync(join(home, 'agents', 'durable-agent', 'agent.json'), 'utf8'),
    ).toBe(
      JSON.stringify({ name: 'Durable Agent', prompt: 'new prompt' }, null, 2),
    );

    await expect(
      updateAgentConfig(home, 'durable-agent', { prompt: 'retry prompt' }),
    ).resolves.toMatchObject({ prompt: 'retry prompt' });
  });

  it('fails loudly after a workflow rename whose directory sync fails, leaves complete bytes, and retries', async () => {
    syncFault.remaining = 1;
    await expect(
      updateAgentWorkflow(home, 'durable-agent', 'build.ts', 'new workflow'),
    ).rejects.toThrow('injected parent directory sync failure');

    expect(await readAgentWorkflow(home, 'durable-agent', 'build.ts')).toBe(
      'new workflow',
    );
    await expect(
      updateAgentWorkflow(home, 'durable-agent', 'build.ts', 'retry workflow'),
    ).resolves.toBeUndefined();
    expect(await readAgentWorkflow(home, 'durable-agent', 'build.ts')).toBe(
      'retry workflow',
    );
  });

  it('durably restores an agent directory when delete sync fails, then retries without an orphan', async () => {
    syncFault.remaining = 1;
    await expect(deleteAgentConfig(home, 'durable-agent')).rejects.toThrow(
      'injected parent directory sync failure',
    );

    await expect(loadAgentConfig(home, 'durable-agent')).resolves.toMatchObject(
      {
        name: 'Durable Agent',
        prompt: 'old prompt',
      },
    );
    expect(
      readdirSync(join(home, 'agents')).filter((entry) =>
        entry.startsWith('durable-agent.deleting.'),
      ),
    ).toEqual([]);

    await expect(
      deleteAgentConfig(home, 'durable-agent'),
    ).resolves.toBeUndefined();
    expect(existsSync(join(home, 'agents', 'durable-agent'))).toBe(false);
  });

  it('durably restores a workflow when delete sync fails, then retries without an orphan or resurrection', async () => {
    const workflowsDir = join(home, 'agents', 'durable-agent', 'workflows');
    syncFault.remaining = 1;
    await expect(
      deleteAgentWorkflow(home, 'durable-agent', 'build.ts'),
    ).rejects.toThrow('injected parent directory sync failure');

    await expect(
      readAgentWorkflow(home, 'durable-agent', 'build.ts'),
    ).resolves.toBe('old workflow');
    expect(
      readdirSync(workflowsDir).filter((entry) =>
        entry.startsWith('build.ts.deleting.'),
      ),
    ).toEqual([]);

    await expect(
      deleteAgentWorkflow(home, 'durable-agent', 'build.ts'),
    ).resolves.toBeUndefined();
    expect(existsSync(join(workflowsDir, 'build.ts'))).toBe(false);
  });
});
