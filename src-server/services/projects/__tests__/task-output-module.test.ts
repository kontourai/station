import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  TaskOutputConflictError,
  TaskOutputDeletedOperationError,
  TaskOutputModule,
  TaskOutputNotFoundError,
  TaskOutputUnavailableError,
} from '../task-output-module.js';

const directories: string[] = [];
type TaskOutputTestOptions = Omit<
  ConstructorParameters<typeof TaskOutputModule>[0],
  'homeDir' | 'taskGraphService'
>;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-task-output-home-'));
  const workspace = mkdtempSync(
    join(tmpdir(), 'station-task-output-workspace-'),
  );
  directories.push(home, workspace);
  let taskPresent = true;
  const taskGraphService = {
    readTask: (taskId: string) =>
      taskId === 'task-a' && taskPresent
        ? { id: taskId, projectId: 'project-a' }
        : null,
    readTaskForOpen: async (taskId: string) =>
      taskId === 'task-a' && taskPresent
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
  return {
    home,
    workspace,
    taskGraphService,
    setTaskPresent: (present: boolean) => {
      taskPresent = present;
    },
    // Tests may vary only optional construction seams; this helper always
    // supplies the owned home and task graph used by the fixture.
    module: (options?: TaskOutputTestOptions) =>
      new TaskOutputModule({
        homeDir: home,
        taskGraphService: taskGraphService as any,
        ...(options ?? {}),
      }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('TaskOutputModule', () => {
  test('publishes declared bytes only when the descriptor digest and length match the same read', async () => {
    const { workspace, module } = fixture();
    writeFileSync(join(workspace, 'declared.txt'), 'declared bytes');
    const digest = createHash('sha256').update('declared bytes').digest('hex');
    const kept = await module().createDeclared('task-a', {
      operationId: 'declared-1',
      title: 'Declared',
      sourceWorkspace: workspace,
      relativePath: 'declared.txt',
      digest,
      length: Buffer.byteLength('declared bytes'),
      fingerprintContext: 'session-a:event-a',
    });
    writeFileSync(join(workspace, 'declared.txt'), 'replacement');
    expect(
      (await module().readContent('task-a', kept.output.id)).bytes.toString(),
    ).toBe('declared bytes');
    await expect(
      module().createDeclared('task-a', {
        operationId: 'declared-2',
        title: 'Replacement',
        sourceWorkspace: workspace,
        relativePath: 'declared.txt',
        digest,
        length: Buffer.byteLength('declared bytes'),
        fingerprintContext: 'session-a:event-b',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
  });

  test('rechecks authorization after descriptor acquisition before publishing any output', async () => {
    const { workspace, module } = fixture();
    writeFileSync(join(workspace, 'declared.txt'), 'declared bytes');
    let current = true;
    await expect(
      module({
        sourceSnapshotPort: {
          noFollow: fsConstants.O_NOFOLLOW,
          observe: (stage) => {
            if (stage === 'after-read') current = false;
          },
        },
      }).createDeclared('task-a', {
        operationId: 'declared-revoked',
        title: 'Declared',
        sourceWorkspace: workspace,
        relativePath: 'declared.txt',
        digest: createHash('sha256').update('declared bytes').digest('hex'),
        length: Buffer.byteLength('declared bytes'),
        fingerprintContext: 'session-a:event-a',
        isAuthorized: () => current,
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
    await expect(module().list('task-a')).resolves.toEqual([]);
  });

  test('rejects a reused operation before a different target can deduplicate', async () => {
    const { workspace, module } = fixture();
    writeFileSync(join(workspace, 'a.txt'), 'A');
    writeFileSync(join(workspace, 'b.txt'), 'B');
    const keep = (operationId: string, path: string, bytes: string) =>
      module().createDeclared('task-a', {
        operationId,
        title: path,
        sourceWorkspace: workspace,
        relativePath: path,
        digest: createHash('sha256').update(bytes).digest('hex'),
        length: Buffer.byteLength(bytes),
        fingerprintContext: `session-a:${path}`,
      });
    await keep('operation-a', 'a.txt', 'A');
    await keep('operation-b', 'b.txt', 'B');
    await expect(keep('operation-a', 'b.txt', 'B')).rejects.toBeInstanceOf(
      TaskOutputConflictError,
    );
  });

  test('promotes immutable bytes through restart and idempotent operation identity', async () => {
    const { workspace, module } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'first bytes');
    const first = await module().create('task-a', {
      operationId: 'operation-1',
      relativePath: 'report.txt',
      title: 'Report',
    });
    writeFileSync(join(workspace, 'report.txt'), 'changed bytes');
    const restarted = module();
    const content = await restarted.readContent('task-a', first.id);
    expect(content.bytes.toString()).toBe('first bytes');
    expect(content.output.materialization.digest).toMatch(/^sha256:/);
    const retry = await restarted.create('task-a', {
      operationId: 'operation-1',
      relativePath: 'report.txt',
      title: 'Report',
    });
    expect(retry.id).toBe(first.id);
    await expect(
      restarted.create('task-a', {
        operationId: 'operation-1',
        relativePath: 'report.txt',
        title: 'Different',
      }),
    ).rejects.toBeInstanceOf(TaskOutputConflictError);
    const changed = await restarted.create('task-a', {
      operationId: 'operation-2',
      relativePath: 'report.txt',
      title: 'Changed report',
    });
    expect(changed.materialization.digest).not.toBe(
      first.materialization.digest,
    );
  });

  test('refuses traversal and symlink sources without snapshotting bytes', async () => {
    const { workspace, module } = fixture();
    writeFileSync(join(workspace, 'safe.txt'), 'safe');
    writeFileSync(join(workspace, 'outside.txt'), 'outside');
    symlinkSync(join(workspace, 'outside.txt'), join(workspace, 'linked.txt'));
    mkdirSync(join(workspace, 'outside-dir'));
    writeFileSync(join(workspace, 'outside-dir', 'report.txt'), 'outside');
    symlinkSync(
      join(workspace, 'outside-dir'),
      join(workspace, 'linked-directory'),
    );
    mkdirSync(join(workspace, 'directory-source'));
    for (const relativePath of [
      '../outside.txt',
      '/etc/passwd',
      'linked.txt',
      'linked-directory/report.txt',
      'directory-source',
    ]) {
      await expect(
        module().create('task-a', {
          operationId: `operation-${relativePath.replace(/[^a-z]/g, '') || 'x'}`,
          relativePath,
          title: 'Unsafe',
        }),
      ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
    }
    await expect(module().list('task-a')).resolves.toEqual([]);
  });

  test('rehashes content, fails closed on corruption, and tombstones deletion', async () => {
    const { home, workspace, module } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'immutable');
    const output = await module().create('task-a', {
      operationId: 'operation-delete',
      relativePath: 'report.txt',
      title: 'Report',
    });
    const digest = output.materialization.digest.slice('sha256:'.length);
    writeFileSync(join(home, 'task-outputs', 'snapshots', digest), 'tampered');
    await expect(
      module().readContent('task-a', output.id),
    ).rejects.toBeInstanceOf(TaskOutputUnavailableError);
    await module().delete('task-a', output.id);
    await expect(module().read('task-a', output.id)).rejects.toThrow(
      'Task output not found',
    );
    await expect(
      module().create('task-a', {
        operationId: 'operation-delete',
        relativePath: 'report.txt',
        title: 'Report',
      }),
    ).rejects.toBeInstanceOf(TaskOutputDeletedOperationError);
    await expect(
      module().create('task-a', {
        operationId: 'operation-delete',
        relativePath: 'report.txt',
        title: 'Changed intent',
      }),
    ).rejects.toBeInstanceOf(TaskOutputConflictError);
  });

  test('retained output reads survive a later unavailable source workspace', async () => {
    const { workspace, module } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'retained');
    const output = await module().create('task-a', {
      operationId: 'operation-retained',
      relativePath: 'report.txt',
      title: 'Retained',
    });
    unlinkSync(join(workspace, 'report.txt'));
    await expect(module().list('task-a')).resolves.toHaveLength(1);
    await expect(
      module().readContent('task-a', output.id),
    ).resolves.toMatchObject({ bytes: Buffer.from('retained') });
  });

  test('fails closed before any personal-home read when hosted storage is unavailable', async () => {
    const { home, taskGraphService } = fixture();
    const hosted = new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraphService as any,
      hosted: () => true,
    });
    await expect(hosted.list('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );
  });

  test('cascades all Task outputs after TaskGraph deletion without a public route', async () => {
    const { home, workspace, module, setTaskPresent } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'cascade');
    await module().create('task-a', {
      operationId: 'operation-cascade',
      relativePath: 'report.txt',
      title: 'Cascade',
    });
    await expect(module().deleteForTask('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );
    setTaskPresent(false);
    await module().deleteForTask('task-a');
    const restarted = module();
    await restarted.deleteForTask('task-a');
    const store = JSON.parse(
      readFileSync(join(home, 'task-outputs', 'index.json'), 'utf8'),
    );
    expect(store.outputs).toEqual([]);
    expect(store.deletedOperations).toEqual([]);
    expect(store.tombstones).toEqual([]);
  });

  test('rejects oversized, malformed, unknown, duplicate, and noncanonical persisted indexes', async () => {
    const { home, workspace, module } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'persistent');
    await module().create('task-a', {
      operationId: 'operation-index',
      relativePath: 'report.txt',
      title: 'Persistent',
    });
    const index = join(home, 'task-outputs', 'index.json');
    const valid = readFileSync(index, 'utf8');
    const mutations: Array<(value: any) => unknown> = [
      (value) => ({ ...value, unknown: true }),
      (value) => ({ ...value, outputs: [...value.outputs, value.outputs[0]] }),
      (value) => ({
        ...value,
        outputs: [
          { ...value.outputs[0], id: value.outputs[0].id.toUpperCase() },
        ],
      }),
      (value) => ({
        ...value,
        outputs: [
          {
            ...value.outputs[0],
            source: {
              ...value.outputs[0].source,
              relativePath: 'folder\\report.txt',
            },
          },
        ],
      }),
    ];
    for (const mutate of mutations) {
      writeFileSync(index, JSON.stringify(mutate(JSON.parse(valid))));
      await expect(module().list('task-a')).rejects.toBeInstanceOf(
        TaskOutputUnavailableError,
      );
    }
    writeFileSync(index, 'x'.repeat(1024 * 1024 + 1));
    await expect(module().list('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );
  });

  test('refuses symlink and nonregular owned storage components', async () => {
    const first = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'station-task-output-outside-'));
    directories.push(outside);
    symlinkSync(outside, join(first.home, 'task-outputs'));
    await expect(first.module().list('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );

    const second = fixture();
    mkdirSync(join(second.home, 'task-outputs'), { recursive: true });
    mkdirSync(join(second.home, 'task-outputs', 'index.json'));
    await expect(second.module().list('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );

    const third = fixture();
    writeFileSync(join(third.workspace, 'report.txt'), 'blob');
    const output = await third.module().create('task-a', {
      operationId: 'operation-storage-link',
      relativePath: 'report.txt',
      title: 'Blob',
    });
    const blob = join(
      third.home,
      'task-outputs',
      'snapshots',
      output.materialization.digest.slice('sha256:'.length),
    );
    unlinkSync(blob);
    symlinkSync(join(third.workspace, 'report.txt'), blob);
    await expect(third.module().list('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );
  });

  test('reconciliation projects missing or corrupt content as unavailable without deleting the record', async () => {
    const { home, workspace, module } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'snapshot');
    const output = await module().create('task-a', {
      operationId: 'operation-reconcile',
      relativePath: 'report.txt',
      title: 'Snapshot',
    });
    const blob = join(
      home,
      'task-outputs',
      'snapshots',
      output.materialization.digest.slice('sha256:'.length),
    );
    unlinkSync(blob);
    const missing = await module().list('task-a');
    expect(missing[0]?.materialization.contentAvailable).toBe(false);
    await expect(
      module().readContent('task-a', output.id),
    ).rejects.toBeInstanceOf(TaskOutputUnavailableError);

    writeFileSync(blob, 'corrupt');
    const corrupt = await module().list('task-a');
    expect(corrupt[0]?.materialization.contentAvailable).toBe(false);
  });

  test('accounts only verified unique snapshots against the home quota', async () => {
    const { workspace, taskGraphService } = fixture();
    const quotaHome = mkdtempSync(join(tmpdir(), 'station-task-output-quota-'));
    directories.push(quotaHome);
    const bounded = new TaskOutputModule({
      homeDir: quotaHome,
      taskGraphService: taskGraphService as any,
      limits: { maxBytes: 4, maxHomeBytes: 4 },
    });
    writeFileSync(join(workspace, 'one.txt'), 'same');
    writeFileSync(join(workspace, 'two.txt'), 'next');
    await bounded.create('task-a', {
      operationId: 'quota-one',
      relativePath: 'one.txt',
      title: 'One',
    });
    await bounded.create('task-a', {
      operationId: 'quota-two',
      relativePath: 'one.txt',
      title: 'Two',
    });
    await expect(
      bounded.create('task-a', {
        operationId: 'quota-three',
        relativePath: 'two.txt',
        title: 'Three',
      }),
    ).rejects.toBeInstanceOf(TaskOutputUnavailableError);
  });

  test('a restart durably removes an unreferenced valid crash orphan', async () => {
    const { home, workspace, module } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'owned');
    await module().create('task-a', {
      operationId: 'operation-orphan',
      relativePath: 'report.txt',
      title: 'Owned',
    });
    const orphan = Buffer.from('orphan');
    const digest = createHash('sha256').update(orphan).digest('hex');
    const path = join(home, 'task-outputs', 'snapshots', digest);
    writeFileSync(path, orphan);
    await module().reconcile();
    await expect(module().list('task-a')).resolves.toHaveLength(1);
    expect(() => readFileSync(path)).toThrow();
  });

  test('reserves deletion identities at creation so every accepted output remains deletable', async () => {
    const { home, workspace, taskGraphService } = fixture();
    const bounded = new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraphService as any,
      limits: { maxDeletedOperations: 2, maxTombstones: 2 },
    });
    const outputs = [];
    for (const name of ['one.txt', 'two.txt']) {
      writeFileSync(join(workspace, name), name);
      outputs.push(
        await bounded.create('task-a', {
          operationId: `receipt-${name}`,
          relativePath: name,
          title: name,
        }),
      );
    }
    writeFileSync(join(workspace, 'three.txt'), 'three.txt');
    await expect(
      bounded.create('task-a', {
        operationId: 'receipt-three.txt',
        relativePath: 'three.txt',
        title: 'three.txt',
      }),
    ).rejects.toBeInstanceOf(TaskOutputUnavailableError);
    await bounded.delete('task-a', outputs[0]!.id);
    await bounded.delete('task-a', outputs[1]!.id);
    await expect(
      bounded.create('task-a', {
        operationId: 'receipt-one.txt',
        relativePath: 'one.txt',
        title: 'one.txt',
      }),
    ).rejects.toBeInstanceOf(TaskOutputDeletedOperationError);
  });

  test('TaskGraph-confirmed cascade clears identity reservations for another Task', async () => {
    const home = mkdtempSync(
      join(tmpdir(), 'station-task-output-cascade-home-'),
    );
    const workspace = mkdtempSync(
      join(tmpdir(), 'station-task-output-cascade-workspace-'),
    );
    directories.push(home, workspace);
    let taskAPresent = true;
    const taskGraphService = {
      readTask: (taskId: string) =>
        (taskId === 'task-a' && taskAPresent) || taskId === 'task-b'
          ? { id: taskId, projectId: `project-${taskId}` }
          : null,
      readTaskForOpen: async (taskId: string) =>
        (taskId === 'task-a' && taskAPresent) || taskId === 'task-b'
          ? {
              id: taskId,
              projectId: `project-${taskId}`,
              workspaceBinding: {
                availability: 'available' as const,
                workingDirectory: workspace,
              },
            }
          : null,
    };
    const bounded = new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraphService as any,
      limits: { maxDeletedOperations: 1, maxTombstones: 1 },
    });
    writeFileSync(join(workspace, 'one.txt'), 'one');
    writeFileSync(join(workspace, 'two.txt'), 'two');
    const first = await bounded.create('task-a', {
      operationId: 'cascade-one',
      relativePath: 'one.txt',
      title: 'One',
    });
    await expect(
      bounded.create('task-b', {
        operationId: 'cascade-two',
        relativePath: 'two.txt',
        title: 'Two',
      }),
    ).rejects.toBeInstanceOf(TaskOutputUnavailableError);
    await expect(bounded.deleteForTask('task-a')).rejects.toBeInstanceOf(
      TaskOutputUnavailableError,
    );
    await bounded.delete('task-a', first.id);
    taskAPresent = false;
    await bounded.deleteForTask('task-a');
    await new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraphService as any,
      limits: { maxDeletedOperations: 1, maxTombstones: 1 },
    }).reconcile();
    const second = await bounded.create('task-b', {
      operationId: 'cascade-two',
      relativePath: 'two.txt',
      title: 'Two',
    });
    await expect(
      bounded.readContent('task-b', second.id),
    ).resolves.toMatchObject({
      bytes: Buffer.from('two'),
    });
  });

  test('refuses final and intermediate source replacements after opening the descriptor', async () => {
    const { home, workspace, taskGraphService } = fixture();
    const module = (
      observe: (stage: 'after-open' | 'after-read', path: string) => void,
    ) =>
      new TaskOutputModule({
        homeDir: home,
        taskGraphService: taskGraphService as any,
        sourceSnapshotPort: { noFollow: fsConstants.O_NOFOLLOW, observe },
      });
    writeFileSync(join(workspace, 'report.txt'), 'original');
    await expect(
      module((stage, path) => {
        if (stage !== 'after-read') return;
        renameSync(path, `${path}.replaced`);
        writeFileSync(path, 'replacement');
      }).create('task-a', {
        operationId: 'race-final',
        relativePath: 'report.txt',
        title: 'Final race',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);

    mkdirSync(join(workspace, 'nested'));
    writeFileSync(join(workspace, 'nested', 'report.txt'), 'original nested');
    await expect(
      module((stage) => {
        if (stage !== 'after-read') return;
        const nested = join(workspace, 'nested');
        renameSync(nested, `${nested}.replaced`);
        mkdirSync(nested);
        writeFileSync(join(nested, 'report.txt'), 'replacement nested');
      }).create('task-a', {
        operationId: 'race-intermediate',
        relativePath: 'nested/report.txt',
        title: 'Intermediate race',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
  });

  test('uses descriptor and full-path identity checks when O_NOFOLLOW is unavailable', async () => {
    const { home, workspace, taskGraphService } = fixture();
    const module = (
      observe?: (stage: 'after-open' | 'after-read', path: string) => void,
    ) =>
      new TaskOutputModule({
        homeDir: home,
        taskGraphService: taskGraphService as any,
        sourceSnapshotPort: { noFollow: undefined, observe },
      });
    writeFileSync(join(workspace, 'report.txt'), 'source');
    await expect(
      module().create('task-a', {
        operationId: 'no-no-follow-valid',
        relativePath: 'report.txt',
        title: 'Source',
      }),
    ).resolves.toMatchObject({ source: { relativePath: 'report.txt' } });

    writeFileSync(join(workspace, 'outside.txt'), 'outside');
    symlinkSync(join(workspace, 'outside.txt'), join(workspace, 'linked.txt'));
    mkdirSync(join(workspace, 'outside-directory'));
    writeFileSync(
      join(workspace, 'outside-directory', 'report.txt'),
      'outside',
    );
    symlinkSync(
      join(workspace, 'outside-directory'),
      join(workspace, 'linked-directory'),
    );
    await expect(
      module().create('task-a', {
        operationId: 'no-no-follow-link',
        relativePath: 'linked.txt',
        title: 'Link',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
    await expect(
      module().create('task-a', {
        operationId: 'no-no-follow-intermediate-link',
        relativePath: 'linked-directory/report.txt',
        title: 'Intermediate link',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);

    writeFileSync(join(workspace, 'race.txt'), 'race');
    await expect(
      module((stage, path) => {
        if (stage !== 'after-read') return;
        renameSync(path, `${path}.old`);
        writeFileSync(path, 'replacement');
      }).create('task-a', {
        operationId: 'no-no-follow-final-race',
        relativePath: 'race.txt',
        title: 'Final race',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);

    mkdirSync(join(workspace, 'race-directory'));
    writeFileSync(join(workspace, 'race-directory', 'report.txt'), 'race');
    await expect(
      module((stage) => {
        if (stage !== 'after-read') return;
        const directory = join(workspace, 'race-directory');
        renameSync(directory, `${directory}.old`);
        mkdirSync(directory);
        writeFileSync(join(directory, 'report.txt'), 'replacement');
      }).create('task-a', {
        operationId: 'no-no-follow-intermediate-race',
        relativePath: 'race-directory/report.txt',
        title: 'Intermediate race',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
  });

  test('does not turn a committed deletion into an error when reclamation fails', async () => {
    const { home, workspace, taskGraphService } = fixture();
    writeFileSync(join(workspace, 'report.txt'), 'cleanup');
    let cleanupCalls = 0;
    const module = new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraphService as any,
      afterDeleteCommitCleanup: () => {
        cleanupCalls += 1;
        throw new Error('injected cleanup failure');
      },
    });
    const output = await module.create('task-a', {
      operationId: 'cleanup-failure',
      relativePath: 'report.txt',
      title: 'Cleanup',
    });
    const blob = join(
      home,
      'task-outputs',
      'snapshots',
      output.materialization.digest.slice('sha256:'.length),
    );
    await expect(module.delete('task-a', output.id)).resolves.toBeUndefined();
    expect(cleanupCalls).toBe(1);
    expect(() => readFileSync(blob)).not.toThrow();
    await expect(module.read('task-a', output.id)).rejects.toBeInstanceOf(
      TaskOutputNotFoundError,
    );
    await expect(module.delete('task-a', output.id)).rejects.toBeInstanceOf(
      TaskOutputNotFoundError,
    );
    await new TaskOutputModule({
      homeDir: home,
      taskGraphService: taskGraphService as any,
    }).reconcile();
    expect(() => readFileSync(blob)).toThrow();
  });
});
