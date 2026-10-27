import { afterEach, expect, test, vi } from 'vitest';
import { getProjectChatDefaults } from '../client/projects';

afterEach(() => vi.unstubAllGlobals());

const view = {
  version: 'station.project-chat-defaults/v1',
  projectSlug: 'alpha',
  model: { selection: 'fixed', lastUsed: [] },
  approvalMode: { selection: 'fixed', resolved: { source: 'none' } },
};

function respond(status: number, body: unknown) {
  const fetch = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('reads the view from its route', async () => {
  const fetch = respond(200, { success: true, data: view });
  await expect(
    getProjectChatDefaults('https://station.example', 'alpha'),
  ).resolves.toEqual(view);
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
    'https://station.example/api/projects/alpha/chat-defaults',
  );
});

test.each([
  [404, 'an older Station without the route, or no such Project'],
  [501, 'a Station that does not compose it'],
])('a %i (%s) is no Project layer, not a failure', async (status) => {
  respond(status, { success: false, error: 'unavailable' });
  await expect(
    getProjectChatDefaults('https://station.example', 'alpha'),
  ).resolves.toBeNull();
});

test('any other failure, or a shape it does not know, throws', async () => {
  respond(500, { success: false, error: 'storage unavailable' });
  await expect(
    getProjectChatDefaults('https://station.example', 'alpha'),
  ).rejects.toThrow();
  respond(200, { success: true, data: { ...view, version: 'v2' } });
  await expect(
    getProjectChatDefaults('https://station.example', 'alpha'),
  ).rejects.toThrow('Invalid Project chat defaults.');
});
