import type { Page, Route } from '@playwright/test';
import { expect, test } from 'vitest';
import { installTaskRoomFixture } from '../../tests/helpers/room-gallery-fixtures';

type Handler = (route: Route) => Promise<void> | void;

/** Install the gallery Task-room fixture on a page that only records routes. */
async function fixtureRoutes() {
  const routes: [string, Handler][] = [];
  const page = {
    route: async (pattern: string, handler: Handler) => {
      routes.push([pattern, handler]);
    },
    unroute: async () => undefined,
  } as unknown as Page;
  const { taskId } = await installTaskRoomFixture(page, {
    slug: 'gallery-room-thread-dark-390',
    projectUuid: '00000000-0000-4000-8000-000000000001',
    scene: 'thread',
  });
  return { routes, taskId };
}

/** POST `body` to the fixture's room/live route; returns what it fulfilled. */
async function postLive(body: unknown) {
  const { routes, taskId } = await fixtureRoutes();
  const live = routes.find(([pattern]) => pattern.endsWith('/room/live'));
  expect(live, 'the fixture serves room/live').toBeDefined();
  const text = JSON.stringify(body);
  let fulfilled: { status?: number; json?: unknown } | undefined;
  let rejected = false;
  const route = {
    request: () => ({
      method: () => 'POST',
      url: () =>
        `http://127.0.0.1/api/tasks/${encodeURIComponent(taskId)}/room/live`,
      headers: () => ({ 'content-type': 'application/json' }),
      postData: () => text,
      postDataJSON: () => JSON.parse(text),
    }),
    fulfill: async (options: { status?: number; json?: unknown }) => {
      fulfilled = options;
    },
    abort: async () => {
      rejected = true;
    },
  } as unknown as Route;
  await live![1](route);
  return {
    status: rejected ? 'aborted' : (fulfilled?.status ?? 200),
    fulfilled,
  };
}

test('the gallery Task-room fixture refuses a live command the Station does not accept (#4810 gallery delta 2, finding 3)', async () => {
  for (const body of [
    { command: 'not-a-real-command' },
    { command: 'join', unexpected: true },
    { command: 'typing' },
  ]) {
    const { status } = await postLive(body);
    expect(status, JSON.stringify(body)).toBe(400);
  }
});

test('the gallery Task-room fixture still answers the commands the room sends', async () => {
  const joined = await postLive({ command: 'join', requestId: 'r1' });
  expect(joined.status).toBe(200);
  expect(joined.fulfilled?.json).toMatchObject({
    success: true,
    data: { kind: 'available', result: { outcome: 'joined' } },
  });
  const heartbeat = await postLive({ command: 'heartbeat' });
  expect(heartbeat.status).toBe(200);
  expect(heartbeat.fulfilled?.json).toMatchObject({
    data: { result: { outcome: 'updated' } },
  });
});
