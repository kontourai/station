/**
 * Test-owned local IPC for browser acceptance. This is deliberately not an
 * HTTP route and is unavailable unless the nested E2E runtime explicitly
 * enables its existing system-status test mode.
 */
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';

const MAX_CONTROL_BYTES = 32 * 1024;
const CONTROL_READ_TIMEOUT_MS = 10_000;
const PERFORMANCE_COMMAND_TIMEOUT_MS = 600_000;

export interface TaskRoomAcceptanceAgentEdit {
  readonly taskId: string;
  readonly agentId: string;
  readonly desiredText: string;
}

export interface TaskRoomAcceptanceAgentEditReceipt {
  readonly kind: 'published';
  readonly taskId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: string;
  readonly text: string;
}

export interface TaskRoomAcceptancePerformanceCorpus {
  readonly command: 'prepare-performance-corpus';
  readonly taskId: string;
  readonly phase: 'warm' | 'cold';
  readonly iteration: number;
}

export interface TaskRoomAcceptancePerformanceCorpusReceipt {
  readonly kind: 'prepared';
  readonly path: string;
  readonly corpusId: 'plain-text-100k-lines-v1';
  readonly sha256: string;
  readonly lineCount: 100_000;
  readonly rebuilt: boolean;
}

export interface TaskRoomAcceptancePerformanceOperations {
  readonly command: 'seed-performance-operations';
  readonly taskId: string;
  readonly count: 1 | 10 | 10_000;
}

export interface TaskRoomAcceptancePerformanceOperationsReceipt {
  readonly kind: 'seeded';
  readonly taskId: string;
  readonly operationCount: number;
  readonly baseRevision: string;
  readonly revision: string;
}

type TaskRoomAcceptanceCommand =
  | TaskRoomAcceptanceAgentEdit
  | TaskRoomAcceptancePerformanceCorpus
  | TaskRoomAcceptancePerformanceOperations;

export interface TaskRoomAcceptanceControl {
  close(): Promise<void>;
}

export async function startTaskRoomAcceptanceControl(input: {
  readonly socketPath: string;
  readonly e2eSystemStatusReady: string | undefined;
  readonly publishAgentEdit: (
    edit: TaskRoomAcceptanceAgentEdit,
  ) => Promise<TaskRoomAcceptanceAgentEditReceipt>;
  readonly preparePerformanceCorpus?: (
    input: TaskRoomAcceptancePerformanceCorpus,
  ) => Promise<TaskRoomAcceptancePerformanceCorpusReceipt>;
  readonly seedPerformanceOperations?: (
    input: TaskRoomAcceptancePerformanceOperations,
  ) => Promise<TaskRoomAcceptancePerformanceOperationsReceipt>;
  /** Test-only fault boundary after bind and before the socket can accept. */
  readonly afterListenForTest?: () => Promise<void> | void;
}): Promise<TaskRoomAcceptanceControl> {
  if (input.e2eSystemStatusReady !== '1')
    throw new Error('Task-room acceptance control requires E2E mode');
  const socketPath = await validatedSocketPath(input.socketPath);
  let accepting = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (!accepting) return socket.destroy();
    receiveOneCommand(socket, async (command) => {
      if ('count' in command) {
        if (!input.seedPerformanceOperations)
          throw new Error('Performance operation control is unavailable');
        return input.seedPerformanceOperations(command);
      }
      if ('phase' in command) {
        if (!input.preparePerformanceCorpus)
          throw new Error('Performance corpus control is unavailable');
        return input.preparePerformanceCorpus(command);
      }
      return input.publishAgentEdit(command);
    });
  });
  try {
    await listen(server, socketPath);
    await input.afterListenForTest?.();
    if (!isWindowsPipe(socketPath)) {
      await chmod(socketPath, 0o600);
      const entry = await lstat(socketPath);
      const uid = process.getuid?.();
      if (
        !entry.isSocket() ||
        (uid !== undefined && entry.uid !== uid) ||
        (entry.mode & 0o777) !== 0o600
      )
        throw new Error('Task-room acceptance control socket is not private');
    }
    accepting = true;
  } catch (error) {
    await closeAndUnlink(server, socketPath);
    throw error;
  }
  let closed = false;
  return Object.freeze({
    close: async () => {
      if (closed) return;
      closed = true;
      accepting = false;
      await closeAndUnlink(server, socketPath);
    },
  });
}

