import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import {
  commandApproval,
  emit,
  FakeCodexProcess,
  openedRequestId,
  repliesTo,
  THREAD,
  waitFor,
} from './codex-adapter-wire-harness.js';

const adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
});

describe('Codex reviewer inheritance', () => {
  test.each([
    ['thread/start', 'user'],
    ['thread/start', 'auto_review'],
    ['thread/resume', 'user'],
    ['thread/resume', 'auto_review'],
  ] as const)(
    '%s keeps Ask policy separate from the reported %s reviewer',
    async (method, approvalsReviewer) => {
      const process = new FakeCodexProcess();
      const adapter = new CodexAdapter({ processFactory: () => process });
      adapters.push(adapter);
      const events: CanonicalRuntimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.streamEvents()) events.push(event);
      })();
      const calls = () => process.stdin.lines.map((line) => JSON.parse(line));
      const session = adapter.startSession({
        provider: 'codex',
        threadId: THREAD,
        cwd: '/tmp/project',
        modelOptions: { approvalMode: 'ask' },
        ...(method === 'thread/resume'
          ? { resumeCursor: { codexThreadId: 'codex-thread' } }
          : {}),
      });
      const init = await waitFor(
        () => calls().find((call) => call.method === 'initialize'),
        'initialize',
      );
      await emit(process, { id: init.id, result: { userAgent: 'test' } });
      const start = await waitFor(
        () => calls().find((call) => call.method === method),
        method,
      );
      expect(start.params).toMatchObject({ approvalPolicy: 'untrusted' });
      // #3800: workspace-write is the permission profile the spawn selects.
      expect(start.params).not.toHaveProperty('sandbox');
      expect(start.params).not.toHaveProperty('approvalsReviewer');
      await emit(process, {
        id: start.id,
        result: {
          thread: { id: 'codex-thread' },
          cwd: '/tmp/project',
          approvalPolicy: 'untrusted',
          approvalsReviewer,
          sandbox: {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: {
            id: 'station-workspace',
            extends: ':workspace',
          },
        },
      });
      await session;
      const turn = adapter.sendTurn({
        threadId: THREAD,
        input: 'run a command',
        modelOptions: { approvalMode: 'ask' },
      });
      const next = await waitFor(
        () => calls().find((call) => call.method === 'turn/start'),
        'turn/start',
      );
      expect(next.params.approvalPolicy).toBe('untrusted');
      expect(next.params).not.toHaveProperty('approvalsReviewer');
      expect(next.params).not.toHaveProperty('sandboxPolicy');
      await emit(process, {
        id: next.id,
        result: { turn: { id: 'turn-1' } },
      });
      await turn;
      // Settings are not an approval request. The engine must actually ask.
      expect(
        events.filter((event) => event.method === 'request.opened'),
      ).toEqual([]);
      await emit(process, commandApproval('ordinary-command'));
      const requestId = await openedRequestId(events);
      await adapter.respondToRequest(THREAD, requestId, 'accept');
      expect(repliesTo(process, 'ordinary-command')).toEqual([
        {
          jsonrpc: '2.0',
          id: 'ordinary-command',
          result: { decision: 'accept' },
        },
      ]);
      await emit(process, {
        method: 'serverRequest/resolved',
        params: { threadId: 'codex-thread', requestId: 'ordinary-command' },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          method: 'request.delivery',
          requestId,
          outcome: 'acknowledged',
        }),
      );
    },
  );
});
