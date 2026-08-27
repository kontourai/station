import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { TaskGraphService } from '../../services/projects/task-graph-service.js';
import { createPersonalTaskAnswerSupportModule } from '../routes/runtime-routes.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const bundle = {
  schemaVersion: 5,
  source: 'factory-test',
  claims: [
    {
      id: 'claim-a',
      subjectType: 'artifact',
      subjectId: 'repo:demo',
      claimType: 'quality.test',
      fieldOrBehavior: 'test',
      value: 'pass',
      status: 'verified',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  evidence: [],
  policies: [],
  events: [],
};

test('personal runtime factory follows real graph/session/project/bundle branches without leaking protected identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-answer-runtime-home-'));
  const workspace = mkdtempSync(
    join(tmpdir(), 'station-answer-runtime-workspace-'),
  );
  roots.push(home, workspace);
  const bundleDirectory = join(workspace, '.station', 'trust-bundles');
  mkdirSync(bundleDirectory, { recursive: true });
  writeFileSync(join(bundleDirectory, 'basis.json'), JSON.stringify(bundle));
  writeFileSync(join(bundleDirectory, 'gone.json'), JSON.stringify(bundle));
  let projectAvailable = true;
  let answer: any = {
    status: 'found',
    sessionId: 'session-a',
    turnId: 'turn-a',
    observedAt: '2026-08-26T00:00:00.000Z',
    projectSlug: 'project-a',
    binding: {
      version: 'station-answer-binding/v1',
      sessionId: 'session-a',
      turnId: 'turn-a',
      answer: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-a',
        messageId: 'message-a',
      },
    },
    inputs: [],
    results: [],
  };
  const projects = {
    getProject: vi.fn((slug: string) =>
      projectAvailable && slug === 'project-a'
        ? { slug, workingDirectory: workspace }
        : undefined,
    ),
  };
  const graph = new TaskGraphService(home, {
    projectService: projects as never,
  });
  const task = await graph.createTask({
    projectId: 'project-a',
    title: 'basis',
  });
  await graph.createTaskReference(task.id, {
    kind: 'turn',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  const reference = graph.readTaskTurnReferenceLinks(task.id)![0];
  const sessionReads = vi.fn(async () => answer);
  const module = createPersonalTaskAnswerSupportModule({
    taskGraphService: graph,
    projectService: projects,
    orchestrationService: {
      sessionQueries: { readAnswerBasis: sessionReads },
    },
    configLoader: { getProjectHomeDir: () => home },
    appConfig: {},
  } as never);
  const authority = {} as never;
  const assertNotFound = async (work: () => Promise<unknown>) => {
    try {
      await work();
      throw new Error('expected not found');
    } catch (error) {
      expect((error as Error).message).toBe('Answer support not found');
      for (const secret of ['project-a', 'claim-a', 'basis.json', workspace])
        expect((error as Error).message).not.toContain(secret);
    }
  };
  const choices = (await module.bundles(
    task.id,
    reference.id,
    authority,
  )) as Array<{ id: string }>;
  const [choice, goneChoice] = choices;
  rmSync(join(bundleDirectory, 'gone.json'));
  expect(choice).toBeDefined();
  expect(goneChoice).toBeDefined();
  projects.getProject.mockClear();
  sessionReads.mockClear();
  await assertNotFound(() =>
    module.create(
      'missing-task',
      reference.id,
      choice.id,
      'claim-a',
      authority,
    ),
  );
  expect(sessionReads).not.toHaveBeenCalled();
  expect(projects.getProject).not.toHaveBeenCalled();
  sessionReads.mockClear();
  await assertNotFound(() =>
    module.create(
      task.id,
      'missing-reference',
      choice.id,
      'claim-a',
      authority,
    ),
  );
  expect(sessionReads).not.toHaveBeenCalled();
  answer = { status: 'not-found' };
  await assertNotFound(() =>
    module.create(task.id, reference.id, choice.id, 'claim-a', authority),
  );
  expect(sessionReads).toHaveBeenCalledWith(
    { type: 'answer-basis', threadId: 'session-a', turnId: 'turn-a' },
    authority,
  );
  answer = { status: 'unavailable' };
  await expect(module.bundles(task.id, reference.id, authority)).resolves.toBe(
    'unavailable',
  );
  answer = {
    status: 'found',
    sessionId: 'session-a',
    turnId: 'turn-a',
    projectSlug: 'other-project',
  };
  await assertNotFound(() =>
    module.create(task.id, reference.id, choice.id, 'claim-a', authority),
  );
  answer = {
    status: 'found',
    sessionId: 'session-a',
    turnId: 'turn-a',
    projectSlug: 'project-a',
  };
  projectAvailable = false;
  await assertNotFound(() =>
    module.create(task.id, reference.id, choice.id, 'claim-a', authority),
  );
  expect(projects.getProject).toHaveBeenCalledWith('project-a');
  projectAvailable = true;
  await assertNotFound(() =>
    module.create(task.id, reference.id, goneChoice.id, 'claim-a', authority),
  );
  await assertNotFound(() =>
    module.create(task.id, reference.id, choice.id, 'missing-claim', authority),
  );
  await expect(
    module.create(task.id, reference.id, choice.id, 'claim-a', authority),
  ).resolves.toEqual(
    expect.objectContaining({
      taskId: task.id,
      answerReferenceId: reference.id,
    }),
  );
}, 120_000);
