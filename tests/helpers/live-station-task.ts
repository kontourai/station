import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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

export function stationRootForLiveHome(home: string): string {
  return dirname(dirname(home));
}

export async function allocateLiveStation(
  homePrefix: string,
  instancePrefix: string,
): Promise<LiveStation> {
  // A Station instance owns server plus terminal, voice, and consent
  // listeners at +1/+2/+3. Keep the UI outside all four identities.
  const serverPort = await findFreePortBlock(4);
  const uiPort = await findFreePortOutside(serverPort, 4);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), homePrefix)));
  const home = join(root, 'instances', 'e2e');
  // Match the owner-only instance-registry boundary before CLI --clean reads it.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    api: `http://127.0.0.1:${serverPort}`,
    // On Windows tmpdir() can be an 8.3 path (for example
    // C:\\WINDOWS\\SERVIC~1\\...). The server resolves its watchers through
    // the long path, so pass the same canonical identity to every child.
    // Mixing the two causes libuv's Windows fs-event assertion during boot.
    home,
    instance: `${instancePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    serverPort,
    ui: `http://127.0.0.1:${uiPort}`,
    uiPort,
  };
}

type LifecycleCommandOutcome = {
  code: number | null;
  signal: string | null;
  error: boolean;
  timedOut: boolean | null;
};

type LifecycleEvent = {
  type: string;
  instanceId: string;
  bootId: string;
  pid: number;
  sha: string;
  operationId?: string;
  result?: string;
};

type LifecycleStartup = {
  instance: string;
  serverPort: number;
  uiPort: number;
  events: LifecycleEvent[];
};

const liveLifecycle = new WeakMap<
  LiveStation,
  {
    journal: string;
    start: LifecycleCommandOutcome | null;
    startup: LifecycleStartup | null;
  }
>();

