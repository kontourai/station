import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type CliSessionGroupHost,
  CliSessionGroups,
} from '../cli-session-group.js';

const makeTempDir = trackTempDirs();

function fixture() {
  const home = realpathSync(makeTempDir('station-cli-group-'));
  const open = () =>
    new CliSessionGroups(
      home,
      (input) => {
        if (typeof input !== 'string') throw new Error('Expected a brief');
        return input;
      },
      {},
    );
  const groups = open();
  const input = {
    seats: [
      { seatId: 'lead', input: 'lead brief', needs: [] as string[] },
      { seatId: 'review', input: 'review brief', needs: ['lead'] },
    ],
    maxConcurrent: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const host = {
    assertCurrent: vi.fn(),
    dispatch: vi.fn<CliSessionGroupHost<string>['dispatch']>(
      async (_brief, admission) => {
        admission.assertCurrent();
        return {
          sessionId: admission.sessionId,
          taskId: admission.sessionId,
          conversationId: admission.sessionId,
          initialTurnId: admission.initialClientTurnId,
        };
      },
    ),
    observe: vi.fn<CliSessionGroupHost<string>['observe']>(async (handle) => ({
      sessionId: handle.sessionId,
      status: 'completed',
      completedEvent: { eventId: 'returned', turnId: handle.initialTurnId! },
    })),
    interrupt: vi.fn<CliSessionGroupHost<string>['interrupt']>(async () => {}),
  };
  return { home, groups, open, input, host };
}

test('creation snapshots the dispatch ceiling, briefs and dependency graph before waiting for storage', async () => {
  const { home, groups, open, input, host } = fixture();
  const request = { ...input, maxDispatches: 0 };
  const original = structuredClone(request);
  const creating = groups.create(
    'owner',
    'create',
    request,
    host.assertCurrent,
  );
  request.maxDispatches = 2;
  request.seats[0]!.input = 'changed brief';
  request.seats[1]!.needs.length = 0;
  const created = await creating;
  expect(created).toMatchObject({
    maxDispatches: 0,
    dispatchCount: 0,
    admissionClosed: 'dispatch-limit-exhausted',
  });
  expect(created.members.map(({ needs }) => needs)).toEqual([[], ['lead']]);
  const record = JSON.parse(
    readFileSync(
      join(home, 'runtime', 'cli-session-groups', `${created.groupId}.json`),
      'utf8',
    ),
  );
  expect(record.seats).toMatchObject(original.seats);

  const reopened = open();
  await expect(
    reopened.create('owner', 'create', original, host.assertCurrent),
  ).resolves.toEqual(created);
  await expect(
    reopened.create('owner', 'create', request, host.assertCurrent),
  ).rejects.toThrow('group_conflict');
  await expect(reopened.view(created.groupId, 'other-owner')).rejects.toThrow(
    'group_not_found',
  );
  await expect(
    reopened.run(created.groupId, 'owner', host, new AbortController().signal),
  ).resolves.toEqual(created);
  expect(host.dispatch).not.toHaveBeenCalled();
});

test.each([
  {
    maxDispatches: 1,
    starts: ['lead brief'],
    reviewState: 'pending',
    closure: 'dispatch-limit-exhausted',
  },
  {
    maxDispatches: undefined,
    starts: ['lead brief', 'review brief'],
    reviewState: 'terminal',
    closure: undefined,
  },
])(
  'enforces the durable dispatch allowance ($maxDispatches) across dependent seats',
  async ({ maxDispatches, starts, reviewState, closure }) => {
    const { groups, open, input, host } = fixture();
    const created = await groups.create(
      'owner',
      'create',
      maxDispatches === undefined ? input : { ...input, maxDispatches },
      host.assertCurrent,
    );
    const result = await groups.run(
      created.groupId,
      'owner',
      host,
      new AbortController().signal,
    );
    expect(host.dispatch.mock.calls.map(([brief]) => brief)).toEqual(starts);
    expect(result).toMatchObject({
      maxDispatches: maxDispatches ?? 2,
      dispatchCount: starts.length,
      admissionClosed: closure,
      members: [
        { seatId: 'lead', state: 'terminal', outcome: 'completed' },
        { seatId: 'review', state: reviewState },
      ],
    });
    await expect(open().view(created.groupId, 'owner')).resolves.toEqual(
      result,
    );
  },
);

test('revoked create authority at publication leaves no replayable group', async () => {
  const { groups, input, host } = fixture();
  host.assertCurrent
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('authority revoked');
    });
  await expect(
    groups.create('owner', 'create', input, host.assertCurrent),
  ).rejects.toThrow('authority revoked');
  await expect(
    groups.create(
      'owner',
      'create',
      { ...input, maxDispatches: 0 },
      host.assertCurrent,
    ),
  ).resolves.toMatchObject({ dispatchCount: 0, maxDispatches: 0 });
});

test('a dispatch without an accepted receipt keeps its durable reservation across owner restart', async () => {
  const { groups, open, input, host } = fixture();
  host.dispatch.mockRejectedValueOnce(new Error('lost receipt'));
  const created = await groups.create(
    'owner',
    'create',
    input,
    host.assertCurrent,
  );
  const first = await groups.run(
    created.groupId,
    'owner',
    host,
    new AbortController().signal,
  );
  expect(first.dispatchCount).toBe(1);
  const lead = first.members[0];
  expect(lead).toMatchObject({
    state: 'launch-intent',
    reservedSessionId: expect.any(String),
  });
  const second = await open().run(
    created.groupId,
    'owner',
    host,
    new AbortController().signal,
  );
  expect(second.members[0]).toEqual(lead);
  expect(second.dispatchCount).toBe(1);
  expect(host.dispatch).toHaveBeenCalledTimes(1);
});
