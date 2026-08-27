import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  controlCommandTimeoutMs,
  startTaskRoomAcceptanceControl,
  type TaskRoomAcceptanceAgentEditReceipt,
} from '../task-room-acceptance-control.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('extends only exact performance command shapes', () => {
  expect(
    controlCommandTimeoutMs({
      command: 'seed-performance-operations',
      count: 10,
    }),
  ).toBe(600_000);
  expect(
    controlCommandTimeoutMs({
      command: 'prepare-performance-corpus',
      phase: 'cold',
    }),
  ).toBe(600_000);
  expect(controlCommandTimeoutMs({ phase: 'cold' })).toBe(10_000);
  expect(
    controlCommandTimeoutMs({
      command: 'publish-agent-edit',
      agentId: 'agent',
    }),
  ).toBe(10_000);
  expect(controlCommandTimeoutMs(undefined)).toBe(10_000);
});

function privateRoot() {
  const root = realpathSync(
    resolve(mkdtempSync(join(tmpdir(), 'station-room-control-'))),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const receipt: TaskRoomAcceptanceAgentEditReceipt = {
  kind: 'published',
  taskId: 'task-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  runId: 'run-1',
  revision: 'revision-1',
  text: 'hello',
};

function exchange(
  socketPath: string,
  write: (socket: ReturnType<typeof createConnection>) => void,
) {
  return new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on('connect', () => write(socket));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () =>
      resolveResponse(Buffer.concat(chunks).toString('utf8')),
    );
    socket.on('error', reject);
  });
}

test('dispatches exactly one bounded command only after peer EOF', async () => {
  const socketPath = join(privateRoot(), 'control.sock');
  const publishAgentEdit = vi.fn(async () => receipt);
  const control = await startTaskRoomAcceptanceControl({
    socketPath,
    e2eSystemStatusReady: '1',
    publishAgentEdit,
  });
  const response = await exchange(socketPath, (socket) =>
    socket.end(
      `${JSON.stringify({
        command: 'publish-agent-edit',
        taskId: 'task-1',
        agentId: 'agent-1',
        desiredText: 'hello',
      })}\n`,
    ),
  );
  expect(JSON.parse(response)).toEqual(receipt);
  expect(publishAgentEdit).toHaveBeenCalledTimes(1);
  await control.close();
  expect(existsSync(socketPath)).toBe(false);
});

test('dispatches only the two bounded performance fixture commands', async () => {
  const socketPath = join(privateRoot(), 'control.sock');
  const preparePerformanceCorpus = vi.fn(async () => ({
    kind: 'prepared' as const,
    path: 'plain-text-100k-lines-v1.txt',
    corpusId: 'plain-text-100k-lines-v1' as const,
    sha256: 'a'.repeat(64),
    lineCount: 100_000 as const,
    rebuilt: true,
  }));
  const seedPerformanceOperations = vi.fn(async () => ({
    kind: 'seeded' as const,
    taskId: 'task-1',
    operationCount: 10_000,
    baseRevision: 'base',
    revision: 'next',
  }));
  const control = await startTaskRoomAcceptanceControl({
    socketPath,
    e2eSystemStatusReady: '1',
    publishAgentEdit: async () => receipt,
    preparePerformanceCorpus,
    seedPerformanceOperations,
  });
  await expect(
    exchange(socketPath, (socket) =>
      socket.end(
        `${JSON.stringify({
          command: 'prepare-performance-corpus',
          taskId: 'task-1',
          phase: 'cold',
          iteration: 104,
        })}\n`,
      ),
    ).then(JSON.parse),
  ).resolves.toMatchObject({ kind: 'prepared', lineCount: 100_000 });
  await expect(
    exchange(socketPath, (socket) =>
      socket.end(
        `${JSON.stringify({
          command: 'seed-performance-operations',
          taskId: 'task-1',
          count: 10_000,
        })}\n`,
      ),
    ).then(JSON.parse),
  ).resolves.toMatchObject({ kind: 'seeded', operationCount: 10_000 });
  expect(preparePerformanceCorpus).toHaveBeenCalledOnce();
  expect(seedPerformanceOperations).toHaveBeenCalledOnce();
  await control.close();
});

test('rejects delayed trailing packets without publishing the valid prefix', async () => {
  const socketPath = join(privateRoot(), 'control.sock');
  const publishAgentEdit = vi.fn(async () => receipt);
  const control = await startTaskRoomAcceptanceControl({
    socketPath,
    e2eSystemStatusReady: '1',
    publishAgentEdit,
  });
  const response = await exchange(socketPath, (socket) => {
    socket.write(
      `${JSON.stringify({
        command: 'publish-agent-edit',
        taskId: 'task-1',
        agentId: 'agent-1',
        desiredText: 'hello',
      })}\n`,
    );
    setTimeout(() => socket.end('trailing'), 10);
  });
  expect(JSON.parse(response)).toEqual({ kind: 'refused' });
  expect(publishAgentEdit).not.toHaveBeenCalled();
  await control.close();
});

test('rejects a non-private parent and removes a socket after setup failure', async () => {
  const root = privateRoot();
  chmodSync(root, 0o755);
  await expect(
    startTaskRoomAcceptanceControl({
      socketPath: join(root, 'refused.sock'),
      e2eSystemStatusReady: '1',
      publishAgentEdit: async () => receipt,
    }),
  ).rejects.toThrow('parent is not owned');
  chmodSync(root, 0o700);
  const failedPath = join(root, 'failed.sock');
  await expect(
    startTaskRoomAcceptanceControl({
      socketPath: failedPath,
      e2eSystemStatusReady: '1',
      publishAgentEdit: async () => receipt,
      afterListenForTest: () => {
        throw new Error('injected setup failure');
      },
    }),
  ).rejects.toThrow('injected setup failure');
  expect(existsSync(failedPath)).toBe(false);
});
