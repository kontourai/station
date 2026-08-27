import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { readBody } from './helpers/http-test-helpers.js';

/**
 * `station delegate` end-to-end CLI coverage (#977 Wave 3) — drives
 * `runCli(['delegate', ...])` against a real `http.createServer` mock
 * standing in for the six new thin routes
 * (`src-server/routes/orchestration/orchestration.ts`) plus the
 * already-wired `/delegations` and `/delegations/options` routes, following
 * `core-http.test.ts`'s real-HTTP-server pattern (not `fetch` mocking).
 */

interface DelegatedTaskRecord {
  taskId: string;
  status: string;
  environment: { id: string; name: string; kind: 'current' | 'ssh' };
  target: { kind: 'agent'; id: string };
  model?: string;
  parentTaskId?: string;
  events: Array<{ sequence: number; method: string; kind: string }>;
  // station#979: set when the create/continue prompt is the
  // 'trigger pending request' sentinel — lets tests exercise
  // `--on-request=fail`'s post-dispatch `observeDelegatedTask` check and the
  // status respond-command hint without a real target ever opening one.
  pendingRequest?: { id: string; title?: string; type?: string };
  // station#979 review r1 HIGH fix regression test: set when the create/
  // continue prompt is the 'trigger status probe failure' sentinel — the
  // NEXT status GET for this task 500s once, simulating a transient
  // failure on --on-request=fail's follow-up probe AFTER a successful
  // dispatch (never a dispatch failure itself).
  failNextStatus?: boolean;
}

/**
 * station#1463: the real server derives `slugJoin` from how the project was
 * resolved (local target, byte-equal verified path, or name alone). The mock
 * keys it off the requested slug so one server can exercise all three
 * renderings of the DEFAULT human output.
 */
function projectHandleFor(projectSlug: string) {
  const slugJoin = projectSlug.endsWith('-remote')
    ? 'unverified-cross-machine'
    : projectSlug.endsWith('-corroborated')
      ? 'directory-corroborated'
      : 'local';
  return { slug: projectSlug, path: `/work/${projectSlug}`, slugJoin };
}

