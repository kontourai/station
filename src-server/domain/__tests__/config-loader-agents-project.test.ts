// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentWorkflow,
  deleteAgentWorkflow,
  listAgentConfigs,
  loadAgentConfig,
  readAgentWorkflow,
  saveAgentConfig,
  updateAgentConfig,
  updateAgentWorkflow,
} from '../config-loader-agents.js';

// Mock the logger (same pattern as validator.spec.ts — config-loader-agents.ts
// imports assertSafeContextText, which does not touch @voltagent/logger, but
// the createLogger import elsewhere in the domain layer does in some suites).
describe('config-loader-agents — project ownership (station#1004, unification slice 7)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-agent-project-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function createProject(slug: string) {
    const dir = join(home, 'projects', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({
        id: slug,
        slug,
        name: slug,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function writeAgent(slug: string, spec: unknown) {
    const dir = join(home, 'agents', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(spec, null, 2));
  }

  it('saveAgentConfig rejects a project value naming a nonexistent project', async () => {
    await expect(
      saveAgentConfig(home, 'owned-agent', {
        name: 'Owned Agent',
        prompt: 'You are owned.',
        project: 'ghost-project',
      }),
    ).rejects.toThrow(
      "Project 'ghost-project' does not exist; an agent can only be owned by an existing project.",
    );
  });

  it('saveAgentConfig accepts a project value naming an existing project', async () => {
    createProject('real-project');

    await expect(
      saveAgentConfig(home, 'owned-agent', {
        name: 'Owned Agent',
        prompt: 'You are owned.',
        project: 'real-project',
      }),
    ).resolves.toBeUndefined();

    const spec = await loadAgentConfig(home, 'owned-agent');
    expect(spec.project).toBe('real-project');
  });

  it('saveAgentConfig preserves an unchanged orphaned project value already on disk (A1)', async () => {
    writeAgent('orphaned-agent', {
      name: 'Orphaned Agent',
      prompt: 'You used to belong somewhere.',
      project: 'gone-project',
    });

    await expect(
      saveAgentConfig(home, 'orphaned-agent', {
        name: 'Orphaned Agent Renamed',
        prompt: 'You used to belong somewhere.',
        project: 'gone-project',
      }),
    ).resolves.toBeUndefined();

    const spec = await loadAgentConfig(home, 'orphaned-agent');
    expect(spec.project).toBe('gone-project');
    expect(spec.name).toBe('Orphaned Agent Renamed');
  });

  it('saveAgentConfig rejects changing project to a different nonexistent project on an already-orphaned record (A1)', async () => {
    writeAgent('orphaned-agent', {
      name: 'Orphaned Agent',
      prompt: 'You used to belong somewhere.',
      project: 'gone-project',
    });

    await expect(
      saveAgentConfig(home, 'orphaned-agent', {
        name: 'Orphaned Agent',
        prompt: 'You used to belong somewhere.',
        project: 'another-gone-project',
      }),
    ).rejects.toThrow(
      "Project 'another-gone-project' does not exist; an agent can only be owned by an existing project.",
    );
  });

  it('loadAgentConfig preserves an on-disk project value naming a nonexistent project — never rewritten or cleared', async () => {
    writeAgent('orphaned-agent', {
      name: 'Orphaned Agent',
      prompt: 'You used to belong somewhere.',
      project: 'gone-project',
    });

    const spec = await loadAgentConfig(home, 'orphaned-agent');
    expect(spec.project).toBe('gone-project');
  });

  it('listAgentConfigs lists an orphan-owned agent with its project value instead of skipping it', async () => {
    writeAgent('orphaned-agent', {
      name: 'Orphaned Agent',
      prompt: 'You used to belong somewhere.',
      project: 'gone-project',
    });

    const agents = await listAgentConfigs(home);
    const orphan = agents.find((agent) => agent.slug === 'orphaned-agent');
    expect(orphan).toBeDefined();
    expect(orphan?.project).toBe('gone-project');
  });

  it('updateAgentConfig with project: null removes ownership from the persisted record', async () => {
    createProject('real-project');
    writeAgent('owned-agent', {
      name: 'Owned Agent',
      prompt: 'You are owned.',
      project: 'real-project',
    });

    const updated = await updateAgentConfig(home, 'owned-agent', {
      project: null as unknown as string,
    });
    expect(updated.project).toBeUndefined();

    const reloaded = await loadAgentConfig(home, 'owned-agent');
    expect(reloaded.project).toBeUndefined();
  });

  it('updateAgentConfig omitting project preserves the persisted ownership', async () => {
    createProject('real-project');
    writeAgent('owned-agent', {
      name: 'Owned Agent',
      prompt: 'You are owned.',
      project: 'real-project',
    });

    const updated = await updateAgentConfig(home, 'owned-agent', {
      name: 'Owned Agent Renamed',
    });
    expect(updated.project).toBe('real-project');
  });

  it('serializes concurrent distinct agent edits against a fresh read', async () => {
    writeAgent('concurrent-agent', {
      name: 'Concurrent Agent',
      prompt: 'Original prompt',
    });

    await Promise.all([
      updateAgentConfig(home, 'concurrent-agent', { prompt: 'New prompt' }),
      updateAgentConfig(home, 'concurrent-agent', { name: 'New name' }),
    ]);

    await expect(
      loadAgentConfig(home, 'concurrent-agent'),
    ).resolves.toMatchObject({ name: 'New name', prompt: 'New prompt' });
  });

  it('fails loudly on corrupt agent JSON without rewriting its bytes', async () => {
    const path = join(home, 'agents', 'corrupt-agent', 'agent.json');
    mkdirSync(join(home, 'agents', 'corrupt-agent'), { recursive: true });
    writeFileSync(path, '{corrupt');

    await expect(
      updateAgentConfig(home, 'corrupt-agent', { name: 'Replacement' }),
    ).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{corrupt');
  });

  it('serializes workflow create/update/delete and publishes complete bytes', async () => {
    writeAgent('workflow-agent', {
      name: 'Workflow Agent',
      prompt: 'Runs workflows',
    });
    await createAgentWorkflow(
      home,
      'workflow-agent',
      'build.ts',
      'export const value = 1;',
    );
    await updateAgentWorkflow(
      home,
      'workflow-agent',
      'build.ts',
      'export const value = 2;',
    );
    await expect(
      readAgentWorkflow(home, 'workflow-agent', 'build.ts'),
    ).resolves.toBe('export const value = 2;');
    expect(
      readdirSync(join(home, 'agents', 'workflow-agent', 'workflows')).filter(
        (name) => name.endsWith('.tmp'),
      ),
    ).toEqual([]);
    await deleteAgentWorkflow(home, 'workflow-agent', 'build.ts');
    await expect(
      readAgentWorkflow(home, 'workflow-agent', 'build.ts'),
    ).rejects.toThrow("Workflow 'build.ts' not found");
  });

  it('does not resurrect a workflow when update races delete', async () => {
    writeAgent('workflow-agent', {
      name: 'Workflow Agent',
      prompt: 'Runs workflows',
    });
    await createAgentWorkflow(home, 'workflow-agent', 'build.ts', 'old');
    await Promise.allSettled([
      updateAgentWorkflow(home, 'workflow-agent', 'build.ts', 'new'),
      deleteAgentWorkflow(home, 'workflow-agent', 'build.ts'),
    ]);
    await expect(
      readAgentWorkflow(home, 'workflow-agent', 'build.ts'),
    ).rejects.toThrow("Workflow 'build.ts' not found");
  });
});
