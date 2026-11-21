/**
 * #5069: Pause, Archive and their hold on a Project's turns.
 *
 * The orchestration is a fake that keeps a set of running turns and drops a
 * turn only when `interruptTurn` names it, so a Pause that skips any one
 * running chat leaves it running and fails these tests.
 */
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import type { ProjectLifecycle } from '@kontourai/station-contracts/project-lifecycle';
import { describe, expect, test } from 'vitest';
import { ProjectLifecycleService } from '../project-lifecycle-service.js';

function harness(options: { stuck?: string[]; lateTurn?: string } = {}) {
  const projects = new Map<string, ProjectConfig>([
    [
      'atlas',
      {
        id: 'id-atlas',
        slug: 'atlas',
        name: 'Atlas',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    [
      'birch',
      {
        id: 'id-birch',
        slug: 'birch',
        name: 'Birch',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  ]);
  const projectOf = new Map<string, string>([
    ['a1', 'atlas'],
    ['a2', 'atlas'],
    ['a3', 'atlas'],
    ['a4', 'atlas'],
    ['b1', 'birch'],
  ]);
  const running = new Set(['a1', 'a2', 'a3', 'b1']);
  const interrupted: string[] = [];
  let clock = 0;
  let looks = 0;
  const service = new ProjectLifecycleService({
    readProject: (slug) => {
      const project = projects.get(slug);
      if (!project) throw new Error(`Project ${slug} not found`);
      return project;
    },
    listProjects: () =>
      [...projects.values()].map(
        (project) =>
          ({
            id: project.id,
            slug: project.slug,
            name: project.name,
            hasWorkingDirectory: false,
            layoutCount: 0,
            hasKnowledge: false,
            ...(project.lifecycle ? { lifecycle: project.lifecycle } : {}),
          }) satisfies ProjectMetadata,
      ),
    writeLifecycle: async (slug, lifecycle: ProjectLifecycle | undefined) => {
      const project = { ...projects.get(slug)! };
      if (lifecycle) project.lifecycle = lifecycle;
      else delete project.lifecycle;
      projects.set(slug, project);
      return project;
    },
    listActiveTurnThreadIds: () => {
      looks += 1;
      // A turn admitted just before the hold was written becomes active
      // after the first look.
      if (looks === 2 && options.lateTurn) running.add(options.lateTurn);
      return [...running];
    },
    resolveSessionProjectSlug: (threadId) => projectOf.get(threadId),
    interruptTurn: async (threadId) => {
      interrupted.push(threadId);
      if (!options.stuck?.includes(threadId)) running.delete(threadId);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    stopWaitMs: 1_000,
    pollMs: 100,
  });
  return { service, running, interrupted, projects };
}

describe('Pause', () => {
  test('stops all three running chats in the Project and none elsewhere', async () => {
    const { service, running, interrupted } = harness();

    const result = await service.apply('atlas', 'pause');

    expect(result).toMatchObject({
      lifecycle: { state: 'paused' },
      interrupted: 3,
      stillRunning: 0,
      failed: 0,
    });
    expect(interrupted.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(service.runningThreadIds('atlas')).toEqual([]);
    // Birch is a different Project: its chat keeps running.
    expect([...running]).toEqual(['b1']);
  });

  test('stops a turn that became active after its first look', async () => {
    const { service, interrupted } = harness({ lateTurn: 'a4' });

    const result = await service.apply('atlas', 'pause');

    expect(interrupted).toContain('a4');
    expect(result).toMatchObject({ interrupted: 4, stillRunning: 0 });
  });

  test('reports a chat that has not stopped when the bounded wait ends', async () => {
    const { service } = harness({ stuck: ['a2'] });

    const result = await service.apply('atlas', 'pause');

    expect(result).toMatchObject({ interrupted: 3, stillRunning: 1 });
  });

  test('refuses every new turn in the Project until Resume, and only there', async () => {
    const { service } = harness();
    expect(service.admitTurn({ threadId: 'a1' })).toEqual({ allowed: true });

    await service.apply('atlas', 'pause');

    expect(service.admitTurn({ threadId: 'a1' })).toEqual({
      allowed: false,
      reason: 'This Project is paused. Resume it to continue.',
    });
    expect(service.admitTurn({ threadId: 'b1' })).toEqual({ allowed: true });
    expect([...service.heldProjectIds()]).toEqual(['id-atlas']);

    await expect(service.apply('atlas', 'resume')).resolves.toEqual({
      interrupted: 0,
      stillRunning: 0,
      failed: 0,
    });
    expect(service.admitTurn({ threadId: 'a1' })).toEqual({ allowed: true });
    expect([...service.heldProjectIds()]).toEqual([]);
  });

  test('a hold written by another service instance is read from storage', async () => {
    const first = harness();
    await first.service.apply('atlas', 'pause');
    // A fresh service over the same records (a restart) still holds it.
    const restarted = new ProjectLifecycleService({
      readProject: (slug) => first.projects.get(slug)!,
      listProjects: () =>
        [...first.projects.values()].map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          hasWorkingDirectory: false,
          layoutCount: 0,
          hasKnowledge: false,
          ...(project.lifecycle ? { lifecycle: project.lifecycle } : {}),
        })),
      writeLifecycle: async () => {
        throw new Error('not written');
      },
      listActiveTurnThreadIds: () => [],
      resolveSessionProjectSlug: (threadId) =>
        threadId.startsWith('a') ? 'atlas' : 'birch',
      interruptTurn: async () => undefined,
    });
    expect(restarted.admitTurn({ threadId: 'a9' })).toMatchObject({
      allowed: false,
    });
  });
});

describe('Archive', () => {
  test('stops and holds like Pause; Resume does not lift it, Unarchive does', async () => {
    const { service, interrupted } = harness();

    await expect(service.apply('atlas', 'archive')).resolves.toMatchObject({
      lifecycle: { state: 'archived' },
      interrupted: 3,
      stillRunning: 0,
    });
    expect(interrupted.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(service.admitTurn({ threadId: 'a1' })).toEqual({
      allowed: false,
      reason: 'This Project is archived. Unarchive it to continue.',
    });

    await expect(service.apply('atlas', 'resume')).resolves.toMatchObject({
      lifecycle: { state: 'archived' },
    });
    expect(service.admitTurn({ threadId: 'a1' }).allowed).toBe(false);

    await service.apply('atlas', 'unarchive');
    expect(service.admitTurn({ threadId: 'a1' })).toEqual({ allowed: true });
  });
});
