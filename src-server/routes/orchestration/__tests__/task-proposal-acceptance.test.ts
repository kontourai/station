import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { SessionAssistantTurnQueryOutcome } from '../../../services/orchestration/session-query-module.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { createTaskRoutes } from '../tasks.js';

const temp = trackTempDirs();
const brief =
  '## Goal\n\nShow progress.\n\n## Done when\n\n- [ ] Steps have counts.\n\n## Suggested first step\n\nFind the installer.';
const input = {
  projectId: 'alpha',
  title: 'Installer progress',
  description: brief,
  shapingSource: { sessionId: 'shaping-session', turnId: 'shaping-turn' },
};
function fixture(
  outcome: SessionAssistantTurnQueryOutcome = {
    status: 'found',
    sessionId: 'shaping-session',
    turnId: 'shaping-turn',
    projectSlug: 'alpha',
    message: {
      id: 'answer',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Shaped idea' }],
    },
  },
) {
  const directory = temp('station-proposal-');
  const service = new TaskGraphService(directory, {
    projectService: {
      getProject: () => ({
        id: 'alpha',
        slug: 'alpha',
        name: 'Alpha',
        workingDirectory: directory,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      }),
    },
  });
  const read = vi.fn(async () => outcome);
  const app = createTaskRoutes(service, {
    taskDispatcher: { dispatch: vi.fn() },
    readAuthorityForRequest: () =>
      sessionReadAuthorityFromRequest('owner', undefined, undefined),
    canReadSession: () => true,
    readAssistantTurn: read,
  });
  const accept = () =>
    app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  return { directory, service, read, accept };
}

test('acceptance durably commits the brief and first Session link, and retries keep one Task', async () => {
  const { directory, service, accept, read } = fixture();
  expect(service.listTasks()).toEqual([]);
  const response = await accept();
  expect(response.status, await response.text()).toBe(201);
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'shaping-session',
      turnId: 'shaping-turn',
    }),
  );
  const reopened = new TaskGraphService(directory);
  const [task] = reopened.listTasks();
  expect(task).toMatchObject({
    title: 'Installer progress',
    description: brief,
    sessionId: 'shaping-session',
  });
  expect(reopened.readSessionRelations('shaping-session').links).toEqual([
    expect.objectContaining({
      sourceId: task.id,
      targetId: 'shaping-session',
      relationType: 'spawned_session',
      source: 'user',
      metadata: { shapingTurnId: 'shaping-turn' },
    }),
  ]);
  expect((await accept()).status).toBe(201);
  expect(reopened.listTasks()).toHaveLength(1);
});

test.each([
  { status: 'not-found' },
  { status: 'unavailable' },
  {
    status: 'found',
    sessionId: 'shaping-session',
    turnId: 'shaping-turn',
    projectSlug: 'other-project',
    message: { id: 'answer', role: 'assistant', parts: [] },
  },
] satisfies SessionAssistantTurnQueryOutcome[])(
  'refuses an unreadable or out-of-project shaping source: $status',
  async (outcome) => {
    const { service, accept } = fixture(outcome);
    expect((await accept()).status).toBe(
      outcome.status === 'unavailable' ? 503 : 404,
    );
    expect(service.listTasks()).toEqual([]);
    expect(service.readSessionRelations('shaping-session').links).toEqual([]);
  },
);

test('revoking source access during workspace capture commits neither Task nor link', async () => {
  const directory = temp('station-proposal-revoked-');
  let current = true;
  const service = new TaskGraphService(directory, {
    projectService: {
      getProject: () => {
        current = false;
        return {
          id: 'alpha',
          slug: 'alpha',
          name: 'Alpha',
          workingDirectory: directory,
          createdAt: '2026-10-15T00:00:00Z',
          updatedAt: '2026-10-15T00:00:00Z',
        };
      },
    },
  });
  await expect(
    service.createTask(input, undefined, undefined, () => current),
  ).rejects.toThrow('Shaping source is no longer available');
  expect(new TaskGraphService(directory).listTasks()).toEqual([]);
  expect(service.readSessionRelations('shaping-session').links).toEqual([]);
});
