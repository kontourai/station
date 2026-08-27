/**
 * Separate process-heavy proof: a promise queue inside one Station process
 * cannot establish the same-home mutation guarantee this module claims.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskOutputModule } from '../task-output-module.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function taskGraph(workspace: string) {
  return {
    readTask: (taskId: string) =>
      taskId === 'task-a' ? { id: taskId, projectId: 'project-a' } : null,
    readTaskForOpen: async (taskId: string) =>
      taskId === 'task-a'
        ? {
            id: taskId,
            projectId: 'project-a',
            workspaceBinding: {
              availability: 'available' as const,
              workingDirectory: workspace,
            },
          }
        : null,
  };
}

function promoteInChild(input: {
  home: string;
  workspace: string;
  relativePath: string;
  operationId: string;
  maxPerTask: number;
}): Promise<{ code: number | null; output: string; stderr: string }> {
  const moduleUrl = new URL('../task-output-module.ts', import.meta.url).href;
  const script = `
    import { TaskOutputModule } from ${JSON.stringify(moduleUrl)};
    const [home, workspace, relativePath, operationId, maxPerTask] = process.argv.slice(1);
    const tasks = {
      readTask: (taskId) => taskId === 'task-a' ? { id: taskId, projectId: 'project-a' } : null,
      readTaskForOpen: async (taskId) => taskId === 'task-a' ? {
        id: taskId, projectId: 'project-a',
        workspaceBinding: { availability: 'available', workingDirectory: workspace },
      } : null,
    };
    try {
      const output = await new TaskOutputModule({
        homeDir: home, taskGraphService: tasks, limits: { maxPerTask: Number(maxPerTask) },
      }).create('task-a', { operationId, relativePath, title: relativePath });
      process.stdout.write(JSON.stringify({ kind: 'created', id: output.id }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ kind: 'error', name: error?.constructor?.name }));
    }
  `;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        script,
        input.home,
        input.workspace,
        input.relativePath,
        input.operationId,
        String(input.maxPerTask),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code, output, stderr }));
  });
}

test('two Station processes retain distinct promotions and enforce one shared per-Task limit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-task-output-process-home-'));
  const workspace = mkdtempSync(
    join(tmpdir(), 'station-task-output-process-workspace-'),
  );
  roots.push(home, workspace);
  writeFileSync(join(workspace, 'one.txt'), 'one');
  writeFileSync(join(workspace, 'two.txt'), 'two');

  const distinct = await Promise.all([
    promoteInChild({
      home,
      workspace,
      relativePath: 'one.txt',
      operationId: 'process-one',
      maxPerTask: 100,
    }),
    promoteInChild({
      home,
      workspace,
      relativePath: 'two.txt',
      operationId: 'process-two',
      maxPerTask: 100,
    }),
  ]);
  for (const result of distinct) expect(result.code, result.stderr).toBe(0);
  expect(distinct.map((result) => JSON.parse(result.output).kind)).toEqual([
    'created',
    'created',
  ]);
  await expect(
    new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraph(workspace) as any,
    }).list('task-a'),
  ).resolves.toHaveLength(2);

  const limitedHome = mkdtempSync(
    join(tmpdir(), 'station-task-output-limit-home-'),
  );
  roots.push(limitedHome);
  const limited = await Promise.all([
    promoteInChild({
      home: limitedHome,
      workspace,
      relativePath: 'one.txt',
      operationId: 'limited-one',
      maxPerTask: 1,
    }),
    promoteInChild({
      home: limitedHome,
      workspace,
      relativePath: 'two.txt',
      operationId: 'limited-two',
      maxPerTask: 1,
    }),
  ]);
  for (const result of limited) expect(result.code, result.stderr).toBe(0);
  const kinds = limited.map((result) => JSON.parse(result.output));
  expect(kinds.filter((result) => result.kind === 'created')).toHaveLength(1);
  expect(
    kinds.filter((result) => result.name === 'TaskOutputUnavailableError'),
  ).toHaveLength(1);
  await expect(
    new TaskOutputModule({
      homeDir: limitedHome,
      taskGraphService: taskGraph(workspace) as any,
      limits: { maxPerTask: 1 },
    }).list('task-a'),
  ).resolves.toHaveLength(1);
}, 120_000);