describe('station delegate over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let consoleLog: MockInstance;
  let consoleError: MockInstance;
  const tasks = new Map<string, DelegatedTaskRecord>();
  let nextTaskSeq = 1;
  // station#978: captures every POST body this mock server receives, keyed
  // by pathname, so tests can assert the CLI's exact request shape (not
  // just the response) for modelOptions/cwd forwarding.
  const requestBodies: Array<{
    pathname: string;
    body: Record<string, unknown>;
  }> = [];

  beforeEach(async () => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestBodies.length = 0;
    tasks.clear();
    nextTaskSeq = 1;

    server = createServer(async (req, res) => {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body = method === 'POST' ? await readBody(req) : undefined;
      if (method === 'POST' && body) {
        requestBodies.push({ pathname: url.pathname, body });
      }

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (
        method === 'POST' &&
        url.pathname === '/api/orchestration/delegations'
      ) {
        const executionTarget = body.target as
          | {
              agent?: string;
              environment?: { kind?: string; id?: string };
              model?: { override?: string; options?: Record<string, unknown> };
              workspace?: { kind?: string; projectSlug?: string; cwd?: string };
            }
          | undefined;
        const selectedAgent = executionTarget?.agent;
        const selectedModel = executionTarget?.model?.override;
        const selectedModelOptions = executionTarget?.model?.options;
        const selectedWorkspace = executionTarget?.workspace;
        if (typeof selectedAgent !== 'string' || selectedAgent.length === 0) {
          sendJson(400, {
            success: false,
            error: 'Select an Agent',
          });
          return;
        }
        // station#978 AC4: mirror the real server's unsupported-option 400
        // (proven server-side in station-control-delegation.test.ts) so this
        // mock can verify the CLI surfaces it with the exit-3 classifier.
        if (selectedModelOptions && 'thinking' in selectedModelOptions) {
          sendJson(400, {
            success: false,
            error:
              "Unsupported option 'thinking' for codex target 'codex-runtime'",
          });
          return;
        }
        // station#978 review r1 HIGH fix: system-prompt passthrough is
        // explicitly out of scope — mirrors the real server's unconditional
        // rejection of modelOptions.systemPrompt (every provider, proven
        // server-side in orchestration-service.test.ts /
        // provider-model-options.test.ts) through the delegate path too.
        if (selectedModelOptions && 'systemPrompt' in selectedModelOptions) {
          sendJson(400, {
            success: false,
            error:
              "Unsupported option 'systemPrompt' for codex target 'codex-runtime'",
          });
          return;
        }
        const taskId = `task:${nextTaskSeq++}`;
        const target = {
          kind: 'agent',
          id: selectedAgent,
        } as const;
        const environment = {
          id: executionTarget?.environment?.id ?? 'env-current',
          name:
            executionTarget?.environment?.kind === 'saved'
              ? 'Saved environment'
              : 'Current environment',
          kind:
            executionTarget?.environment?.kind === 'saved'
              ? ('ssh' as const)
              : ('current' as const),
        };
        const record: DelegatedTaskRecord = {
          taskId,
          // Same sentinel shape as `trigger pending request` below: a task
          // that has already ENDED is the state station#3409 is about, and
          // this stub has no other way to reach it.
          status:
            body.prompt === 'trigger completed task' ? 'completed' : 'running',
          environment,
          target,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}),
          events: [
            { sequence: 1, method: 'turn.started', kind: 'lifecycle' },
            { sequence: 2, method: 'turn.completed', kind: 'message' },
          ],
          ...(body.prompt === 'trigger pending request'
            ? {
                pendingRequest: {
                  id: 'req-pending-1',
                  title: 'Approve the write?',
                  type: 'approval',
                },
              }
            : {}),
          ...(body.prompt === 'trigger status probe failure'
            ? { failNextStatus: true }
            : {}),
        };
        tasks.set(taskId, record);
        sendJson(200, {
          success: true,
          data: {
            taskId,
            sessionId: taskId,
            ...(body.prompt === 'legacy identity response'
              ? {}
              : { conversationId: taskId, currentSessionId: taskId }),
            status: 'dispatched',
            environment,
            target,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}),
            ...(selectedWorkspace?.kind === 'project' &&
            typeof selectedWorkspace.projectSlug === 'string'
              ? { project: projectHandleFor(selectedWorkspace.projectSlug) }
              : {}),
          },
        });
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/orchestration/delegations/options'
      ) {
        sendJson(200, {
          success: true,
          data: {
            environment: {
              id: 'env-current',
              name: 'Current environment',
              kind: 'current',
            },
            targets: [
              {
                id: 'default',
                name: 'Default Agent',
                kind: 'station-agent',
                ready: true,
                models: [],
                capabilities: {
                  resume: true,
                  interrupt: true,
                  approvals: true,
                  modelSelection: false,
                },
              },
            ],
          },
        });
        return;
      }

      const statusMatch = url.pathname.match(
        /^\/api\/orchestration\/delegations\/([^/]+)$/,
      );
      if (method === 'GET' && statusMatch) {
        const taskId = decodeURIComponent(statusMatch[1]);
        const record = tasks.get(taskId);
        if (!record) {
          sendJson(400, { success: false, error: 'Delegated task not found' });
          return;
        }
        if (record.failNextStatus) {
          sendJson(500, {
            success: false,
            error: 'Synthetic transient status-probe failure',
          });
          return;
        }
        sendJson(200, {
          success: true,
          data: {
            conversationId: record.taskId,
            taskId: record.taskId,
            sessionId: record.taskId,
            currentSessionId: record.taskId,
            status: record.status,
            environment: record.environment,
            target: record.target,
            ...(record.model ? { model: record.model } : {}),
            ...(record.parentTaskId
              ? { parentTaskId: record.parentTaskId }
              : {}),
            eventCount: record.events.length,
            ...(record.pendingRequest
              ? { pendingRequest: record.pendingRequest }
              : {}),
            canInterrupt: record.status === 'running',
            resumable: record.status !== 'completed',
          },
        });
        return;
      }

      const eventsMatch = url.pathname.match(
        /^\/api\/orchestration\/delegations\/([^/]+)\/events$/,
      );
      if (method === 'GET' && eventsMatch) {
        const taskId = decodeURIComponent(eventsMatch[1]);
        const record = tasks.get(taskId);
        if (!record) {
          sendJson(400, { success: false, error: 'Delegated task not found' });
          return;
        }
        const cursor = url.searchParams.get('cursor');
        const after = cursor
          ? Number(cursor.replace('station-task-events:v1:', ''))
          : 0;
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const page = record.events
          .filter((event) => event.sequence > after)
          .slice(0, limit);
        const nextSequence =
          page.length > 0 ? page[page.length - 1].sequence : after;
        sendJson(200, {
          success: true,
          data: {
            conversationId: record.taskId,
            taskId: record.taskId,
            sessionId: record.taskId,
            currentSessionId: record.taskId,
            status: record.status,
            environment: record.environment,
            target: record.target,
            eventCount: record.events.length,
            events: page,
            nextCursor: `station-task-events:v1:${nextSequence}`,
            hasMore: nextSequence < record.events.length,
            canInterrupt: record.status === 'running',
            resumable: record.status !== 'completed',
          },
        });
        return;
      }

      const continueMatch = url.pathname.match(
        /^\/api\/orchestration\/delegations\/([^/]+)\/continue$/,
      );
      if (method === 'POST' && continueMatch) {
        const taskId = decodeURIComponent(continueMatch[1]);
        const record = tasks.get(taskId);
        if (!record) {
          sendJson(400, { success: false, error: 'Delegated task not found' });
          return;
        }
        if (body.message === 'trigger pending request') {
          record.pendingRequest = {
            id: 'req-pending-1',
            title: 'Approve the write?',
            type: 'approval',
          };
        }
        if (body.message === 'trigger status probe failure') {
          record.failNextStatus = true;
        }
        sendJson(200, {
          success: true,
          data: {
            conversationId: record.taskId,
            taskId: record.taskId,
            sessionId: record.taskId,
            currentSessionId: record.taskId,
            status: 'dispatched',
            environment: record.environment,
            target: record.target,
            ...(body.model ? { model: body.model } : {}),
          },
        });
        return;
      }

      const respondMatch = url.pathname.match(
        /^\/api\/orchestration\/delegations\/([^/]+)\/respond$/,
      );
      if (method === 'POST' && respondMatch) {
        const taskId = decodeURIComponent(respondMatch[1]);
        const record = tasks.get(taskId);
        if (!record) {
          sendJson(400, { success: false, error: 'Delegated task not found' });
          return;
        }
        sendJson(200, {
          success: true,
          data: {
            conversationId: record.taskId,
            taskId: record.taskId,
            sessionId: record.taskId,
            currentSessionId: record.taskId,
            requestId: body.requestId,
            status: 'resolved',
            decision: body.decision,
            environment: record.environment,
            target: record.target,
          },
        });
        return;
      }

      const interruptMatch = url.pathname.match(
        /^\/api\/orchestration\/delegations\/([^/]+)\/interrupt$/,
      );
      if (method === 'POST' && interruptMatch) {
        const taskId = decodeURIComponent(interruptMatch[1]);
        const record = tasks.get(taskId);
        if (!record) {
          sendJson(400, { success: false, error: 'Delegated task not found' });
          return;
        }
        sendJson(200, {
          success: true,
          data: {
            conversationId: record.taskId,
            taskId: record.taskId,
            sessionId: record.taskId,
            currentSessionId: record.taskId,
            status: record.status,
            environment: record.environment,
            target: record.target,
            eventCount: record.events.length,
            canInterrupt: record.status === 'running',
            resumable: record.status !== 'completed',
            interruptRequested: true,
          },
        });
        return;
      }

      sendJson(404, { success: false, error: 'Unhandled route' });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    apiBase = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    vi.restoreAllMocks();
  });

  test('create dispatches to a Station agent and returns its task handle (AC1)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);

    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');
    const payload = JSON.parse(printed);
    expect(payload).toMatchObject({
      ok: true,
      kind: 'delegate.create',
      data: {
        status: 'dispatched',
        target: { kind: 'agent', id: 'default' },
      },
    });
    expect(payload.data.taskId).toMatch(/^task:/);
    expect(payload.data).toMatchObject({
      conversationId: payload.data.taskId,
      sessionId: payload.data.taskId,
      currentSessionId: payload.data.taskId,
    });
    // station#3409: a dispatch handle records an accepted write; it reads
    // back no lifecycle state, so it makes no claim about whether a LATER
    // turn would be accepted. `delegate status` is where that is computed.
    expect(payload.data).not.toHaveProperty('resumable');
  });

  /**
   * station#3409, and the human-readable surface specifically. Every other
   * assertion in this file passes `--json`, so the sentences an operator
   * actually reads were unreviewed — which is how `dispatched (resumable)`
   * survived on a task whose only resume verb refuses it.
   */
  test('create names the follow-up command instead of announcing bare resumability', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);

    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('Status: dispatched');
    // The word on its own described a window that closes on completion, with
    // nothing at this call site able to see it close.
    expect(printed).not.toContain('(resumable)');
    expect(printed).toMatch(
      /Continue this conversation: station delegate --session='task:[^']+' "<message>"/,
    );
  });

  test('legacy Station response identity is normalized before human continuation copy renders (station#3414)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'legacy identity response',
      `--api-base=${apiBase}`,
    ]);
    const jsonOutput = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(jsonOutput.data).toMatchObject({
      taskId: expect.stringMatching(/^task:/),
      conversationId: expect.stringMatching(/^task:/),
      sessionId: expect.stringMatching(/^task:/),
      currentSessionId: expect.stringMatching(/^task:/),
    });
    expect(jsonOutput.data).not.toHaveProperty('resumable');
    consoleLog.mockClear();

    await runCli([
      'delegate',
      '--agent=default',
      'legacy identity response',
      `--api-base=${apiBase}`,
    ]);

    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toMatch(
      /station delegate --session='task:[^']+' "<message>"/,
    );
    expect(printed).not.toContain('undefined');
  });

  test('status discloses a closed follow-up window and names the way forward', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'trigger completed task',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'status',
      created.data.taskId,
      `--api-base=${apiBase}`,
    ]);
    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');

    expect(printed).toContain('no longer accepts follow-up turns');
    expect(printed).toContain(
      `Carry forward: station delegate create --parent-task=${created.data.taskId}`,
    );
    expect(printed).not.toContain('Continue this conversation:');
  });

  test('status offers the follow-up command while the task is still running', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'status',
      created.data.taskId,
      `--api-base=${apiBase}`,
    ]);
    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');

    expect(printed).not.toContain('no longer accepts follow-up turns');
    expect(printed).toContain(
      `Continue this conversation: station delegate --session='${created.data.conversationId}' "<message>"`,
    );
  });

  test('rejects the retired direct connection selector before any request', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'delegate',
        '--connection=codex-runtime',
        'Review the diff',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('--connection is not an execution selector');
    expect(requestBodies).toHaveLength(0);
  });

  test('--on sends the saved Environment in the canonical ExecutionTarget', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=codex',
      '--on=env-brian-media',
      '--model=gpt-5.6-sol',
      '--project=station',
      'Run the focused tests',
      `--api-base=${apiBase}`,
    ]);

    const request = requestBodies.find(
      (entry) => entry.pathname === '/api/orchestration/delegations',
    );
    expect(request?.body).toMatchObject({
      target: {
        environment: { kind: 'saved', id: 'env-brian-media' },
        agent: 'codex',
        model: { override: 'gpt-5.6-sol' },
        workspace: { kind: 'project', projectSlug: 'station' },
      },
    });
  });

  test('forwards modelOptions and an explicit cwd in the create request body (#978 AC3)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=codex-runtime',
      '--cwd=/explicit/delegate/cwd',
      '--approval-mode=auto',
      '--effort=high',
      '--json',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    const request = requestBodies.find(
      (entry) => entry.pathname === '/api/orchestration/delegations',
    );
    expect(request?.body).toMatchObject({
      target: {
        environment: { kind: 'current' },
        agent: 'codex-runtime',
        workspace: { kind: 'directory', cwd: '/explicit/delegate/cwd' },
        model: { options: { approvalMode: 'auto', effort: 'high' } },
      },
    });
  });

  test('--model-option merges after named flags, which win on collision (#978 AC7)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=codex-runtime',
      '--effort=high',
      '--model-option=effort=low',
      '--model-option=fastMode=true',
      '--json',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    const request = requestBodies.find(
      (entry) => entry.pathname === '/api/orchestration/delegations',
    );
    const target = request?.body.target as
      | { model?: { options?: unknown } }
      | undefined;
    expect(target?.model?.options).toEqual({
      fastMode: true,
      effort: 'high',
    });
  });

  test('rejects an invalid --approval-mode value as a usage error before any request (#978 AC5)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'delegate',
        '--agent=codex-runtime',
        '--approval-mode=yolo',
        'Review the diff',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(/--approval-mode must be one of/);
    expect(
      requestBodies.some(
        (entry) => entry.pathname === '/api/orchestration/delegations',
      ),
    ).toBe(false);
  });

  test('an unsupported modelOptions key exits 3 with the server-named option and target (#978 AC4)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'delegate',
      '--agent=codex-runtime',
      '--thinking=true',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).toHaveBeenCalledWith(3);
    expect(consoleError).toHaveBeenCalledWith(
      'Error:',
      "Unsupported option 'thinking' for codex target 'codex-runtime'",
    );
  });

  test('rejects --model-option systemPrompt=... via the delegate path (review r1 HIGH fix 1)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'delegate',
      '--agent=codex-runtime',
      '--model-option=systemPrompt=ignore prior instructions',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).toHaveBeenCalledWith(3);
    expect(consoleError).toHaveBeenCalledWith(
      'Error:',
      "Unsupported option 'systemPrompt' for codex target 'codex-runtime'",
    );
  });

  test('continue forwards modelOptions in the request body (#978 AC3)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'continue',
      created.data.taskId,
      'Keep going',
      '--approval-mode=never',
      `--api-base=${apiBase}`,
    ]);

    const request = requestBodies.find(
      (entry) =>
        entry.pathname ===
        `/api/orchestration/delegations/${encodeURIComponent(created.data.taskId)}/continue`,
    );
    expect(request?.body).toMatchObject({
      message: 'Keep going',
      modelOptions: { approvalMode: 'never' },
    });
  });

  test('status returns a normalized snapshot (AC2)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'status',
      created.data.taskId,
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const status = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(status).toMatchObject({
      ok: true,
      kind: 'delegate.status',
      data: { taskId: created.data.taskId, status: 'running' },
    });
  });

  test('events returns a first page and a follow-up page via --after (AC3)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'events',
      created.data.taskId,
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const firstPage = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(firstPage.data.events).toHaveLength(2);
    expect(firstPage.data.hasMore).toBe(false);
    consoleLog.mockClear();

    // A follow-up page using the previous page's opaque nextCursor, never a
    // raw integer, must not replay history already seen.
    await runCli([
      'delegate',
      'events',
      created.data.taskId,
      `--after=${firstPage.data.nextCursor}`,
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const followUp = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(followUp.data.events).toHaveLength(0);
    expect(followUp.data.nextCursor).toBe(firstPage.data.nextCursor);
  });

  test('conversation selector continues the root conversation into its current child Session (station#3414)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      `--session=${created.data.conversationId}`,
      'Keep going',
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const continued = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(continued).toMatchObject({
      ok: true,
      kind: 'delegate.continue',
      data: {
        conversationId: created.data.conversationId,
        taskId: created.data.taskId,
        sessionId: created.data.sessionId,
        currentSessionId: created.data.currentSessionId,
        status: 'dispatched',
      },
    });
    expect(requestBodies.at(-1)).toMatchObject({
      pathname: `/api/orchestration/delegations/${encodeURIComponent(created.data.conversationId)}/continue`,
      body: { message: 'Keep going' },
    });
  });

  test('delegate continue remains a deprecated compatibility alias for task and cli identities (station#3414)', async () => {
    const { runCli } = await import('../cli.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'continue',
      created.data.taskId,
      'Keep going',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const continued = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(continued).toMatchObject({
      kind: 'delegate.continue',
      data: { conversationId: created.data.conversationId },
    });
    expect(
      stderrWrite.mock.calls.map((call) => String(call[0])).join(''),
    ).toContain("Deprecated: 'station delegate continue");

    // The selector is opaque: a legacy cli: conversation uses the same route
    // rather than a separate task-only resume path.
    const cliId = 'cli:legacy-conversation';
    tasks.set(cliId, {
      taskId: cliId,
      status: 'running',
      environment: {
        id: 'env-current',
        name: 'Current environment',
        kind: 'current',
      },
      target: { kind: 'agent', id: 'default' },
      events: [],
    });
    consoleLog.mockClear();
    await runCli([
      'delegate',
      `--session=${cliId}`,
      'Continue legacy chat',
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const cliContinued = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(cliContinued.data.conversationId).toBe(cliId);
  });

  test('respond covers all four decisions (AC5)', async () => {
    const { runCli } = await import('../cli.js');
    const decisions = ['accept', 'acceptForSession', 'decline', 'cancel'];

    for (const decision of decisions) {
      await runCli([
        'delegate',
        '--agent=default',
        '--json',
        'Ship it',
        `--api-base=${apiBase}`,
      ]);
      const created = JSON.parse(
        consoleLog.mock.calls.map((call) => call[0]).join('\n'),
      );
      consoleLog.mockClear();

      await runCli([
        'delegate',
        'respond',
        created.data.taskId,
        'req-1',
        decision,
        '--json',
        `--api-base=${apiBase}`,
      ]);
      const responded = JSON.parse(
        consoleLog.mock.calls.map((call) => call[0]).join('\n'),
      );
      expect(responded.data.decision).toBe(decision);
      consoleLog.mockClear();
    }
  });

  test('interrupt stops the active turn while keeping the task resumable (AC6)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'interrupt',
      created.data.taskId,
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const interrupted = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(interrupted).toMatchObject({
      ok: true,
      kind: 'delegate.interrupt',
      data: { taskId: created.data.taskId, resumable: true },
    });
  });

  test('targets lists ready Station agents and External agents (AC7)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['delegate', 'targets', '--json', `--api-base=${apiBase}`]);
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload).toMatchObject({
      ok: true,
      kind: 'delegate.targets',
      data: { targets: [{ id: 'default', kind: 'station-agent' }] },
    });
  });

  test('--parent-task produces a child task whose status carries parentTaskId (AC8)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--parent-task=task:parent-1',
      '--json',
      'Ship the child task',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(created.data.parentTaskId).toBe('task:parent-1');
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'status',
      created.data.taskId,
      '--json',
      `--api-base=${apiBase}`,
    ]);
    const status = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(status.data.parentTaskId).toBe('task:parent-1');
  });

  test('--json emits the one stable shape for every verb (AC10)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['delegate', 'targets', '--json', `--api-base=${apiBase}`]);
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(Object.keys(payload).sort()).toEqual(['data', 'kind', 'ok']);
    expect(payload.ok).toBe(true);
    expect(payload.kind).toBe('delegate.targets');
  });

  test('a missing positional is a usage error and exits 1 before any request (AC9)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['delegate', 'status', `--api-base=${apiBase}`]),
    ).rejects.toThrow('Missing required argument: task id');
  });

  test('a 400 delegation rejection exits 3, distinct from a transport failure (AC9)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'delegate',
      'status',
      'task:does-not-exist',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).toHaveBeenCalledWith(3);
    expect(consoleError).toHaveBeenCalledWith(
      'Error:',
      'Delegated task not found',
    );
  });

  test('a transport failure (server unreachable) exits 2 (AC9)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    // Nothing listens on this port after the mock server above bound to its
    // own ephemeral one — same "closed port" shape as `request-failure-
    // messages.test.ts`'s synthetic ECONNREFUSED, but exercised for real.
    const unreachable = 'http://127.0.0.1:1';

    await runCli([
      'delegate',
      'status',
      'task:whatever',
      `--api-base=${unreachable}`,
    ]);

    expect(exit).toHaveBeenCalledWith(2);
  });

  // AC14 regression coverage for the DEFAULT (non---json) human output:
  // round-1 independent review reproduced internal enums ('agent-app',
  // 'runtime') leaking verbatim into user-facing text because every earlier
  // test passed --json. These pin the canonical Agent rendering and
  // method-only event lines for the summary formatters.
  function printedText(): string {
    return consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
  }

  test('human output: create renders the canonical Agent target (AC14)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=codex-runtime',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    const text = printedText();
    expect(text).toContain("to Agent 'codex-runtime'");
    expect(text).not.toContain('agent-app');
  });

  // station#1463 FIX ROUND. `slugJoin` reached `--json` only, so the DEFAULT
  // human path rendered an unverified cross-machine join as a settled
  // binding — the exact class as the AC14 block above (station#977: internal
  // state invisible because every test passed --json). These are the
  // non---json assertions that were missing for this field entirely.
  test('human output: create discloses an unverified cross-machine project join (station#1463)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--project=station-remote',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    expect(printedText()).toContain(
      'Project: station-remote (unverified name match)',
    );
  });

  test('human output: create discloses a directory-corroborated join as still name-unverified (station#1463)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--project=station-corroborated',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    expect(printedText()).toContain(
      'Project: station-corroborated (unverified name match, directory corroborated)',
    );
  });

  test('human output: a local project join carries no qualifier (station#1463)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--project=station',
      'Review the diff',
      `--api-base=${apiBase}`,
    ]);

    // The value of the qualifier is that its ABSENCE means something too: a
    // caveat printed on every join would carry no information at all.
    const text = printedText();
    expect(text).toContain('Project: station');
    expect(text).not.toContain('unverified');
  });

  test('human output: status renders "Agent" and no internal enum (AC14)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const taskId = printedText().match(/task:[0-9]+/)?.[0];
    expect(taskId).toBeTruthy();
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'status',
      String(taskId),
      `--api-base=${apiBase}`,
    ]);

    const text = printedText();
    expect(text).toContain("Target: Agent 'default'");
    expect(text).not.toContain('station-agent');
  });

  test('human output: events lines are method-only, no internal kind bucket (AC14)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const taskId = printedText().match(/task:[0-9]+/)?.[0];
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'events',
      String(taskId),
      `--api-base=${apiBase}`,
    ]);

    const text = printedText();
    expect(text).toMatch(/\[1\] turn\.started/);
    // No "kind/" prefix: '[1] lifecycle/turn.started' must not come back.
    expect(text).not.toMatch(/\[\d+\] [a-z-]+\//);
  });

  test('human output: targets rows use glossary vocabulary (AC14)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['delegate', 'targets', `--api-base=${apiBase}`]);

    const text = printedText();
    expect(text).toContain('Station agent default');
    expect(text).not.toContain('station-agent');
    expect(text).not.toContain('agent-app');
  });

  test('status prints a station delegate respond hint when a request is pending (station#979)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      'trigger pending request',
      `--api-base=${apiBase}`,
    ]);
    const taskId = printedText().match(/task:[0-9]+/)?.[0];
    consoleLog.mockClear();

    await runCli([
      'delegate',
      'status',
      String(taskId),
      `--api-base=${apiBase}`,
    ]);

    const text = printedText();
    expect(text).toContain(
      'Pending request: req-pending-1 — Approve the write?',
    );
    expect(text).toContain(
      `Respond: station delegate respond '${taskId}' 'req-pending-1' <accept|acceptForSession|decline|cancel>`,
    );
  });

  test('--on-request=wait (default) on create does not check for a pending request (station#979 AC3 parity)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'trigger pending request',
      `--api-base=${apiBase}`,
    ]);

    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload.kind).toBe('delegate.create');
    expect(payload.data.status).toBe('dispatched');
    expect(payload.data.pendingRequest).toBeUndefined();
  });

  test('--on-request=fail on create exits distinctly with the pending requestId when one is already open (station#979 AC4 parity)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'delegate',
      '--agent=default',
      '--on-request=fail',
      '--json',
      'trigger pending request',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).toHaveBeenCalledWith(4);
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload.kind).toBe('delegate.create');
    expect(payload.data.pendingRequest.requestId).toBe('req-pending-1');
    expect(payload.data.pendingRequest.respondCommand).toMatch(
      /^station delegate respond 'task:\d+' 'req-pending-1' <accept\|acceptForSession\|decline\|cancel>$/,
    );
  });

  test('--on-request=fail on create prints the ordinary success output when no request is pending (station#979)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'delegate',
      '--agent=default',
      '--on-request=fail',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).not.toHaveBeenCalled();
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload.kind).toBe('delegate.create');
    expect(payload.data.status).toBe('dispatched');
  });

  test('--on-request=fail on continue exits distinctly with the pending requestId (station#979 AC4 parity)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'delegate',
      'continue',
      created.data.taskId,
      'trigger pending request',
      '--on-request=fail',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).toHaveBeenCalledWith(4);
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload.kind).toBe('delegate.continue');
    expect(payload.data.pendingRequest.requestId).toBe('req-pending-1');
  });

  test('--on-request=fail whose follow-up status probe errors AFTER a successful create still prints the taskId and does not exit 2/3 (station#979 review r1 HIGH fix)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli([
      'delegate',
      '--agent=default',
      '--on-request=fail',
      '--json',
      'trigger status probe failure',
      `--api-base=${apiBase}`,
    ]);

    // The dispatch itself succeeded — a transient failure on the follow-up
    // observeDelegatedTask probe must never be classified as a transport (2)
    // or rejection (3) failure of the dispatch, and must never be reported
    // via process.exit at all here (it is best-effort and swallowed with a
    // warning).
    expect(exit).not.toHaveBeenCalled();
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload.kind).toBe('delegate.create');
    expect(payload.data.taskId).toMatch(/^task:/);
    expect(payload.data.status).toBe('dispatched');
    expect(
      stderrWrite.mock.calls.map((call) => String(call[0])).join(''),
    ).toContain('could not check for a pending request');
  });

  test('--on-request=fail whose follow-up status probe errors AFTER a successful continue still prints the taskId and does not exit 2/3 (station#979 review r1 HIGH fix)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'delegate',
      '--agent=default',
      '--json',
      'Ship it',
      `--api-base=${apiBase}`,
    ]);
    const created = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    consoleLog.mockClear();
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli([
      'delegate',
      'continue',
      created.data.taskId,
      'trigger status probe failure',
      '--on-request=fail',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).not.toHaveBeenCalled();
    const payload = JSON.parse(
      consoleLog.mock.calls.map((call) => call[0]).join('\n'),
    );
    expect(payload.kind).toBe('delegate.continue');
    expect(payload.data.taskId).toBe(created.data.taskId);
    expect(
      stderrWrite.mock.calls.map((call) => String(call[0])).join(''),
    ).toContain('could not check for a pending request');
  });

  test('rejects an invalid --on-request value as a usage error before any request (station#979)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'delegate',
        '--agent=default',
        '--on-request=explode',
        'Ship it',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(/--on-request must be 'wait' or 'fail'/);
    expect(
      requestBodies.some(
        (entry) => entry.pathname === '/api/orchestration/delegations',
      ),
    ).toBe(false);
  });
});
