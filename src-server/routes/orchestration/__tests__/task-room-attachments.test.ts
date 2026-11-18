import { once } from 'node:events';
import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, expect, test, vi } from 'vitest';
import {
  appendProjectTaskRoomHumanMessage,
  fetchProjectTaskRoomHistory,
  fetchTaskRoomAttachment,
  uploadTaskRoomAttachments,
} from '../../../../packages/sdk/src/client/project-task-rooms.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { attachmentBlobRefFor } from '../../../services/orchestration/attachment-blob-store.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../../services/orchestration/project-task-room-runtime.js';
import { TaskRoomAttachments } from '../../../services/projects/task-room-attachments.js';
import { createProjectTaskRoomRoutes } from '../project-task-rooms.js';

const makeTempDir = trackTempDirs();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const image: ChatAttachmentInput = {
  kind: 'image',
  name: 'screen.png',
  mimeType: 'image/png',
  size: 8,
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
};

test('Task attachment transport preserves history and bytes across restart and enforces current Task authority', async () => {
  const root = makeTempDir('task-attachments-');
  vi.stubEnv('STATION_ATTACHMENT_MAX_BYTES', '19');
  vi.stubEnv('STATION_ATTACHMENT_RETENTION_DAYS', '90');
  const task: TaskRecord = {
    id: 'task',
    projectId: 'project',
    title: 'Screenshots',
    description: '',
    priority: 'normal',
    status: 'ready',
    createdBy: 'alice',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const createdAt = task.createdAt;
  let revoked = false;
  const start = () => {
    const store = new EventStore(join(root, 'events.sqlite'));
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: (id) =>
          id === task.id ? task : id === 'other' ? { ...task, id } : null,
      },
      projectForId: (id) =>
        id === task.projectId ? { id, slug: 'project' } : undefined,
      history: (authority) =>
        store.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
        }),
      working: store.createProjectTaskRoomWorkingState(),
      attachments: new TaskRoomAttachments(join(root, 'assets')),
      requestAuthority: {
        resolve: async () =>
          revoked
            ? { kind: 'revoked' }
            : {
                kind: 'granted',
                operatorId: 'alice',
                deviceId: 'device',
                policyRevision: 'test',
              },
      },
    });
    const app = createProjectTaskRoomRoutes(runtime);
    vi.stubGlobal(
      'fetch',
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        return app.request(
          new Request(
            `http://station${url.pathname.replace('/api/tasks', '')}${url.search}`,
            request,
          ),
        );
      },
    );
    return { store, runtime };
  };
  let instance = start();
  const opts = { authentication: 'omit' as const };
  try {
    await instance.runtime.discover({
      taskId: task.id,
      request: new Request('http://station'),
    });
    const attachments = await uploadTaskRoomAttachments(
      'http://station',
      task.id,
      createdAt,
      [image],
      opts,
    );
    expect(attachments).toEqual([
      {
        id: expect.any(String),
        kind: 'image',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 8,
      },
    ]);
    const sent = await appendProjectTaskRoomHumanMessage(
      'http://station',
      {
        taskId: task.id,
        proposalId: 'screenshot',
        text: 'Look here',
        occurredAt: createdAt,
        expectedTaskCreatedAt: createdAt,
        attachments,
      },
      opts,
    );
    expect(sent.kind).toBe('committed');
    const blobPath = (bytes: Buffer) => {
      const digest = attachmentBlobRefFor(bytes).slice('sha256-'.length);
      return join(root, 'assets', 'blobs', digest.slice(0, 2), digest);
    };
    const live = blobPath(Buffer.from('iVBORw0KGgo=', 'base64'));
    const seedOrphan = async (bytes: Buffer, timestamp: Date) => {
      const path = blobPath(bytes);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      await utimes(path, timestamp, timestamp);
      return path;
    };
    const day = 86_400_000;
    const now = Date.now();
    const old = new Date(now - 91 * day);
    const expiredOrphan = await seedOrphan(Buffer.from('age'), old);
    await utimes(live, old, old);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + day);
    // The age sweep runs below the byte cap. Existing content is still readable.
    const read = () =>
      fetchTaskRoomAttachment(
        'http://station',
        task.id,
        createdAt,
        attachments[0].id,
        opts,
      );
    const upload = (...inputs: ChatAttachmentInput[]) =>
      uploadTaskRoomAttachments(
        'http://station',
        task.id,
        createdAt,
        inputs,
        opts,
      );
    const variant: ChatAttachmentInput = {
      ...image,
      name: 'variant.png',
      size: 9,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoh',
    };
    await expect(upload(variant)).resolves.toHaveLength(1);
    await expect(stat(expiredOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await read()).status).toBe(200);

    // A fresh orphan puts the store over the cap. Reclaim it even though
    // a live blob has the older timestamp and is outside the incoming batch.
    const freshOrphan = await seedOrphan(
      Buffer.from('size'),
      new Date(now + day),
    );
    await utimes(live, old, old);
    await expect(upload(variant)).resolves.toHaveLength(1);
    await expect(stat(freshOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await read()).status).toBe(200);
    const fill: ChatAttachmentInput = {
      kind: 'file',
      name: 'fill.txt',
      mimeType: 'text/plain',
      size: 2,
      dataUrl: 'data:text/plain;base64,b2s=',
    };
    const other: ChatAttachmentInput = {
      ...fill,
      name: 'other.txt',
      dataUrl: 'data:text/plain;base64,bm8=',
    };
    const bindings = join(root, 'assets', 'bindings');
    const [binding] = await readdir(bindings);
    const directory = join(bindings, binding!);
    const records = (await readdir(directory)).sort();
    // Only the first file would fit. The rejected batch must publish neither.
    await expect(upload(fill, other)).rejects.toThrow(
      'Task-room attachment store has reached its size limit',
    );
    expect((await readdir(directory)).sort()).toEqual(records);
    for (const bytes of ['ok', 'no'])
      await expect(stat(blobPath(Buffer.from(bytes)))).rejects.toMatchObject({
        code: 'ENOENT',
      });

    // With an unknown reference, the store cannot safely reclaim under pressure.
    const unclassified = await seedOrphan(
      Buffer.from('size'),
      new Date(now + day),
    );
    const damaged = join(directory, 'damaged.json');
    await writeFile(damaged, '{');
    await expect(upload(fill)).rejects.toThrow(
      'Task-room attachment store has reached its size limit',
    );
    expect((await stat(unclassified)).isFile()).toBe(true);
    await rm(damaged);
    await expect(upload(fill)).resolves.toHaveLength(1);
    await expect(stat(unclassified)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(upload(image)).resolves.toHaveLength(1);
    clock.mockRestore();

    await instance.runtime.close();
    instance.store.close();
    instance = start();
    const history = await fetchProjectTaskRoomHistory(
      'http://station',
      task.id,
      undefined,
      opts,
    );
    expect(history).toMatchObject({
      kind: 'available',
      records: [
        { body: { kind: 'human-message', text: 'Look here', attachments } },
      ],
    });
    const probe = new DatabaseSync(join(root, 'events.sqlite'));
    // Reproduce the reopened runtime worker's independent startup write lock.
    const writer = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData);
       db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, 250);`,
      { eval: true, workerData: join(root, 'events.sqlite') },
    );
    try {
      expect(await once(writer, 'message')).toEqual(['locked']);
      // Reach the format fence after bounded contention, rather than SQLITE_BUSY.
      probe.exec('PRAGMA busy_timeout = 5000');
      const row = probe
        .prepare('SELECT * FROM project_task_room_records LIMIT 1')
        .get();
      if (!row || typeof row.record_json !== 'string')
        throw new Error('Stored image record missing');
      expect(JSON.parse(row.record_json).schemaVersion).toBe(
        'station.project-task-room/v4',
      );
      expect(() =>
        probe
          .prepare(
            "INSERT INTO project_task_room_records SELECT channel_id,epoch,seq+1,'old-writer',proposal_digest,envelope_digest,checkpoint_digest,json_set(record_json,'$.schemaVersion','station.project-task-room/v3'),record_bytes FROM project_task_room_records LIMIT 1",
          )
          .run(),
      ).toThrow('room requires v4 writer');
    } finally {
      probe.close();
      await writer.terminate();
    }
    const response = await read();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(
      'iVBORw0KGgo=',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(
      (
        await fetchTaskRoomAttachment(
          'http://station',
          'other',
          createdAt,
          attachments[0].id,
          opts,
        )
      ).status,
    ).toBe(404);
    await expect(
      appendProjectTaskRoomHumanMessage(
        'http://station',
        {
          taskId: task.id,
          proposalId: 'forged',
          text: 'Forged',
          expectedTaskCreatedAt: createdAt,
          attachments: [{ ...attachments[0], name: 'different.png' }],
        },
        opts,
      ),
    ).rejects.toThrow();
    revoked = true;
    expect((await read()).status).toBe(404);
    await expect(
      uploadTaskRoomAttachments(
        'http://station',
        task.id,
        createdAt,
        [image],
        opts,
      ),
    ).rejects.toThrow();
    revoked = false;
    await rm(join(root, 'assets', 'blobs'), { recursive: true });
    expect((await read()).status).toBe(404);
    await expect(
      appendProjectTaskRoomHumanMessage(
        'http://station',
        {
          taskId: task.id,
          proposalId: 'screenshot',
          text: 'Look here',
          occurredAt: createdAt,
          expectedTaskCreatedAt: createdAt,
          attachments,
        },
        opts,
      ),
    ).resolves.toMatchObject({ kind: 'duplicate' });
    await expect(
      appendProjectTaskRoomHumanMessage(
        'http://station',
        {
          taskId: task.id,
          proposalId: 'missing-file-fresh-message',
          text: 'Look here',
          occurredAt: createdAt,
          expectedTaskCreatedAt: createdAt,
          attachments,
        },
        opts,
      ),
    ).rejects.toThrow();
    task.createdAt = '2026-10-02T00:00:00.000Z';
    expect((await read()).status).toBe(404);
    expect(
      (
        await fetchTaskRoomAttachment(
          'http://station',
          task.id,
          task.createdAt,
          attachments[0].id,
          opts,
        )
      ).status,
    ).toBe(404);
  } finally {
    await instance.runtime.close();
    instance.store.close();
  }
});
