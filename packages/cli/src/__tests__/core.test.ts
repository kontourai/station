import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: Array<Record<string, unknown>>) {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .concat('data: [DONE]\n\n')
    .join('');
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('runCoreCommand', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let stdoutWrite: MockInstance;
  let consoleLog: MockInstance;
  let consoleError: MockInstance;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    stdoutWrite = vi.spyOn(process.stdout, 'write');
    stdoutWrite.mockImplementation(() => true);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  test('lists agents through the enriched API surface', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [{ slug: 'station', name: 'Default Agent' }],
      }),
    );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('agents', ['list']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/agents',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify([{ slug: 'station', name: 'Default Agent' }], null, 2),
    );
  });

  test('agents get prints the server-derived built-in and configured delegated-child denials', async () => {
    const { createEnrichedAgentRoutes } = await import(
      '../../../../src-server/routes/agents/enriched-agents.js'
    );
    const app = createEnrichedAgentRoutes({
      agentMetadataMap: new Map([
        ['writer', { slug: 'writer', name: 'Writer' }],
      ]),
      activeAgents: new Map(),
      loadAgent: async () => ({
        name: 'Writer',
        prompt: 'Write.',
        delegation: { blockedTools: ['filesystem_delete_*'] },
      }),
      listAgents: async () => [{ slug: 'writer', name: 'Writer' }],
      getDefaultAgentIds: async () => new Set(),
      defaultModel: 'managed-default',
      defaultTools: { mcpServers: [], autoApprove: [] },
      getRuntimeConnections: async () => [],
      logger: { warn: vi.fn(), error: vi.fn() } as any,
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return app.request(
        `${url.pathname.replace(/^\/api\/agents/, '')}${url.search}`,
        init as RequestInit,
      );
    });

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('agents', ['get', 'writer']);

    const output = JSON.parse(consoleLog.mock.calls[0][0]);
    expect(output.deniedCommandCatalog.builtIn).toContainEqual({
      pattern: 'station-control_send_message',
      refusal:
        'Refuses a delegated child from sending messages through Station control.',
    });
    expect(output.deniedCommandCatalog.operatorConfigured).toEqual([
      {
        pattern: 'filesystem_delete_*',
        refusal:
          "Refuses a delegated child from using tools matching 'filesystem_delete_*' because this Agent is configured to deny them.",
      },
    ]);
  });

  test('creates a project from inline JSON payload data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { slug: 'demo', name: 'Demo Project' },
      }),
    );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('projects', [
      'create',
      '--data={"name":"Demo Project","slug":"demo"}',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/projects',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"Demo Project","slug":"demo"}',
      }),
    );
  });

  test('discloses the resolved Station and endpoint before a verbose mutation', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { slug: 'demo' } }),
    );
    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('projects', [
      'create',
      '--data={"name":"Demo","slug":"demo"}',
      '--verbose',
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      'Target: station=direct endpoint=http://127.0.0.1:3141 source=loopback',
    );
  });

  test('lists, reads, and creates tasks through the generic task resource', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [{ id: 'task-1', projectId: 'project-1', title: 'Plan' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: 'task/with space',
            projectId: 'project-1',
            title: 'Plan',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: 'task-2', projectId: 'project-1', title: 'Create' },
        }),
      );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('tasks', ['list']);
    await runCoreCommand('tasks', ['get', 'task/with space']);
    await runCoreCommand('tasks', [
      'create',
      '--json',
      '{"projectId":"project-1","title":"Create"}',
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3141/api/tasks',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:3141/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: '{"projectId":"project-1","title":"Create"}',
      }),
    );
  });

  test('attaches an exact assistant turn to a Task through the canonical reference route', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          id: 'link-1',
          targetType: 'turn',
          relationType: 'references_turn',
        },
      }),
    );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('tasks', [
      'attach-turn',
      'task/with space',
      '--session=session-1',
      '--turn=turn-1',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/references',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'turn',
          sessionId: 'session-1',
          turnId: 'turn-1',
          sourceSurface: 'cli',
        }),
      }),
    );
  });

  test('requires both members of an exact turn identity before attaching', async () => {
    const { runCoreCommand } = await import('../commands/core.js');
    await expect(
      runCoreCommand('tasks', ['attach-turn', 'task-1', '--session=session-1']),
    ).rejects.toThrow('attach-turn requires --turn=<turnId>.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reopens a Task exact answer basis through its reauthorizing projection route', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          message: { parts: [{ type: 'text', text: 'Exact answer' }] },
        },
      }),
    );
    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('tasks', ['show-turn', 'task/with space']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('prints a deterministic Task Basis summary, preserves JSON mode, and rejects an unknown format', async () => {
    const basis = {
      version: 'station.task-basis-collection/v4',
      taskId: 'task-1',
      answers: [],
      unassociated: [],
      keptToolResults: [],
      keptGateEvaluations: [],
      gaps: [],
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: basis }),
    );
    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('tasks', ['basis', 'task-1']);
    expect(consoleLog).toHaveBeenCalledWith(
      'scope=task collection answers=0 unassociated=0 kept-tool-results=0 kept-gate-evaluations=0',
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: basis }),
    );
    await runCoreCommand('tasks', ['basis', 'task-1', '--format=json']);
    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(basis));
    await expect(
      runCoreCommand('tasks', ['basis', 'task-1', '--format=yaml']),
    ).rejects.toThrow('basis --format must be summary or json.');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { apiVersion: 'future/v99' } }),
    );
    await expect(runCoreCommand('tasks', ['basis', 'task-1'])).rejects.toThrow(
      'Task basis unavailable',
    );
  });

  test('lists, attaches, replaces, removes, and shows answer support through encoded routes', async () => {
    for (let index = 0; index < 6; index += 1)
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { id: 'support-1' } }),
      );
    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('tasks', [
      'list-support-bundles',
      'task/with space',
      '--reference=reference/1',
    ]);
    await runCoreCommand('tasks', [
      'list-support-claims',
      'task/with space',
      '--reference=reference/1',
      '--bundle=sb1.bundle',
    ]);
    await runCoreCommand('tasks', [
      'attach-support',
      'task/with space',
      '--reference=reference/1',
      '--bundle=sb1.bundle',
      '--claim=claim-a',
    ]);
    await runCoreCommand('tasks', [
      'replace-support',
      'task/with space',
      '--reference=reference/1',
      '--bundle=sb1.bundle',
      '--claim=claim-b',
      '--revision=1',
    ]);
    await runCoreCommand('tasks', [
      'remove-support',
      'task/with space',
      '--reference=reference/1',
      '--revision=2',
    ]);
    await runCoreCommand('tasks', ['show-support', 'task/with space']);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references/reference%2F1/support/bundles',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references/reference%2F1/support/bundles/sb1.bundle/claims',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references/reference%2F1/support',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references/reference%2F1/support',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references/reference%2F1/support',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/turn-references',
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ bundleId: 'sb1.bundle', claimId: 'claim-a' }),
      }),
    );
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          bundleId: 'sb1.bundle',
          claimId: 'claim-b',
          expectedRevision: 1,
        }),
      }),
    );
    expect(fetchMock.mock.calls[4]?.[1]).toEqual(
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: 2 }),
      }),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({ success: true }, null, 2),
    );
  });

  test('requires an explicit observed revision for support replace and removal', async () => {
    const { runCoreCommand } = await import('../commands/core.js');
    await expect(
      runCoreCommand('tasks', [
        'replace-support',
        'task-1',
        '--reference=reference-1',
        '--bundle=bundle-1',
        '--claim=claim-1',
      ]),
    ).rejects.toThrow('replace-support requires --revision=<revision>.');
    await expect(
      runCoreCommand('tasks', [
        'remove-support',
        'task-1',
        '--reference=reference-1',
        '--revision=0',
      ]),
    ).rejects.toThrow('remove-support requires --revision=<positive integer>.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('routes Task output list/get/keep/delete through encoded canonical paths', async () => {
    for (let index = 0; index < 4; index += 1)
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: {} }),
      );
    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('tasks', ['list-outputs', 'task/with space']);
    await runCoreCommand('tasks', [
      'get-output',
      'task/with space',
      'output/1',
    ]);
    await runCoreCommand('tasks', [
      'keep-output',
      'task/with space',
      '--path=reports/result.json',
      '--title=Result',
      '--operation=operation-1',
    ]);
    await runCoreCommand('tasks', [
      'delete-output',
      'task/with space',
      'output/1',
    ]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/outputs',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/outputs/output%2F1',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/outputs',
      'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/outputs/output%2F1',
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operationId: 'operation-1',
          relativePath: 'reports/result.json',
          title: 'Result',
        }),
      }),
    );
  });

  test('requires an explicit absolute destination before downloading a Task output', async () => {
    const { runCoreCommand } = await import('../commands/core.js');
    await expect(
      runCoreCommand('tasks', ['download-output', 'task-1', 'output-1']),
    ).rejects.toThrow('download-output requires --out=<destination>.');
    await expect(
      runCoreCommand('tasks', [
        'download-output',
        'task-1',
        'output-1',
        '--out=relative.txt',
      ]),
    ).rejects.toThrow('download-output destination must be an absolute path.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('downloads exact Task output bytes only to a new explicit safe destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-cli-output-'));
    try {
      const destination = join(root, 'result.bin');
      fetchMock.mockResolvedValueOnce(
        new Response(Buffer.from('exact bytes'), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );
      const { runCoreCommand } = await import('../commands/core.js');
      await runCoreCommand('tasks', [
        'download-output',
        'task/with space',
        'out/1',
        `--out=${destination}`,
      ]);
      expect(readFileSync(destination, 'utf8')).toBe('exact bytes');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3141/api/tasks/task%2Fwith%20space/outputs/out%2F1/content',
        expect.objectContaining({ method: 'GET' }),
      );

      writeFileSync(join(root, 'existing.bin'), 'keep');
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'out',
          `--out=${join(root, 'existing.bin')}`,
        ]),
      ).rejects.toThrow('refuses to overwrite');
      expect(readFileSync(join(root, 'existing.bin'), 'utf8')).toBe('keep');

      symlinkSync(destination, join(root, 'link.bin'));
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'out',
          `--out=${join(root, 'link.bin')}`,
        ]),
      ).rejects.toThrow('symlink destination');
      symlinkSync(root, join(root, 'parent-link'));
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'out',
          `--out=${join(root, 'parent-link', 'new.bin')}`,
        ]),
      ).rejects.toThrow('destination parent');
      mkdirSync(join(root, 'real-parent', 'nested'), { recursive: true });
      symlinkSync(join(root, 'real-parent'), join(root, 'intermediate-link'));
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'out',
          `--out=${join(root, 'intermediate-link', 'nested', 'new.bin')}`,
        ]),
      ).rejects.toThrow('destination parent');
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'out',
          `--out=${join(root, 'missing', 'new.bin')}`,
        ]),
      ).rejects.toThrow('destination parent');

      const failed = join(root, 'failed.bin');
      fetchMock.mockResolvedValueOnce(new Response('no', { status: 503 }));
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'out',
          `--out=${failed}`,
        ]),
      ).rejects.toThrow('HTTP 503');
      expect(existsSync(failed)).toBe(false);
      expect(existsSync(`${failed}.${process.pid}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses competing output and parent replacement during download', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-cli-output-race-'));
    try {
      const { runCoreCommand } = await import('../commands/core.js');
      const competing = join(root, 'competing.bin');
      fetchMock.mockImplementationOnce(async () => {
        writeFileSync(competing, 'winner');
        return new Response(Buffer.from('candidate'));
      });
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'output',
          `--out=${competing}`,
        ]),
      ).rejects.toThrow('refuses to overwrite');
      expect(readFileSync(competing, 'utf8')).toBe('winner');

      const parent = join(root, 'replace-parent');
      const movedParent = join(root, 'replace-parent-old');
      mkdirSync(parent);
      const destination = join(parent, 'result.bin');
      fetchMock.mockImplementationOnce(async () => {
        renameSync(parent, movedParent);
        mkdirSync(parent);
        return new Response(Buffer.from('candidate'));
      });
      await expect(
        runCoreCommand('tasks', [
          'download-output',
          'task',
          'output',
          `--out=${destination}`,
        ]),
      ).rejects.toThrow('parent changed during download');
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(movedParent, 'result.bin'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts exact publication readback when directory fsync is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-cli-output-fsync-'));
    try {
      const fsCompat = await import(
        '@kontourai/station-shared/fs-windows-compat'
      );
      vi.spyOn(fsCompat, 'fsyncDirectorySync').mockImplementationOnce(() => {
        throw new Error('injected directory fsync failure');
      });
      fetchMock.mockResolvedValueOnce(
        new Response(Buffer.from('durable readback')),
      );
      const destination = join(root, 'readback.bin');
      const { runCoreCommand } = await import('../commands/core.js');
      await runCoreCommand('tasks', [
        'download-output',
        'task',
        'output',
        `--out=${destination}`,
      ]);
      expect(readFileSync(destination, 'utf8')).toBe('durable readback');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects task API errors without converting them to success output', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Task not found' }, 404),
    );

    const { runCoreCommand } = await import('../commands/core.js');
    await expect(runCoreCommand('tasks', ['get', 'missing'])).rejects.toThrow(
      'Task not found',
    );
  });

  test('creates a local skill package through the dedicated local route', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { success: true, message: 'Created' },
      }),
    );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('skills', [
      'create',
      '--data={"name":"ship-it","body":"Do the thing"}',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/skills/local',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"ship-it","body":"Do the thing"}',
      }),
    );
  });

  test('streams chat deltas to stdout', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          {
            threadId: 'thread-1',
            method: 'content.text-delta',
            delta: 'Hello',
          },
          {
            threadId: 'thread-1',
            method: 'content.text-delta',
            delta: ' world',
          },
          {
            threadId: 'thread-1',
            method: 'turn.completed',
            finishReason: 'stop',
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            conversationId: 'thread-1',
            sessionId: 'thread-1',
            providerTurnId: 'turn-1',
          },
        }),
      );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('chat', [
      'station',
      'hello there',
      '--session=thread-1',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/orchestration/chat/thread-1/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          environment: { kind: 'current' },
          message: 'hello there',
        }),
      }),
    );
    expect(stdoutWrite).toHaveBeenCalledWith('Hello');
    expect(stdoutWrite).toHaveBeenCalledWith(' world');
  });

  // station#3529: custom actions receive the full positional list with the
  // action word still at index 0, so `agents chat` must read the agent at 1 —
  // as its `conversations`/`messages` siblings already do. Reading index 0
  // resolved the literal string `chat` as the agent and folded the real slug
  // into the message ("station hello there"), which surfaced as a bare
  // "Agent not found" or, with an agent named `chat` present, silently ran the
  // wrong agent with a corrupted prompt and exited 0.
  test('agents chat reads the agent from positional 1, not the action word', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          {
            threadId: 'thread-1',
            method: 'turn.completed',
            finishReason: 'stop',
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            conversationId: 'thread-1',
            sessionId: 'thread-1',
            providerTurnId: 'turn-1',
          },
        }),
      );

    const { runCoreCommand } = await import('../commands/core.js');
    await runCoreCommand('agents', [
      'chat',
      'station',
      'hello there',
      '--session=thread-1',
    ]);

    // The agent slug must not leak into the message body.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/orchestration/chat/thread-1/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          environment: { kind: 'current' },
          message: 'hello there',
        }),
      }),
    );
    // ...and nothing may be addressed to an agent named for the action word.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('/chat/binding');
      expect(String(url)).not.toContain('/agents/chat');
    }
  });
});
