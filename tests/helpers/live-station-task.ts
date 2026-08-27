import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';
import {
  findFreePortBlock,
  findFreePortOutside,
} from '../../scripts/lib/free-ports.mjs';
import {
  e2eOperatorAuthorizationHeaders,
  readE2EOperatorCredential,
} from './e2e-operator-credential';

const execFileAsync = promisify(execFile);
const NODE_BIN = dirname(process.execPath);

export interface LiveStation {
  api: string;
  home: string;
  instance: string;
  serverPort: number;
  ui: string;
  uiPort: number;
}

export async function allocateLiveStation(
  homePrefix: string,
  instancePrefix: string,
): Promise<LiveStation> {
  // A Station instance owns server plus terminal, voice, and consent
  // listeners at +1/+2/+3. Keep the UI outside all four identities.
  const serverPort = await findFreePortBlock(4);
  const uiPort = await findFreePortOutside(serverPort, 4);
  return {
    api: `http://127.0.0.1:${serverPort}`,
    // On Windows tmpdir() can be an 8.3 path (for example
    // C:\\WINDOWS\\SERVIC~1\\...). The server resolves its watchers through
    // the long path, so pass the same canonical identity to every child.
    // Mixing the two causes libuv's Windows fs-event assertion during boot.
    home: realpathSync.native(mkdtempSync(join(tmpdir(), homePrefix))),
    instance: `${instancePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    serverPort,
    ui: `http://127.0.0.1:${uiPort}`,
    uiPort,
  };
}

async function runCommand(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

async function waitForReady(
  url: string,
  label: string,
  headers?: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const response = await fetch(url, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(remaining),
      });
      if (response.ok) return;
      lastError = `${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

export async function startStation(
  live: LiveStation,
  clean: boolean,
  options: {
    taskRoomControlSocket?: string;
    performanceReference?: boolean;
  } = {},
): Promise<string> {
  const args = [
    'start',
    `--instance=${live.instance}`,
    `--base=${live.home}`,
    '--force',
    `--port=${live.serverPort}`,
    `--ui-port=${live.uiPort}`,
  ];
  if (clean) args.splice(3, 0, '--clean');
  const startup = await runCommand(...stationCommand(args), {
    // The diagnostic production UI is intentionally a distinct tree-shaken
    // build. A cold Windows or low-disk cache can exceed the ordinary helper's
    // two-minute command budget without the Station process being unhealthy.
    timeoutMs: options.performanceReference ? 300_000 : 120_000,
    env: {
      ...process.env,
      PATH: `${NODE_BIN}:${process.env.PATH ?? ''}`,
      STATION_HOME: live.home,
      STATION_E2E_SYSTEM_STATUS_READY: '1',
      ...(options.performanceReference
        ? {
            STATION_PERFORMANCE_REFERENCE: '1',
            VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE: '1',
          }
        : {}),
      ...(options.taskRoomControlSocket
        ? {
            STATION_E2E_TASK_ROOM_CONTROL_SOCKET: options.taskRoomControlSocket,
          }
        : {}),
    },
  });
  const bootstrapMatches = [
    ...startup.stdout.matchAll(
      /#station-ui-bootstrap=([A-Za-z0-9_-]{43})(?:\s|$)/g,
    ),
  ];
  if (bootstrapMatches.length !== 1)
    throw new Error(
      'Nested Station startup did not publish exactly one UI bootstrap token',
    );
  const operatorCredential = readE2EOperatorCredential(live.home);
  await Promise.all([
    waitForReady(
      `${live.api}/api/system/status`,
      'Station API',
      e2eOperatorAuthorizationHeaders(operatorCredential),
    ),
    waitForReady(live.ui, 'Station UI'),
  ]);
  return bootstrapMatches[0]![1]!;
}

export interface TaskRoomAgentEditReceipt {
  readonly kind: 'published';
  readonly taskId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: string;
  readonly text: string;
}

export async function publishTaskRoomAgentEdit(
  socketPath: string,
  input: { taskId: string; agentId: string; desiredText: string },
): Promise<TaskRoomAgentEditReceipt> {
  const response = await new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Task-room acceptance control timed out'));
    }, 15_000);
    const settle = (callback: () => void) => {
      clearTimeout(timer);
      callback();
    };
    socket.on('connect', () => {
      socket.end(
        `${JSON.stringify({ command: 'publish-agent-edit', ...input })}\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 32 * 1024) {
        socket.destroy();
        settle(() => reject(new Error('Task-room control response too large')));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () =>
      settle(() => resolveResponse(Buffer.concat(chunks).toString('utf8'))),
    );
    socket.on('error', (error) => settle(() => reject(error)));
  });
  const parsed: unknown = JSON.parse(response);
  if (!isTaskRoomAgentEditReceipt(parsed))
    throw new Error(`Task-room agent edit was not published: ${response}`);
  return parsed;
}

