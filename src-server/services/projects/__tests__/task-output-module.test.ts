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
  let taskCreatedAt = '2026-10-01T00:00:00.000Z';
  const taskGraphService = {
    readTask: (taskId: string) =>
      taskId === 'task-a' && taskPresent
        ? {
            id: taskId,
            projectId: 'project-a',
            createdAt: taskCreatedAt,
          }
        : null,
    readTaskForOpen: async (taskId: string) =>
      taskId === 'task-a' && taskPresent
        ? {
            id: taskId,
            projectId: 'project-a',
            createdAt: taskCreatedAt,
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
    setTaskCreatedAt: (value: string) => {
      taskCreatedAt = value;
    },
    setTaskPresent: (present: boolean) => {
      taskPresent = present;
    },
    // Tests may vary only optional construction seams; this helper always
    // supplies the owned home and task graph used by the fixture.
    module: (options?: TaskOutputTestOptions) =>
      new TaskOutputModule({
        homeDir: home,
        taskGraphService,
        ...(options ?? {}),
      }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('TaskOutputModule', () => {
  test('new private provenance preserves the public v1 output shape', async () => {
    const { home, workspace, module } = fixture();
    const bytes = 'declared provenance bytes';
    writeFileSync(join(workspace, 'declared.txt'), bytes);
    const declaredBy = {
      sessionId: 'session-a',
      eventId: 'event-a',
      turnId: 'turn-a',
      toolCallId: 'call-a',
      declarationId: 'declaration-a',
    };
    const kept = await module().createDeclared('task-a', {
      operationId: 'private-source',
      title: 'Declared',
      sourceWorkspace: workspace,
      relativePath: 'declared.txt',
      digest: createHash('sha256').update(bytes).digest('hex'),
      length: Buffer.byteLength(bytes),
      fingerprintContext: 'session-a:event-a',
      declaredBy,
    });
    expect(kept.output.schemaVersion).toBe(1);
    expect(kept.output).not.toHaveProperty('taskCreatedAt');
    expect(kept.output).not.toHaveProperty('declaredBy');
    const store = JSON.parse(
      readFileSync(join(home, 'task-outputs', 'index.json'), 'utf8'),
    );
    expect(store.schemaVersion).toBe(2);
    expect(store.outputs[0]).toMatchObject({
      taskCreatedAt: '2026-10-01T00:00:00.000Z',
      declaredBy,
    });
    expect(
      (await module().readContent('task-a', kept.output.id)).bytes.toString(),
    ).toBe(bytes);
  });

  test('a recreated Task cannot read or replay a previous incarnation output after restart', async () => {
    const { workspace, module, setTaskCreatedAt } = fixture();
    writeFileSync(join(workspace, 'one.txt'), 'original');
    const input = {
      operationId: 'same-operation',
      relativePath: 'one.txt',
      title: 'Original',
    };
    const original = await module().create('task-a', input);
    setTaskCreatedAt('2026-10-01T01:00:00.000Z');
    const restarted = module();
    expect(await restarted.list('task-a')).toEqual([]);
    await expect(
      restarted.readContent('task-a', original.id),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
    await expect(restarted.create('task-a', input)).rejects.toBeInstanceOf(
      TaskOutputNotFoundError,
    );
    const fresh = await restarted.create('task-a', {
      ...input,
      operationId: 'new-operation',
    });
    expect(fresh.id).not.toBe(original.id);
    expect(
      (await restarted.readContent('task-a', fresh.id)).bytes.toString(),
    ).toBe('original');
  });

  test.each(['workspace', 'declared'] as const)(
    '%s output quota belongs to the current Task incarnation',
    async (kind) => {
      const { workspace, module, setTaskCreatedAt } = fixture();
      const bytes = 'one';
      writeFileSync(join(workspace, 'one.txt'), bytes);
      const create = async (operationId: string) => {
        const owner = module({ limits: { maxPerTask: 1 } });
        const input = { operationId, relativePath: 'one.txt', title: 'One' };
        if (kind === 'workspace') return owner.create('task-a', input);
        const kept = await owner.createDeclared('task-a', {
          ...input,
          sourceWorkspace: workspace,
          digest: createHash('sha256').update(bytes).digest('hex'),
          length: Buffer.byteLength(bytes),
          fingerprintContext: operationId,
        });
        return kept.output;
      };
      const original = await create('original');
      await expect(create('original-overflow')).rejects.toBeInstanceOf(
        TaskOutputUnavailableError,
      );
      setTaskCreatedAt('2026-10-01T01:00:00.000Z');
      expect(await module().list('task-a')).toEqual([]);
      const replacement = await create('replacement');
      expect(replacement.id).not.toBe(original.id);
      expect(await module().list('task-a')).toEqual([replacement]);
      await expect(create('replacement-overflow')).rejects.toBeInstanceOf(
        TaskOutputUnavailableError,
      );
      await expect(module().read('task-a', original.id)).rejects.toBeInstanceOf(
        TaskOutputNotFoundError,
      );
    },
  );

  test('deleted operation receipts remain tied to their original Task incarnation', async () => {
    const { home, workspace, module, setTaskCreatedAt } = fixture();
    writeFileSync(join(workspace, 'one.txt'), 'one');
    const input = {
      operationId: 'deleted-source',
      relativePath: 'one.txt',
      title: 'One',
    };
    const original = await module().create('task-a', input);
    await module().delete('task-a', original.id);
    const store = JSON.parse(
      readFileSync(join(home, 'task-outputs', 'index.json'), 'utf8'),
    );
    expect(store.deletedOperations[0].taskCreatedAt).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    setTaskCreatedAt('2026-10-01T01:00:00.000Z');
    await expect(module().create('task-a', input)).rejects.toBeInstanceOf(
      TaskOutputNotFoundError,
    );
    expect(await module().list('task-a')).toEqual([]);
  });

  test('legacy v1 bytes stay readable without manufacturing provenance', async () => {
    const { home, workspace, module } = fixture();
    writeFileSync(join(workspace, 'one.txt'), 'legacy bytes');
    const original = await module().create('task-a', {
      operationId: 'legacy-operation',
      relativePath: 'one.txt',
      title: 'Legacy',
    });
    const index = join(home, 'task-outputs', 'index.json');
    const store = JSON.parse(readFileSync(index, 'utf8'));
    store.schemaVersion = 1;
    delete store.outputs[0].taskCreatedAt;
    store.outputs[0].fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          relativePath: 'one.txt',
          title: 'Legacy',
          declaredMediaType: null,
        }),
      )
      .digest('hex');
    writeFileSync(index, JSON.stringify(store));
    expect(
      (await module().readContent('task-a', original.id)).bytes.toString(),
    ).toBe('legacy bytes');
    const retained = JSON.parse(readFileSync(index, 'utf8'));
    expect(retained.schemaVersion).toBe(1);
    expect(retained.outputs[0]).not.toHaveProperty('taskCreatedAt');
    await expect(
      module().create('task-a', {
        operationId: 'legacy-operation',
        relativePath: 'one.txt',
        title: 'Legacy',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
  });

  test('legacy deleted declaration receipts refuse the same candidate under a fresh operation', async () => {
    const { home, workspace, module } = fixture();
    const bytes = 'deleted legacy candidate';
    writeFileSync(join(workspace, 'declared.txt'), bytes);
    const input = {
      operationId: 'legacy-deleted',
      title: 'Declared',
      sourceWorkspace: workspace,
      relativePath: 'declared.txt',
      digest: createHash('sha256').update(bytes).digest('hex'),
      length: Buffer.byteLength(bytes),
      fingerprintContext: 'session-a:event-deleted',
    };
    const kept = await module().createDeclared('task-a', input);
    await module().delete('task-a', kept.output.id);
    const index = join(home, 'task-outputs', 'index.json');
    const legacy = JSON.parse(readFileSync(index, 'utf8'));
    legacy.schemaVersion = 1;
    delete legacy.deletedOperations[0].taskCreatedAt;
    writeFileSync(index, JSON.stringify(legacy));
    await expect(
      module().createDeclared('task-a', {
        ...input,
        operationId: 'fresh-operation',
      }),
    ).rejects.toBeInstanceOf(TaskOutputDeletedOperationError);
    expect(await module().list('task-a')).toEqual([]);
  });

  test('cascade refuses a Task that reappears while the output lock is acquired', async () => {
    const { home, workspace, module, setTaskPresent, setTaskCreatedAt } =
      fixture();
    writeFileSync(join(workspace, 'one.txt'), 'one');
    await module().create('task-a', {
      operationId: 'before-cascade',
      relativePath: 'one.txt',
      title: 'One',
    });
    setTaskPresent(false);
    const pending = module().deleteForTask('task-a');
    setTaskCreatedAt('2026-10-01T01:00:00.000Z');
    setTaskPresent(true);
    await expect(pending).rejects.toBeInstanceOf(TaskOutputUnavailableError);
    const retained = JSON.parse(
      readFileSync(join(home, 'task-outputs', 'index.json'), 'utf8'),
    );
    expect(retained.outputs).toHaveLength(1);
  });

  test('Task replacement during descriptor read refuses publication', async () => {
    const { workspace, module, setTaskCreatedAt } = fixture();
    writeFileSync(join(workspace, 'one.txt'), 'one');
    const owner = module({
      sourceSnapshotPort: {
        noFollow: fsConstants.O_NOFOLLOW,
        observe: (stage) => {
          if (stage === 'after-read')
            setTaskCreatedAt('2026-10-01T01:00:00.000Z');
        },
      },
    });
    await expect(
      owner.create('task-a', {
        operationId: 'changed-scope',
        relativePath: 'one.txt',
        title: 'One',
      }),
    ).rejects.toBeInstanceOf(TaskOutputNotFoundError);
    expect(await module().list('task-a')).toEqual([]);
  });

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
      taskGraphService,
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
      taskGraphService,
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
      taskGraphService,
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
          ? {
              id: taskId,
              projectId: `project-${taskId}`,
              createdAt: '2026-10-01T00:00:00.000Z',
            }
          : null,
      readTaskForOpen: async (taskId: string) =>
        (taskId === 'task-a' && taskAPresent) || taskId === 'task-b'
          ? {
              id: taskId,
              projectId: `project-${taskId}`,
              createdAt: '2026-10-01T00:00:00.000Z',
              workspaceBinding: {
                availability: 'available' as const,
                workingDirectory: workspace,
              },
            }
          : null,
    };
    const bounded = new TaskOutputModule({
      homeDir: home,
      taskGraphService,
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
      taskGraphService,
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
        taskGraphService,
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
        taskGraphService,
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
      taskGraphService,
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
      taskGraphService,
    }).reconcile();
    expect(() => readFileSync(blob)).toThrow();
  });
});

test('feedback target admission binds immutable digest, Project and Task incarnation and refuses deletion', async () => {
  const f = fixture();
  const outputs = f.module();
  writeFileSync(join(f.workspace, 'review.txt'), 'exact version');
  const output = await outputs.create('task-a', {
    operationId: 'review-output',
    relativePath: 'review.txt',
    title: 'Review',
  });
  const scope = { projectId: 'project-a', taskId: 'task-a' };
  const target = {
    outputId: output.id,
    digest: output.materialization.digest,
    taskCreatedAt: '2026-10-01T00:00:00.000Z',
  };
  expect(await outputs.validateFeedbackTarget(scope, target)).toBe('admitted');
  expect(
    await outputs.validateFeedbackTarget(scope, {
      ...target,
      digest: `sha256:${'b'.repeat(64)}`,
    }),
  ).toBe('denied');
  expect(
    await outputs.validateFeedbackTarget(
      { ...scope, projectId: 'other' },
      target,
    ),
  ).toBe('denied');
  expect(
    await outputs.validateFeedbackTarget(scope, {
      ...target,
      taskCreatedAt: '2026-10-02T00:00:00.000Z',
    }),
  ).toBe('denied');
  await outputs.delete('task-a', output.id);
  expect(await outputs.validateFeedbackTarget(scope, target)).toBe('denied');
  f.setTaskCreatedAt('2026-10-03T00:00:00.000Z');
  expect(await outputs.validateFeedbackTarget(scope, target)).toBe('denied');
});
