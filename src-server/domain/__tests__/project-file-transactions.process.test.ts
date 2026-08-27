import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../file-storage-adapter.js';

const tempHomes: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const childStates = new WeakMap<
  ChildProcessWithoutNullStreams,
  {
    lines: string[];
    waiters: Array<{ prefix: string; resolve: (line: string) => void }>;
    exit: Promise<void>;
  }
>();

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'project-1',
    slug: 'acme',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-project-tx-'));
  tempHomes.push(home);
  return home;
}

function childProgram(home: string, pauseAfterLock: boolean): string {
  const adapterUrl = pathToFileURL(
    resolve('src-server/domain/file-storage-adapter.ts'),
  ).href;
  return `
    import { FileStorageAdapter } from ${JSON.stringify(adapterUrl)};
    let paused = false;
    const adapter = new FileStorageAdapter(${JSON.stringify(home)}, {
      afterLockAcquired: async () => {
        if (!${JSON.stringify(pauseAfterLock)} || paused) return;
        paused = true;
        process.stdout.write('locked\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
      },
    });
    try {
      await adapter.saveConversation({
        id: 'conversation-1',
        projectId: 'project-1',
        title: 'Conversation',
        agentSlug: 'station',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await new Promise(resolve => process.stdout.write('saved\\n', resolve));
      process.exit(0);
    } catch (error) {
      await new Promise(resolve => process.stdout.write(
        'refused:' + (error?.code ?? error?.message) + '\\n',
        resolve,
      ));
      process.exit(0);
    }
  `;
}

function spawnWriter(home: string, pauseAfterLock: boolean) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      childProgram(home, pauseAfterLock),
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  const lines: string[] = [];
  const waiters: Array<{ prefix: string; resolve: (line: string) => void }> =
    [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const complete = buffered.split('\n');
    buffered = complete.pop() ?? '';
    for (const line of complete) {
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (!line.startsWith(waiter.prefix)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  });
  const exit = new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveExit()
        : reject(new Error(`writer exited with status ${code}`)),
    );
  });
  childStates.set(child, { lines, waiters, exit });
  return child;
}

