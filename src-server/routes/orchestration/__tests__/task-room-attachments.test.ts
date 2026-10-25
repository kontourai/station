import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { EventStore } from '../../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../../services/orchestration/project-task-room-runtime.js';
import { TaskRoomAttachments } from '../../../services/projects/task-room-attachments.js';
import { createProjectTaskRoomRoutes } from '../project-task-rooms.js';

const makeTempDir = trackTempDirs();
afterEach(() => vi.unstubAllGlobals());
const image: ChatAttachmentInput = {
  kind: 'image',
  name: 'screen.png',
  mimeType: 'image/png',
  size: 8,
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
};

test('Task attachment transport preserves history and bytes across restart and enforces current Task authority', async () => {
  const root = makeTempDir('task-attachments-');
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
    const read = () =>
      fetchTaskRoomAttachment(
        'http://station',
        task.id,
        createdAt,
        attachments[0].id,
        opts,
      );
    const probe = new DatabaseSync(join(root, 'events.sqlite'));
    try {
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
          proposalId: 'expired-fresh-message',
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
