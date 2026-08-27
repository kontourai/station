import { encodeTaskTurnReference } from '@kontourai/station-contracts';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createToolRoutes } from '../../../routes/agents/tools.js';
import { createTaskBasisQueryModule } from '../../../services/projects/task-basis-module.js';
import { STATION_BASIS_MCP_TOOL_NAME } from '../../../tools/station-control-basis-tools.js';
import { createTaskBasisMcpInitialRead } from '../task-basis-mcp-initial-read.js';

const answer = {
  status: 'found' as const,
  sessionId: 'session-a',
  turnId: 'turn-a',
  observedAt: '2026-08-26T00:00:00.000Z',
  binding: {
    version: 'station-answer-binding/v1' as const,
    sessionId: 'session-a',
    turnId: 'turn-a',
    answer: {
      authority: '@kontourai/thread' as const,
      schemaVersion: '1.2.0' as const,
      kind: 'assistant-message' as const,
      standing: 'observed' as const,
      threadId: 'session-a',
      messageId: 'start-a:assistant',
    },
  },
  projectSlug: 'project-a',
  inputs: [],
  results: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mcpService() {
  return {
    getMCPUIToolCatalog: vi.fn().mockResolvedValue({
      available: true,
      tools: [
        {
          originalName: STATION_BASIS_MCP_TOOL_NAME,
          annotations: { readOnlyHint: true },
        },
      ],
    }),
  };
}

function unavailable(body: unknown) {
  expect(body).toMatchObject({
    success: true,
    data: { content: [{ type: 'text' }] },
  });
  expect(
    (body as { data: { structuredContent?: unknown } }).data,
  ).not.toHaveProperty('structuredContent');
}

describe('Task Basis MCP initial-result reauthorization', () => {
  test.each([
    [
      'the request principal is revoked',
      (state: State) => {
        state.principalCurrent = false;
      },
    ],
    [
      'the selected Session is revoked while the request principal remains current',
      (state: State) => {
        state.sessionReadable = false;
      },
    ],
    [
      'the Task project changes',
      (state: State) => {
        state.projectId = 'project-b';
      },
    ],
    [
      'the selected exact turn link is removed',
      (state: State) => {
        state.links = [];
      },
    ],
  ])(
    'withholds private input when %s during the deferred assessment',
    async (_label, mutate) => {
      const gate = deferred<{
        owner: { authority: '@kontourai/surface' };
        state: 'not-captured';
        observedAt: string;
      }>();
      const started = deferred<void>();
      const state: State = {
        principalCurrent: true,
        sessionReadable: true,
        projectId: 'project-a',
        links: [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
      };
      const taskBasis = createTaskBasisQueryModule({
        taskGraph: {
          readTaskTurnReferenceScope: () => ({ projectId: state.projectId }),
          readTaskTurnReferenceLinks: () => state.links,
        },
        sessionQueries: {
          readAnswerBasis: async () => {
            return answer;
          },
        },
        outputs: { list: async () => [] },
        toolResultReferences: {
          read: async () => ({ status: 'found' as const, references: [] }),
        },
        readAssessment: async () => {
          started.resolve();
          return gate.promise.then((assessment) => ({ assessment }));
        },
      });
      const app = createToolRoutes(mcpService() as never, vi.fn(), {
        readInitialMcpAppResult: createTaskBasisMcpInitialRead({
          taskBasis,
          taskGraph: {
            readTaskTurnReferenceScope: () => ({ projectId: state.projectId }),
            readTaskTurnReferenceLinks: () => state.links,
          },
          authorityForRequest: () =>
            sessionReadAuthorityFromRequest('owner', undefined, undefined),
          isRequestPrincipalCurrent: () => state.principalCurrent,
          canReadSession: () => state.sessionReadable,
        }),
      });

      const response = app.request(
        `/station-control/ui/${STATION_BASIS_MCP_TOOL_NAME}/initial-result`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            arguments: {
              scope: 'task-answer',
              taskId: 'task-a',
              answerReferenceId: 'keep-a',
            },
          }),
        },
      );
      await started.promise;
      mutate(state);
      gate.resolve({
        owner: { authority: '@kontourai/surface' },
        state: 'not-captured',
        observedAt: answer.observedAt,
      });

      const body = await (await response).json();
      unavailable(body);
    },
  );

  test('publishes the real Task Basis projection when authority and Task facts remain current', async () => {
    const taskBasis = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
      },
      sessionQueries: { readAnswerBasis: async () => answer },
      outputs: { list: async () => [] },
      toolResultReferences: {
        read: async () => ({ status: 'found' as const, references: [] }),
      },
    });
    const graph = {
      readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
      readTaskTurnReferenceLinks: () => [
        {
          id: 'keep-a',
          targetId: encodeTaskTurnReference('session-a', 'turn-a'),
        },
      ],
    };
    const app = createToolRoutes(mcpService() as never, vi.fn(), {
      readInitialMcpAppResult: createTaskBasisMcpInitialRead({
        taskBasis,
        taskGraph: graph,
        authorityForRequest: () =>
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        isRequestPrincipalCurrent: () => true,
        canReadSession: () => true,
      }),
    });

    const response = await app.request(
      `/station-control/ui/${STATION_BASIS_MCP_TOOL_NAME}/initial-result`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          arguments: {
            scope: 'task-answer',
            taskId: 'task-a',
            answerReferenceId: 'keep-a',
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        structuredContent: {
          version: 'surface.basis-projection/v1',
          answer: { value: { ref: { threadId: 'session-a' } } },
        },
      },
    });
  });
});

type State = {
  principalCurrent: boolean;
  sessionReadable: boolean;
  projectId: string;
  links: { id: string; targetId: string }[];
};
