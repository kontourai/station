// @vitest-environment node
/**
 * #3994 agent terminal runs and the script runner with real processes: the
 * production run routes over a real `TerminalSessions` (in-process host) and
 * real command resolution. The station-control guard is stood in for by
 * stamping the verified caller on each agent request, which is all the guard
 * hands these routes.
 */
import {
  chmod,
  mkdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProjectTerminalScript,
  TerminalRun,
  TerminalSessionRecord,
} from '@kontourai/station-sdk/client';
import { type Context, Hono, type Next } from 'hono';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import {
  createAgentTerminalRunRoutes,
  createTerminalRunRoutes,
  TERMINAL_RUN_OUTPUT_PAGE_BYTES,
  type TerminalRunOutput,
} from '../../../routes/orchestration/terminal-runs.js';
import { createTerminalSessionRoutes } from '../../../routes/projects/terminal-session-routes.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  stationControlCallerPrincipal,
} from '../../../tools/station-control-shared.js';
import { InProcessShellHost } from '../shell-host.js';
import { resolveTerminalCommandLaunch } from '../terminal-command-programs.js';
import { TerminalRunRequests } from '../terminal-runs.js';
import {
  confineTerminalDirectory,
  TerminalSessions,
} from '../terminal-sessions.js';

const makeTempDir = trackTempDirs();

/** The routes' `{success, data, error}` answer, with the SDK's wire types. */
type Envelope<T> = { success: boolean; data: T; error?: string };
async function envelope<T>(response: Response): Promise<Envelope<T>> {
  return (await response.json()) as Envelope<T>;
}
/** `terminal_read`: the run, and once it started, a page of its output. */
type ReadRun = TerminalRun & Partial<TerminalRunOutput>;
const windows = process.platform === 'win32';
const WAIT = { timeout: 20_000, interval: 50 };
const project = { id: 'project-a', slug: 'alpha' };
const SESSION = 'session-1';
const CONVERSATION = 'conv-1';
const thread = { projectId: project.id, bindingKey: `thread:${SESSION}` };

/** Who is asking: the operator in the UI, or an agent's tool call. */
type Principal = 'operator' | 'stranger';

async function harness(options: { fakePackageManager?: string } = {}) {
  const home = makeTempDir('terminal-runs-home-');
  const root = await realpath(makeTempDir('terminal-runs-root-'));
  const sessions = new TerminalSessions<Request>(
    home,
    new InProcessShellHost(new NodePtyAdapter(), () =>
      windows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh',
    ),
    {
      authorize: (request) => principalOf(request) === 'operator',
      resolveRoot: async () => root,
      resolveCommand: (_request, _scope, program, cwd) =>
        resolveTerminalCommandLaunch(program, cwd, {
          findBinary: async () => options.fakePackageManager,
          path: async () => process.env.PATH ?? '',
        }),
    },
  );
  const runs = new TerminalRunRequests();
  const app = new Hono();
  // The guard's part: an agent request carries its verified caller.
  const stampCaller = async (c: Context, next: Next) => {
    bindStationControlRequestAuthority(c.req.raw, {
      kind: 'caller',
      boundOperator: false,
      caller: {
        sessionId: SESSION,
        principal: stationControlCallerPrincipal(
          'human:local:operator',
          'session-owner',
        ),
        conversationId: c.req.header('x-test-conversation') ?? CONVERSATION,
        assurance: 'bound',
        localProjectId: project.id,
        projectIdSource: 'session-record',
      },
    });
    await next();
  };
  app.use('/agent', stampCaller);
  app.use('/agent/*', stampCaller);
  app.route(
    '/agent',
    createAgentTerminalRunRoutes({
      isInternalRequest: () => true,
      runs,
      project: (id) => (id === project.id ? project : undefined),
      runDirectory: async (input) =>
        (await confineTerminalDirectory(root, input.subdirectory ?? '.')).cwd,
      output: async (run, fromSeq) => {
        const read = await sessions.readInternal(
          thread,
          run.terminalId!,
          fromSeq,
          TERMINAL_RUN_OUTPUT_PAGE_BYTES,
        );
        const { records, lastSeq, reset } = read.journal;
        return {
          output: records.map((record) => record.data).join(''),
          nextSeq: records.at(-1)?.seq ?? fromSeq,
          lastSeq,
          reset,
          outputCapped: read.outputCapped === true,
        };
      },
    }),
  );
  app.route(
    '/runs',
    createTerminalRunRoutes({
      runs,
      authorizeRequest: (request) => principalOf(request) === 'operator',
      person: (c) =>
        principalOf(c.req.raw) === 'operator'
          ? {
              userId: 'operator',
              mayRead: (id) => id === CONVERSATION,
              mayMutate: (id) => id === CONVERSATION,
            }
          : undefined,
      start: async (request, run) => {
        const { record, exited } = await sessions.openCommand(request, thread, {
          program: { kind: 'run', command: run.command },
          ...(run.subdirectory ? { subdirectory: run.subdirectory } : {}),
          expectedCwd: run.cwd,
        });
        return { terminalId: record.terminalId, exited };
      },
    }),
  );
  app.route(
    '/api/projects',
    createTerminalSessionRoutes(
      sessions,
      (slug) => (slug === project.slug ? project.id : 'unknown'),
      (request) => principalOf(request) === 'operator',
    ),
  );
  return { app, root, runs, sessions };
}