function isTaskRoomAgentEditReceipt(
  value: unknown,
): value is TaskRoomAgentEditReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 7 &&
    row.kind === 'published' &&
    ['taskId', 'agentId', 'sessionId', 'runId', 'revision', 'text'].every(
      (key) => typeof row[key] === 'string' && row[key].length > 0,
    )
  );
}

export async function stopStation(live: LiveStation): Promise<void> {
  const args = [
    'stop',
    `--instance=${live.instance}`,
    `--base=${live.home}`,
    `--port=${live.serverPort}`,
    `--ui-port=${live.uiPort}`,
  ];
  await runCommand(...stationCommand(args), {
    env: {
      ...process.env,
      PATH: `${NODE_BIN}:${process.env.PATH ?? ''}`,
      STATION_HOME: live.home,
    },
  });
}

function stationCommand(args: string[]): [string, string[]] {
  return process.platform === 'win32'
    ? [process.execPath, ['--import', 'tsx', 'scripts/station-cli.ts', ...args]]
    : ['./station', args];
}

export async function createRepository(directory: string, branch: string) {
  mkdirSync(directory, { recursive: true });
  await runCommand('git', ['init', '--initial-branch', branch], {
    cwd: directory,
  });
  await runCommand('git', ['config', 'user.email', 'task@example.test'], {
    cwd: directory,
  });
  await runCommand('git', ['config', 'user.name', 'Task Smoke'], {
    cwd: directory,
  });
  writeFileSync(join(directory, 'README.md'), 'baseline\n');
  await runCommand('git', ['add', 'README.md'], { cwd: directory });
  await runCommand('git', ['commit', '-m', 'baseline'], { cwd: directory });
}

export async function gitTopLevel(directory: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--show-toplevel'],
    { cwd: directory, encoding: 'utf8' },
  );
  return String(stdout).trim();
}

interface SerializableRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function apiJson<T>(
  page: Page,
  path: string,
  init?: SerializableRequestInit,
): Promise<T> {
  return (await page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, requestInit);
      return await response.json();
    },
    { requestPath: path, requestInit: init },
  )) as T;
}

export async function createProject(
  page: Page,
  slug: string,
  workingDirectory: string,
) {
  const result = await apiJson<{ success: boolean }>(page, '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slug, slug, workingDirectory }),
  });
  expect(result.success).toBe(true);
}

export async function createTaskFromProject(
  page: Page,
  live: LiveStation,
  slug: string,
  title: string,
  workingDirectory: string,
  branch: string,
): Promise<string> {
  await page.goto(`${live.ui}/projects/${slug}`);
  const gitStatus = await apiJson<{
    success: boolean;
    data: { isRepo: boolean; branch?: string };
  }>(
    page,
    `/api/coding/git/status?path=${encodeURIComponent(workingDirectory)}`,
  );
  expect(gitStatus).toMatchObject({
    success: true,
    data: { isRepo: true, branch },
  });
  await expect(
    page.getByText(`⎇ ${branch}`, { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Task title').fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.waitForURL(/\/tasks\//, { timeout: 15_000 });
  return decodeURIComponent(
    new URL(page.url()).pathname.slice('/tasks/'.length),
  );
}

export async function pairBrowserDevice(
  live: Pick<LiveStation, 'api' | 'ui'>,
  operatorCredential: string,
  deviceName: string,
) {
  const access = await fetch(
    `${live.api}/.well-known/station/v1/pairing/access-request`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: live.ui,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ deviceName }),
    },
  );
  if (access.status !== 202)
    throw new Error(`Pairing access request failed (${access.status})`);
  const request = (await access.json()) as {
    offerId: string;
    proof: string;
    requestId: string;
  };
  const confirmed = await fetch(
    `${live.api}/api/pairing/requests/${encodeURIComponent(request.requestId)}/confirm`,
    {
      method: 'POST',
      headers: e2eOperatorAuthorizationHeaders(operatorCredential),
    },
  );
  if (!confirmed.ok)
    throw new Error(`Pairing confirmation failed (${confirmed.status})`);
  const exchange = await fetch(
    `${live.api}/.well-known/station/v1/pairing/exchange`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: live.ui,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify(request),
    },
  );
  if (!exchange.ok)
    throw new Error(`Pairing exchange failed (${exchange.status})`);
  return (await exchange.json()) as {
    credential: string;
    device: { id: string; name: string };
  };
}
