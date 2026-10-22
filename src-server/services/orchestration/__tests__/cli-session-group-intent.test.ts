import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliSessionGroupPresetIdentity } from '@kontourai/station-contracts/delegation-group';
import { expect, test, vi } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CliSessionGroups,
  CliSessionGroupUnavailable,
} from '../cli-session-group.js';

const temporary = trackTempDirs();
function fixture() {
  const home = realpathSync(temporary('station-cli-intent-'));
  const groups = new CliSessionGroups(
    home,
    (input) => z.string().parse(input),
    {},
  );
  const preset: CliSessionGroupPresetIdentity = {
    presetId: 'team',
    name: 'Team',
    sha256: `sha256:${'a'.repeat(64)}`,
    stationmaster: 'lead',
  };
  const members = [
    { seatId: 'lead', codename: 'Rune', color: '#123ABC', role: 'Reviewer' },
    { seatId: 'check', codename: 'Flux', color: '#123ABC', role: 'Checker' },
  ];
  const input = {
    seats: [
      { seatId: 'lead', input: 'private lead brief', needs: [] },
      { seatId: 'check', input: 'private check brief', needs: [] },
    ],
    maxConcurrent: 1,
    deadlineAt: Date.now() + 60_000,
    preset,
  };
  const create = (value = input) =>
    groups.create('owner', 'same-operation', value, () => {});
  return { home, groups, input, preset, members, create };
}

test('a member-less preset record replays the same source after the derived roster is added', async () => {
  const f = fixture();
  const original = await f.create();
  const replay = await f.create({
    ...f.input,
    preset: { ...f.preset, members: f.members },
  });
  expect(replay.groupId).toBe(original.groupId);
  expect(replay.preset).toEqual(f.preset);
  expect(replay.dispatchCount).toBe(0);
  await expect(
    f.create({
      ...f.input,
      preset: {
        ...f.preset,
        members: f.members,
        sha256: `sha256:${'b'.repeat(64)}`,
      },
    }),
  ).rejects.toThrow('group_conflict');
  await expect(
    f.create({
      ...f.input,
      preset: { ...f.preset, members: f.members },
      seats: [
        { ...f.input.seats[0]!, input: 'changed brief' },
        f.input.seats[1]!,
      ],
    }),
  ).rejects.toThrow('group_conflict');
});

test('a retained roster keeps exact replay identity instead of taking the legacy projection path', async () => {
  const f = fixture();
  const input = { ...f.input, preset: { ...f.preset, members: f.members } };
  const original = await f.create(input);
  expect((await f.create(input)).preset).toEqual(original.preset);
  await expect(
    f.create({
      ...input,
      preset: {
        ...input.preset,
        members: [{ ...f.members[0]!, codename: 'Different' }, f.members[1]!],
      },
    }),
  ).rejects.toThrow('group_conflict');
});

test('a stored roster cannot substitute a case-duplicate codename', async () => {
  const f = fixture();
  const group = await f.create({
    ...f.input,
    preset: { ...f.preset, members: f.members },
  });
  const path = join(
    f.home,
    'runtime',
    'cli-session-groups',
    `${group.groupId}.json`,
  );
  const original = readFileSync(path);
  const record: { preset: { members: { codename: string }[] } } = JSON.parse(
    original.toString(),
  );
  record.preset.members[1]!.codename = 'rune';
  try {
    writeFileSync(path, JSON.stringify(record));
    await expect(f.groups.view(group.groupId, 'owner')).rejects.toThrow(
      'group_storage_unavailable',
    );
  } finally {
    writeFileSync(path, original);
  }
  expect((await f.groups.view(group.groupId, 'owner')).preset?.members).toEqual(
    f.members,
  );
});

test('a per-seat authentication refusal stays visible without reserving or starting the seat', async () => {
  const f = fixture();
  const group = await f.create();
  const dispatch = vi.fn(async () => {
    throw new Error('Unexpected member dispatch');
  });
  const view = await f.groups.run(
    group.groupId,
    'owner',
    {
      assertCurrent() {},
      prepareRun: async () => ({
        prepareDispatch: async () => {
          throw new CliSessionGroupUnavailable('ensemble_auth_unverified');
        },
      }),
      dispatch,
      observe: async () => {
        throw new Error('Unexpected member observation');
      },
      interrupt: async () => {
        throw new Error('Unexpected member interruption');
      },
    },
    AbortSignal.timeout(10_000),
  );
  expect(dispatch).not.toHaveBeenCalled();
  expect(view.dispatchCount).toBe(0);
  expect(view.members.every((member) => member.state === 'pending')).toBe(true);
  expect(
    view.members.find((member) => member.seatId === 'lead')?.dispatchFailure,
  ).toEqual({ status: 409, code: 'ensemble_auth_unverified' });
  expect((await f.groups.view(group.groupId, 'owner')).members).toEqual(
    view.members,
  );
});