async function validatedSocketPath(socketPath: string): Promise<string> {
  if (process.platform === 'win32') {
    if (
      typeof socketPath === 'string' &&
      /^\\\\\.\\pipe\\station-performance-[A-Za-z0-9_-]{16,64}$/.test(
        socketPath,
      )
    )
      return socketPath;
    throw new Error('Task-room acceptance control path is invalid');
  }
  if (
    typeof socketPath !== 'string' ||
    !isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath, 'utf8') > 100
  )
    throw new Error('Task-room acceptance control path is invalid');
  const normalized = resolve(socketPath);
  const parent = dirname(normalized);
  const [parentEntry, actualParent] = await Promise.all([
    lstat(parent),
    realpath(parent),
  ]);
  const uid = process.getuid?.();
  if (
    !parentEntry.isDirectory() ||
    actualParent !== parent ||
    (uid !== undefined && parentEntry.uid !== uid) ||
    (parentEntry.mode & 0o077) !== 0
  )
    throw new Error('Task-room acceptance control parent is not owned');
  try {
    await lstat(normalized);
    throw new Error('Task-room acceptance control path already exists');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return normalized;
}

function receiveOneCommand(
  socket: Socket,
  execute: (command: TaskRoomAcceptanceCommand) => Promise<unknown>,
): void {
  let total = 0;
  let settled = false;
  const chunks: Buffer[] = [];
  const finish = (payload: unknown) => {
    if (settled) return;
    settled = true;
    socket.end(`${JSON.stringify(payload)}\n`);
  };
  socket.setTimeout(CONTROL_READ_TIMEOUT_MS, () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    if (settled) return;
    total += chunk.length;
    if (total > MAX_CONTROL_BYTES) return socket.destroy();
    chunks.push(chunk);
  });
  socket.on('end', () => {
    if (settled) return;
    const body = Buffer.concat(chunks).toString('utf8');
    const newline = body.indexOf('\n');
    if (newline < 0 || newline !== body.length - 1)
      return finish({ kind: 'refused' });
    const command = parseCommand(body.slice(0, -1));
    if (!command) return finish({ kind: 'refused' });
    socket.setTimeout(controlCommandTimeoutMs(command));
    void execute(command)
      .then((receipt) => finish(receipt))
      .catch((error) =>
        finish({
          kind: 'unavailable',
          reason:
            error instanceof Error
              ? error.message.slice(0, 256)
              : 'unknown control failure',
        }),
      );
  });
  socket.on('error', () => {});
}

export function controlCommandTimeoutMs(command: unknown): number {
  return command &&
    typeof command === 'object' &&
    ((command as { command?: unknown }).command ===
      'seed-performance-operations' ||
      (command as { command?: unknown }).command ===
        'prepare-performance-corpus')
    ? PERFORMANCE_COMMAND_TIMEOUT_MS
    : CONTROL_READ_TIMEOUT_MS;
}

function parseCommand(value: string): TaskRoomAcceptanceCommand | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      plainOwn(parsed, ['command', 'taskId', 'agentId', 'desiredText']) &&
      parsed.command === 'publish-agent-edit' &&
      boundedId(parsed.taskId) &&
      boundedId(parsed.agentId) &&
      typeof parsed.desiredText === 'string' &&
      Buffer.byteLength(parsed.desiredText, 'utf8') <= 256 * 1024
    )
      return {
        taskId: parsed.taskId,
        agentId: parsed.agentId,
        desiredText: parsed.desiredText,
      };
    if (
      plainOwn(parsed, ['command', 'taskId', 'phase', 'iteration']) &&
      parsed.command === 'prepare-performance-corpus' &&
      boundedId(parsed.taskId) &&
      (parsed.phase === 'warm' || parsed.phase === 'cold') &&
      Number.isSafeInteger(parsed.iteration) &&
      (parsed.iteration as number) >= 0 &&
      (parsed.iteration as number) <= 104
    )
      return {
        command: 'prepare-performance-corpus',
        taskId: parsed.taskId,
        phase: parsed.phase,
        iteration: parsed.iteration as number,
      };
    if (
      plainOwn(parsed, ['command', 'taskId', 'count']) &&
      parsed.command === 'seed-performance-operations' &&
      boundedId(parsed.taskId) &&
      (parsed.count === 1 || parsed.count === 10 || parsed.count === 10_000)
    )
      return {
        command: 'seed-performance-operations',
        taskId: parsed.taskId,
        count: parsed.count,
      };
    return undefined;
  } catch {
    return undefined;
  }
}

function plainOwn(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (
      Object.keys(descriptors).length === keys.length &&
      keys.every((key) => {
        const descriptor = descriptors[key];
        return descriptor && !descriptor.get && !descriptor.set;
      })
    );
  } catch {
    return false;
  }
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= 256
  );
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(
      isWindowsPipe(socketPath)
        ? { path: socketPath, readableAll: false, writableAll: false }
        : { path: socketPath },
      () => {
        server.off('error', onError);
        resolveListen();
      },
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function closeAndUnlink(server: Server, socketPath: string) {
  if (server.listening) await closeServer(server);
  if (isWindowsPipe(socketPath)) return;
  try {
    const current = await lstat(socketPath);
    if (!current.isSocket())
      throw new Error('Task-room acceptance control cleanup target changed');
    await unlink(socketPath);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function isWindowsPipe(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