function readLifecycleEvidence(
  path: string,
  instance: string,
  startup: LifecycleStartup | null,
) {
  let descriptor: number | undefined;
  const events: LifecycleEvent[] = [];
  let binding: { bytes: number | null; sha256: string | null } = {
    bytes: null,
    sha256: null,
  };
  const gap = (reason: string) => ({
    ...binding,
    events,
    started: null,
    matched: false,
    gap: reason,
  });
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (!fstatSync(descriptor).isFile()) return gap('journal-not-regular');
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes === buffer.length) return gap('journal-too-large');
    const raw = buffer.subarray(0, bytes);
    binding = {
      bytes,
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    const id = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    for (const line of raw.toString('utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (
        event.type !== 'started' &&
        event.type !== 'stop_intent' &&
        event.type !== 'stop_result'
      )
        continue;
      if (
        event.instanceId !== instance ||
        !id(event.bootId) ||
        !Number.isSafeInteger(event.pid) ||
        event.pid < 1 ||
        typeof event.sha !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(event.sha) ||
        (event.type !== 'started' && !id(event.operationId)) ||
        (event.type === 'stop_result' &&
          !['completed', 'already_absent', 'failed'].includes(event.result))
      )
        return gap('journal-identity-mismatch');
      if (events.length === 64) return gap('too-many-lifecycle-events');
      events.push({
        type: event.type,
        instanceId: instance,
        bootId: event.bootId,
        pid: event.pid,
        sha: event.sha,
        ...(event.type !== 'started' ? { operationId: event.operationId } : {}),
        ...(event.type === 'stop_result' ? { result: event.result } : {}),
      });
    }
    const sameIdentity = (left: LifecycleEvent, right: LifecycleEvent) =>
      left.instanceId === right.instanceId &&
      left.pid === right.pid &&
      left.bootId === right.bootId &&
      left.sha === right.sha;
    const starts = events.filter((event) => event.type === 'started');
    if (starts.length === 0) return gap('startup-identity-missing');
    if (
      starts.some((event, index) =>
        starts.slice(0, index).some((prior) => sameIdentity(event, prior)),
      )
    )
      return gap('duplicate-start-or-restart');
    const bootBuilds = new Set(
      events.map((event) => `${event.bootId}:${event.sha}`),
    );
    if (bootBuilds.size !== 1) return gap('conflicting-boot-or-build');
    if (startup) {
      if (
        startup.events.length === 0 ||
        events.length < startup.events.length ||
        startup.events.some((event, index) => {
          const current = events[index];
          return (
            !current ||
            event.type !== 'started' ||
            current.type !== 'started' ||
            !sameIdentity(event, current)
          );
        })
      )
        return gap('startup-prefix-changed');
      if (
        events
          .slice(startup.events.length)
          .some((event) => event.type === 'started')
      )
        return gap('new-start-after-startup');
    } else if (events.some((event) => event.type !== 'started')) {
      return gap('startup-snapshot-missing');
    }
    const intents = events.filter((event) => event.type === 'stop_intent');
    const results = events.filter((event) => event.type === 'stop_result');
    if (results.some((event) => event.result === 'failed'))
      return gap('failed-stop');
    if (intents.length === 0 && results.length === 0)
      return gap('matching-stop-pair-missing');
    if (intents.length !== 1 || results.length !== 1)
      return gap('ambiguous-or-orphan-stop');
    const [intent] = intents;
    const [result] = results;
    if (
      !intent ||
      !result ||
      !sameIdentity(intent, result) ||
      intent.operationId !== result.operationId
    )
      return gap('conflicting-stop-operation');
    const candidates = starts.filter((event) => sameIdentity(event, intent));
    const [started] = candidates;
    if (candidates.length !== 1 || !started)
      return gap('stop-identity-not-unique');
    if (
      events.indexOf(started) >= events.indexOf(intent) ||
      events.indexOf(intent) >= events.indexOf(result)
    )
      return gap('stop-events-out-of-order');
    if (!startup) return gap('startup-snapshot-missing');
    if (!startup.events.some((event) => sameIdentity(event, started)))
      return gap('stop-not-in-startup-set');
    return { ...binding, events, started, matched: true, gap: null };
  } catch {
    return gap('journal-unreadable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function emitLiveLifecycleEvidence(
  live: LiveStation,
  action: 'start' | 'stop',
  outcome: LifecycleCommandOutcome,
): void {
  const capture = liveLifecycle.get(live);
  if (!capture) return;
  try {
    const startup = action === 'stop' ? capture.startup : null;
    const evidence = readLifecycleEvidence(
      capture.journal,
      live.instance,
      startup,
    );
    const nativeStart = capture.start;
    const started = evidence.started;
    const startSucceeded = Boolean(
      nativeStart?.code === 0 &&
        nativeStart.signal === null &&
        !nativeStart.error &&
        nativeStart.timedOut === false,
    );
    if (action === 'start') {
      capture.startup =
        startSucceeded && evidence.gap === 'matching-stop-pair-missing'
          ? {
              instance: live.instance,
              serverPort: live.serverPort,
              uiPort: live.uiPort,
              events: evidence.events.map((event) => ({ ...event })),
            }
          : null;
    }
    const continuity = Boolean(
      action === 'stop' &&
        evidence.matched &&
        startSucceeded &&
        outcome.code === 0 &&
        outcome.signal === null &&
        !outcome.error &&
        outcome.timedOut === false &&
        startup?.instance === live.instance &&
        startup.serverPort === live.serverPort &&
        startup.uiPort === live.uiPort,
    );
    console.log(
      `[e2e-lifecycle] ${JSON.stringify({
        owner: 'spec',
        action,
        instance: live.instance,
        roots: 'fixture-owned-home-and-output',
        serverPort: live.serverPort,
        uiPort: live.uiPort,
        start: capture.start,
        ...(action === 'stop' ? { stop: outcome } : {}),
        journal: evidence,
        candidateSetContinuity: continuity,
        selectedMemberContinuity: Boolean(
          continuity &&
            started &&
            startup?.events.some(
              (event) =>
                event.instanceId === started.instanceId &&
                event.pid === started.pid &&
                event.bootId === started.bootId &&
                event.sha === started.sha,
            ),
        ),
      })}`,
    );
  } catch {
    try {
      console.log('[e2e-lifecycle] {"owner":"spec","gap":"capture-failed"}');
    } catch {
      // Evidence output must not replace the original command outcome.
    }
  }
}

async function runCommand(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onOutcome?: (outcome: LifecycleCommandOutcome) => void;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  let result: { stdout: string | Buffer; stderr: string | Buffer };
  try {
    result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error && typeof error === 'object' ? error : {};
    const code = 'code' in detail ? detail.code : null;
    const signal = 'signal' in detail ? detail.signal : null;
    options.onOutcome?.({
      code: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
      error: true,
      timedOut: code === 'ETIMEDOUT' ? true : null,
    });
    throw error;
  }
  options.onOutcome?.({ code: 0, signal: null, error: false, timedOut: false });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
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

/** Compile the exact disposable instance before its process-start deadline begins. */
export async function prepareLiveStationBuild(
  live: LiveStation,
): Promise<void> {
  await runCommand(
    ...stationCommand([
      'build',
      `--instance=${live.instance}`,
      `--base=${live.home}`,
      `--port=${live.serverPort}`,
      `--ui-port=${live.uiPort}`,
    ]),
    {
      timeoutMs: 180_000,
      env: {
        ...process.env,
        PATH: `${NODE_BIN}${delimiter}${process.env.PATH ?? ''}`,
        STATION_ROOT: stationRootForLiveHome(live.home),
        STATION_HOME: live.home,
      },
    },
  );
}

export async function startStation(
  live: LiveStation,
  clean: boolean,
  options: {
    taskRoomControlSocket?: string;
    performanceReference?: boolean;
    runtimeFramework?: 'voltagent' | 'strands';
    deterministicReadiness?: boolean;
    logFile?: string;
    /** Explicit inherited environment; live security fixtures pass a sanitized set. */
    environment?: NodeJS.ProcessEnv;
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
  if (options.logFile) {
    const journal = `${options.logFile}.lifecycle.ndjson`;
    liveLifecycle.set(live, { journal, start: null, startup: null });
    args.push(`--log=${options.logFile}`, `--lifecycle-journal=${journal}`);
  } else {
    liveLifecycle.delete(live);
  }
  if (clean) args.splice(3, 0, '--clean');
  const inherited = options.environment ?? process.env;
  const startup = await runCommand(...stationCommand(args), {
    // The diagnostic production UI is intentionally a distinct tree-shaken
    // build. A cold Windows or low-disk cache can exceed the ordinary helper's
    // two-minute command budget without the Station process being unhealthy.
    timeoutMs: options.performanceReference ? 300_000 : 120_000,
    onOutcome: (outcome) => {
      const capture = liveLifecycle.get(live);
      if (capture) capture.start = outcome;
      emitLiveLifecycleEvidence(live, 'start', outcome);
    },
    env: {
      ...inherited,
      PATH: `${NODE_BIN}${delimiter}${inherited.PATH ?? process.env.PATH ?? ''}`,
      STATION_ROOT: stationRootForLiveHome(live.home),
      STATION_HOME: live.home,
      STATION_E2E_SYSTEM_STATUS_READY:
        options.deterministicReadiness === false ? undefined : '1',
      ...(options.runtimeFramework
        ? {
            STATION_FEATURES: [
              ...(inherited.STATION_FEATURES ?? '')
                .split(',')
                .filter((feature) => feature && feature !== 'strands-runtime'),
              ...(options.runtimeFramework === 'strands'
                ? ['strands-runtime']
                : []),
            ].join(','),
          }
        : {}),
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
      socket.write(
        `${JSON.stringify({ protocol: 'station.task-room-control/v1', request: { command: 'publish-agent-edit', ...input } })}\n`,
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

export async function stopStation(
  live: LiveStation,
  options: { environment?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const args = [
    'stop',
    `--instance=${live.instance}`,
    `--base=${live.home}`,
    `--port=${live.serverPort}`,
    `--ui-port=${live.uiPort}`,
  ];
  const inherited = options.environment ?? process.env;
  await runCommand(...stationCommand(args), {
    onOutcome: (outcome) => emitLiveLifecycleEvidence(live, 'stop', outcome),
    env: {
      ...inherited,
      PATH: `${NODE_BIN}${delimiter}${inherited.PATH ?? process.env.PATH ?? ''}`,
      STATION_ROOT: stationRootForLiveHome(live.home),
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
  // A navigation the old page cancels (a history traversal from a dialog
  // unmounting mid-`goto`) resolves without error and leaves the page where it
  // was. Say so here, rather than as a missing branch label on the wrong page
  // (Windows reference run 35865166445).
  await expect(
    page,
    'goto was superseded before the Project page loaded',
  ).toHaveURL((url) => url.pathname === `/projects/${slug}`);
  const gitStatus = await apiJson<{
    success: boolean;
    data: { isRepo: boolean; branch?: string; repoRoot?: string };
  }>(
    page,
    // Coding reads are confined to a named Project since #2471; a bare path
    // is refused `project-required` (400).
    `/api/coding/git/status?projectSlug=${encodeURIComponent(slug)}&path=${encodeURIComponent(workingDirectory)}`,
  );
  expect(gitStatus).toMatchObject({
    success: true,
    data: { isRepo: true, branch },
  });
  const workspace = page.locator('details.project-page__workspace');
  if ((await workspace.getAttribute('open')) === null)
    await workspace.locator('summary').click();
  const branchLabel = page.locator(
    '.project-page__git-section .project-page__section-label',
  );
  await expect(branchLabel).toBeVisible({ timeout: 15_000 });
  // The branch icon is an SVG, not part of the label's text contract.
  const escapedBranch = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(branchLabel).toHaveText(
    new RegExp(`^\\s*${escapedBranch}(?:\\s*·.*)?\\s*$`),
    { timeout: 15_000 },
  );
  // The default Project flow shapes Tasks conversationally; the start-task
  // starter still has a title form. This lifecycle fixture creates through
  // the public API, labelled as an API origin, then opens the Task in the UI.
  const created = await apiJson<{ success: boolean; data?: { id: string } }>(
    page,
    '/api/tasks',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: slug,
        title,
        createdBy: 'user',
        workspaceBinding: {
          workingDirectory,
          repoRoot: gitStatus.data.repoRoot,
          worktreePath: gitStatus.data.repoRoot,
          branch: gitStatus.data.branch,
          sourceSurface: 'api',
        },
      }),
    },
  );
  expect(created).toMatchObject({
    success: true,
    data: { id: expect.any(String) },
  });
  const taskId = created.data!.id;
  await page.goto(`${live.ui}/tasks/${encodeURIComponent(taskId)}`);
  await expect(page).toHaveURL(
    (url) => url.pathname === `/tasks/${encodeURIComponent(taskId)}`,
  );
  return taskId;
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
    environmentId: string;
    credential: string;
    device: { id: string; name: string };
  };
}
