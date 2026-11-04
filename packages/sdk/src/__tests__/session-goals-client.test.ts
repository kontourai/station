import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ getJson: vi.fn(), mutateJson: vi.fn() }));
vi.mock('../client/http', async (original) => ({
  ...(await original<typeof import('../client/http')>()),
  ...transport,
}));

import { controlSessionGoal, readSessionGoal } from '../client/session-goals';

const options = {
  requestScope: { apiBase: 'http://station.test', authorityKey: 'owner' },
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => vi.resetAllMocks());

test('encodes the exact Session and forwards its captured authority', async () => {
  transport.getJson.mockResolvedValue(response({ state: 'unsupported' }));
  expect(
    await readSessionGoal('http://station.test', 'session:1/a', options),
  ).toEqual({ state: 'unsupported' });
  expect(transport.getJson).toHaveBeenCalledWith(
    'http://station.test/api/orchestration/sessions/session%3A1%2Fa/goal',
    options,
  );
});

test('an older host is explicitly unsupported rather than an empty goal', async () => {
  transport.getJson.mockResolvedValue(
    new Response('Not found', { status: 404 }),
  );
  expect(
    await readSessionGoal('http://station.test', 'session', options),
  ).toEqual({ state: 'unsupported' });
});

test('rejects an available Goal with malformed usage or unadvertised semantics', async () => {
  transport.getJson.mockResolvedValue(
    response({
      state: 'available',
      capability: {},
      goal: { objective: 'Goal', tokensUsed: -1 },
    }),
  );
  await expect(
    readSessionGoal('http://station.test', 'session', options),
  ).rejects.toThrow('Invalid Session goal');
});

test('forwards one typed command and preserves an indeterminate acknowledgement', async () => {
  transport.mutateJson.mockResolvedValue(response({ state: 'indeterminate' }));
  const command = { operation: 'pause' as const };
  expect(
    await controlSessionGoal(
      'http://station.test',
      'session',
      command,
      options,
    ),
  ).toEqual({ state: 'indeterminate' });
  expect(transport.mutateJson).toHaveBeenCalledExactlyOnceWith(
    'http://station.test/api/orchestration/sessions/session/goal',
    'POST',
    options,
    command,
  );
});

test('invalid commands cannot reach the network', async () => {
  await expect(
    controlSessionGoal(
      'http://station.test',
      'session',
      { operation: 'set', objective: ' ', tokenBudget: null },
      options,
    ),
  ).rejects.toThrow('Invalid Goal command');
  expect(transport.mutateJson).not.toHaveBeenCalled();
});

test('a malformed mutation response cannot become success', async () => {
  transport.mutateJson.mockResolvedValue(
    response({ state: 'applied', goal: { status: 'complete' } }),
  );
  await expect(
    controlSessionGoal(
      'http://station.test',
      'session',
      { operation: 'clear' },
      options,
    ),
  ).rejects.toThrow('could not be confirmed');
});
