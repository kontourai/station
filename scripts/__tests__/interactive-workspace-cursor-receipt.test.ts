import { expect, test, vi } from 'vitest';
import { publishPeerCursor } from '../interactive-workspace-playwright-adapter.mjs';

function cursorDriver(outcome = 'updated') {
  const focus = vi.fn();
  const click = vi.fn();
  const matches: boolean[] = [];
  const response = (selection: { anchor: number; focus: number }) => ({
    url: () => 'http://fixture.invalid/api/tasks/task-one/room/live',
    request: () => ({
      method: () => 'POST',
      postData: () =>
        JSON.stringify({
          command: 'cursor',
          workingRevision: 'revision',
          selection,
        }),
    }),
    status: () => 200,
    json: async () => ({
      success: true,
      data: { kind: 'available', result: { outcome } },
    }),
  });
  const peer = {
    getByRole: () => ({
      getAttribute: async () => 'revision',
      evaluate: async () => 4,
      focus,
      click,
      press: vi.fn(),
    }),
    locator: () => ({ getAttribute: async () => 'actor' }),
    evaluate: async () => 1234,
    waitForResponse: async (
      predicate: (candidate: ReturnType<typeof response>) => boolean,
    ) => {
      matches.push(predicate(response({ anchor: 1, focus: 1 })));
      const final = response({ anchor: 0, focus: 4 });
      matches.push(predicate(final));
      return final;
    },
  };
  return { peer, owner: { evaluate: async () => {} }, matches, focus, click };
}

test('a cursor sample waits for the requested revision and selection', async () => {
  const f = cursorDriver();
  await expect(
    publishPeerCursor(f.peer, f.owner, 'task-one', 0),
  ).resolves.toMatchObject({
    kind: 'cursor-published',
    workingRevision: 'revision',
    anchor: 0,
    focus: 4,
  });
  expect(f.matches).toEqual([false, true]);
});

test('an available cursor envelope with a refused mutation is not a published sample', async () => {
  const f = cursorDriver('rate_limited');
  await expect(
    publishPeerCursor(f.peer, f.owner, 'task-one', 0),
  ).rejects.toThrow('Cursor status 200 outcome RATE_LIMITED');
});