function waitForLine(child: ChildProcessWithoutNullStreams, prefix: string) {
  const state = childStates.get(child);
  if (!state) throw new Error('writer state is unavailable');
  const found = state.lines.find((line) => line.startsWith(prefix));
  if (found !== undefined) return Promise.resolve(found);
  return new Promise<string>((resolveLine) => {
    state.waiters.push({ prefix, resolve: resolveLine });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  const state = childStates.get(child);
  if (!state) throw new Error('writer state is unavailable');
  return state.exit;
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('project file transactions', () => {
  test('rejects stale updates and deletes without changing the newer Project', async () => {
    const home = tempHome();
    const adapter = new FileStorageAdapter(home);
    await adapter.createProject(project());

    const stale = adapter.projectRevision('acme');
    const current = adapter.projectRevision('acme');
    await current.replace({
      ...current.value,
      description: 'newer',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    await expect(
      stale.replace({ ...stale.value, description: 'stale' }),
    ).rejects.toMatchObject({ code: 'file_storage_conflict' });
    await expect(stale.remove()).rejects.toMatchObject({
      code: 'file_storage_conflict',
    });
    expect(adapter.getProject('acme').description).toBe('newer');
  });

  test('returns applied after exact post-commit readback for create, replace, and remove', async () => {
    const home = tempHome();
    let failPublish = true;
    let failRemove = true;
    const adapter = new FileStorageAdapter(home, {
      afterPublish: () => {
        if (!failPublish) return;
        failPublish = false;
        throw new Error('injected post-publish fault');
      },
      afterRemoveCommit: () => {
        if (!failRemove) return;
        failRemove = false;
        throw new Error('injected post-remove fault');
      },
    });

    await expect(adapter.createProject(project())).resolves.toBeUndefined();
    const revision = adapter.projectRevision('acme');
    failPublish = true;
    await expect(
      revision.replace({
        ...revision.value,
        description: 'committed',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
    expect(adapter.getProject('acme').description).toBe('committed');

    await expect(adapter.deleteProject('acme')).resolves.toBeUndefined();
    expect(() => adapter.getProject('acme')).toThrow(
      "Project 'acme' not found",
    );
  });

  test('joins one exact concurrent revision intent and rejects a different one', async () => {
    const home = tempHome();
    let gate = false;
    let publishCount = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new FileStorageAdapter(home, {
      afterLockAcquired: async () => {
        if (!gate) return;
        entered();
        await releasePromise;
      },
      afterPublish: () => {
        publishCount += 1;
      },
    });
    await adapter.createProject(project());
    const revision = adapter.projectRevision('acme');
    const next = {
      ...revision.value,
      description: 'one exact transition',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    gate = true;
    const first = revision.replace(next);
    await enteredPromise;
    const joined = revision.replace({ ...next });
    await expect(
      revision.replace({ ...next, description: 'different' }),
    ).rejects.toMatchObject({ code: 'file_storage_conflict' });
    release();
    await expect(Promise.all([first, joined])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(publishCount).toBe(2); // Project create plus one replacement.
    await expect(revision.replace({ ...next })).resolves.toBeUndefined();
    expect(publishCount).toBe(2);
  });

  test('a Project revision cannot create a Layout after the Project changes', async () => {
    const home = tempHome();
    const adapter = new FileStorageAdapter(home);
    await adapter.createProject(project());
    const stale = adapter.projectRevision('acme');
    const current = adapter.projectRevision('acme');
    await current.replace({
      ...current.value,
      agents: [],
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    await expect(
      stale.createLayout('coding', {
        id: 'layout-1',
        projectSlug: 'acme',
        slug: 'coding',
        type: 'coding',
        name: 'Coding',
        config: { availableAgents: ['alpha'] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'file_storage_conflict' });
    expect(adapter.listLayouts('acme')).toEqual([]);
  });

  test('serializes a real child record write before delete without resurrecting the Project', async () => {
    const home = tempHome();
    const adapter = new FileStorageAdapter(home);
    await adapter.createProject(project());
    const writer = spawnWriter(home, true);
    await waitForLine(writer, 'locked');

    const deletion = adapter.deleteProject('acme');
    writer.stdin.write('release\n');
    await waitForLine(writer, 'saved');
    await waitForExit(writer);
    await deletion;

    expect(existsSync(join(home, 'projects', 'acme'))).toBe(false);
  }, 15_000);

  test('refuses a real child record write ordered after Project deletion', async () => {
    const home = tempHome();
    let gate = false;
    let acquired!: () => void;
    let release!: () => void;
    const acquiredPromise = new Promise<void>((resolveAcquired) => {
      acquired = resolveAcquired;
    });
    const releasePromise = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const adapter = new FileStorageAdapter(home, {
      afterLockAcquired: async () => {
        if (!gate) return;
        acquired();
        await releasePromise;
      },
    });
    await adapter.createProject(project());
    gate = true;
    const deletion = adapter.deleteProject('acme');
    await acquiredPromise;

    const writer = spawnWriter(home, false);
    release();
    await deletion;
    expect(await waitForLine(writer, 'refused:')).toContain(
      'Project not found for id',
    );
    await waitForExit(writer);
    expect(existsSync(join(home, 'projects', 'acme'))).toBe(false);
  });

  test('rejects unknown persisted fields and treats only ENOENT as empty', async () => {
    const home = tempHome();
    const adapter = new FileStorageAdapter(home);
    await adapter.createProject(project());
    const path = join(home, 'projects', 'acme', 'project.json');
    writeFileSync(path, JSON.stringify({ ...project(), surprise: true }));
    expect(() => adapter.getProject('acme')).toThrow(
      'Project storage contains an invalid record',
    );

    writeFileSync(path, '{not-json', 'utf8');
    expect(() => adapter.listProjects()).toThrow();
    rmSync(path);
    expect(() => adapter.getProject('acme')).toThrow(
      "Project 'acme' not found",
    );
  });
});