function principalOf(request: Request): Principal | undefined {
  const value = request.headers.get('x-test-principal');
  return value === 'operator' || value === 'stranger' ? value : undefined;
}

const agent = (
  app: Hono,
  path: string,
  init: RequestInit & { conversation?: string } = {},
) =>
  app.request(`/agent${path === '/' ? '' : path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.conversation
        ? { 'x-test-conversation': init.conversation }
        : {}),
    },
  });

const person = (
  app: Hono,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: { 'x-test-principal': 'operator', ...headers },
  });

async function requestRun(app: Hono, command: string, subdirectory?: string) {
  const response = await agent(app, '/', {
    method: 'POST',
    body: JSON.stringify({ command, ...(subdirectory && { subdirectory }) }),
  });
  expect(response.status).toBe(200);
  return (await envelope<TerminalRun>(response)).data;
}

async function readRun(app: Hono, runId: string, query = '') {
  const response = await agent(app, `/${runId}${query}`);
  return { status: response.status, body: await envelope<ReadRun>(response) };
}

describe('agent terminal runs', () => {
  it('asks the person for every run: an approved command does not approve the next one', async () => {
    const { app, sessions } = await harness();
    const first = await requestRun(app, 'echo first-run-output');
    expect(first.state).toBe('needs_approval');
    // Nothing runs before the person answers.
    expect(await sessions.list(operatorRequest(), thread)).toEqual([]);

    const approved = await person(app, `/runs/${first.runId}/approve`, 'POST');
    expect(approved.status).toBe(200);
    await expect
      .poll(async () => (await readRun(app, first.runId)).body.data.state, WAIT)
      .toBe('exited');
    const finished = (await readRun(app, first.runId)).body.data;
    expect(finished.exitCode).toBe(0);
    expect(finished.output).toContain('first-run-output');
    // The person still sees how the run they approved ended.
    const ended = await envelope<{ runs: TerminalRun[] }>(
      await person(app, `/runs?conversationId=${CONVERSATION}`),
    );
    expect(ended.data.runs).toMatchObject([
      { runId: first.runId, state: 'exited', exitCode: 0 },
    ]);

    // The same command again is a new request that waits for the person.
    const second = await requestRun(app, 'echo first-run-output');
    expect(second.state).toBe('needs_approval');
    const waited = await readRun(app, second.runId, '?waitSeconds=1');
    expect(waited.body.data.state).toBe('needs_approval');
    expect(await sessions.list(operatorRequest(), thread)).toHaveLength(1);
    const pending = await envelope<{ runs: TerminalRun[] }>(
      await person(app, `/runs?conversationId=${CONVERSATION}`),
    );
    expect(pending.data.runs.map((run) => `${run.runId}:${run.state}`)).toEqual(
      [`${first.runId}:exited`, `${second.runId}:needs_approval`],
    );

    // Declining it runs nothing, and the decision cannot be reversed.
    expect(
      (await person(app, `/runs/${second.runId}/decline`, 'POST')).status,
    ).toBe(200);
    expect((await readRun(app, second.runId)).body.data.state).toBe('declined');
    expect(
      (await person(app, `/runs/${second.runId}/approve`, 'POST')).status,
    ).toBe(409);
    expect(await sessions.list(operatorRequest(), thread)).toHaveLength(1);
    await sessions.dispose();
  }, 60_000);

  it('runs the command exactly as the person approved it, quotes included', async () => {
    const { app, sessions } = await harness();
    // cmd.exe keeps the quotes in what it echoes; sh removes them. Node's
    // own argument quoting had turned them into \" before cmd saw them.
    const run = await requestRun(app, 'echo "two  words"');
    await person(app, `/runs/${run.runId}/approve`, 'POST');
    await expect
      .poll(async () => (await readRun(app, run.runId)).body.data.state, WAIT)
      .toBe('exited');
    const { output, exitCode } = (await readRun(app, run.runId)).body.data;
    expect(exitCode).toBe(0);
    expect(output?.replace(/\r\n/g, '\n')).toContain(
      windows ? '"two  words"\n' : 'two  words\n',
    );
    expect(output).not.toContain('\\"');
    await sessions.dispose();
  }, 60_000);

  it('shows the exact command and directory, and refuses to run it anywhere else', async () => {
    const { app, root, sessions } = await harness();
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'second'));
    // A junction needs no privilege on Windows; POSIX ignores the type.
    await symlink(join(root, 'first'), join(root, 'here'), 'junction');
    const run = await requestRun(app, 'pwd', 'here');
    expect(run.cwd).toBe(join(root, 'first'));
    const listed = await envelope<{ runs: TerminalRun[] }>(
      await person(app, `/runs?conversationId=${CONVERSATION}`),
    );
    expect(listed.data.runs[0]).toMatchObject({
      command: 'pwd',
      cwd: join(root, 'first'),
    });

    // The directory now resolves somewhere the person was not shown.
    await unlink(join(root, 'here'));
    await symlink(join(root, 'second'), join(root, 'here'), 'junction');
    const approved = await person(app, `/runs/${run.runId}/approve`, 'POST');
    expect(approved.status).toBe(409);
    expect((await envelope<null>(approved)).error).toBe(
      'Its directory has changed',
    );
    expect((await readRun(app, run.runId)).body.data.state).toBe('failed');
    expect(await sessions.list(operatorRequest(), thread)).toEqual([]);
    await sessions.dispose();
  }, 60_000);

  it('keeps approval with a person who may send to the chat, and runs to the agent’s own chat', async () => {
    const { app, sessions } = await harness();
    const run = await requestRun(app, 'echo never');
    // An agent cannot approve its own request.
    expect(
      (
        await person(app, `/runs/${run.runId}/approve`, 'POST', {
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'token',
        })
      ).status,
    ).toBe(403);
    // Someone without terminal authority is refused.
    expect(
      (
        await app.request(`/runs/${run.runId}/approve`, {
          method: 'POST',
          headers: { 'x-test-principal': 'stranger' },
        })
      ).status,
    ).toBe(403);
    // Another conversation's agent cannot read it.
    expect(
      (await agent(app, `/${run.runId}`, { conversation: 'conv-other' }))
        .status,
    ).toBe(404);
    // A directory outside the chat's working directory is refused up front.
    const outside = await agent(app, '/', {
      method: 'POST',
      body: JSON.stringify({ command: 'pwd', subdirectory: '../..' }),
    });
    expect(outside.status).toBe(403);
    expect((await readRun(app, run.runId)).body.data.state).toBe(
      'needs_approval',
    );
    expect(await sessions.list(operatorRequest(), thread)).toEqual([]);
    await sessions.dispose();
  }, 60_000);
});

describe('script runner', () => {
  it('lists package scripts, runs one by name as a command session and restarts it', async () => {
    const bin = await realpath(makeTempDir('terminal-runs-bin-'));
    // On Windows a batch shim, as npm and pnpm install there: only cmd.exe
    // runs one, and spawning it directly fails with EINVAL.
    const manager = join(bin, windows ? 'fake pm.cmd' : 'fake-pm');
    await writeFile(
      manager,
      windows
        ? '@echo off\r\necho pm %* in %CD%\r\n'
        : '#!/bin/sh\necho "pm $@ in $(pwd)"\n',
    );
    await chmod(manager, 0o755);
    const { app, root, sessions } = await harness({
      fakePackageManager: manager,
    });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', '-x': 'nope' } }),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), '');

    const listed = await person(app, '/api/projects/alpha/terminal-scripts');
    expect(
      await envelope<{
        packageManager: string;
        scripts: ProjectTerminalScript[];
      }>(listed),
    ).toEqual({
      success: true,
      data: {
        packageManager: 'pnpm',
        scripts: [{ name: 'test', command: 'vitest' }],
      },
    });

    const missing = await app.request('/api/projects/alpha/terminal-scripts', {
      method: 'POST',
      headers: {
        'x-test-principal': 'operator',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ bindingKey: 'project', script: 'build' }),
    });
    expect(missing.status).toBe(409);

    const started = await app.request('/api/projects/alpha/terminal-scripts', {
      method: 'POST',
      headers: {
        'x-test-principal': 'operator',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ bindingKey: 'project', script: 'test' }),
    });
    expect(started.status).toBe(200);
    const { data: record } = await envelope<TerminalSessionRecord>(started);
    expect(record).toMatchObject({
      kind: 'command',
      launch: { kind: 'script', name: 'test' },
    });
    const scope = { projectId: project.id, bindingKey: 'project' };
    const output = async () =>
      (await sessions.readInternal(scope, record.terminalId)).journal.records
        .map((entry) => entry.data)
        .join('')
        .replace(/\r\n/g, '\n');
    await expect.poll(output, WAIT).toBe(`pm run test in ${root}\n`);
    await expect
      .poll(
        async () => (await sessions.list(operatorRequest(), scope))[0]?.status,
        WAIT,
      )
      .toBe('exited');

    // Add to chat names where an ended script ran, though no process remains.
    expect(
      await sessions.cwd(operatorRequest(), scope, record.terminalId),
    ).toBe(root);

    const restarted = await sessions.restart(
      operatorRequest(),
      scope,
      record.terminalId,
    );
    expect(restarted).toMatchObject({
      terminalId: record.terminalId,
      restart: { count: 1 },
    });
    await expect
      .poll(output, WAIT)
      .toBe(`pm run test in ${root}\npm run test in ${root}\n`);
    await sessions.dispose();
  }, 60_000);
});

function operatorRequest(): Request {
  return new Request('http://station.test/', {
    headers: { 'x-test-principal': 'operator' },
  });
}
