import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineAccountUsage } from '@kontourai/station-contracts/engine-accounts';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { recordEngineAccountUsage } from '../engine-account-history.js';

const makeTempDir = trackTempDirs();
const target = {
  engine: 'codex' as const,
  connectionId: 'codex',
  ref: 'work',
  dir: '/private/config-home',
};
const usage = (
  fetchedAt: string,
  usedPercent: number,
  accountId = 'account-a',
): EngineAccountUsage => ({
  status: 'ok',
  fetchedAt,
  exhausted: false,
  windows: [
    {
      id: 'weekly',
      label: 'Weekly',
      usedPercent,
      resetsAt: '2026-10-08T00:00:00Z',
    },
  ],
  metadata: {
    identity: { accountId, email: 'private@example.test' },
    capture: {
      source: 'codex-wham-usage',
      unhandledFields: [],
      excludedFields: [],
      truncated: false,
    },
  },
});

test('history persists hourly observations, isolates profile/source/engine, expires old data, and resets on account replacement', async () => {
  const homeDir = makeTempDir('allowance-history-');
  const options = { homeDir };
  await recordEngineAccountUsage(
    target,
    usage('2026-08-01T10:00:00Z', 5),
    options,
  );
  await recordEngineAccountUsage(
    target,
    usage('2026-10-01T10:00:00Z', 20),
    options,
  );
  await recordEngineAccountUsage(
    target,
    usage('2026-10-01T10:30:00Z', 30),
    options,
  );
  const history = await recordEngineAccountUsage(
    target,
    {
      status: 'unknown',
      fetchedAt: '2026-10-01T11:00:00Z',
      reason: 'Unavailable',
    },
    options,
  );
  expect(history.observations).toEqual([
    {
      fetchedAt: '2026-10-01T10:30:00Z',
      status: 'ok',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 30,
          resetsAt: '2026-10-08T00:00:00Z',
        },
      ],
    },
    { fetchedAt: '2026-10-01T11:00:00Z', status: 'unknown', windows: [] },
  ]);
  for (const isolated of [
    { ...target, ref: 'personal' },
    { ...target, dir: '/other/home' },
    { ...target, engine: 'claude' as const },
  ]) {
    const separate = await recordEngineAccountUsage(
      isolated,
      usage('2026-10-01T12:00:00Z', 1),
      options,
    );
    expect(separate.observations).toHaveLength(1);
  }
  const replacement = await recordEngineAccountUsage(
    target,
    usage('2026-10-01T12:00:00Z', 2, 'account-b'),
    options,
  );
  expect(replacement.observations).toHaveLength(1);
  const files = await readdir(join(homeDir, 'analytics', 'engine-allowance'));
  const contents = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map((file) =>
        readFile(join(homeDir, 'analytics', 'engine-allowance', file), 'utf8'),
      ),
  );
  expect(contents.join()).not.toMatch(
    /private@example|account-a|account-b|config-home/,
  );
});

test('a delayed response cannot restore the previous account identity after a newer request observed a new account', async () => {
  const homeDir = makeTempDir('allowance-history-order-');
  await recordEngineAccountUsage(
    target,
    usage('2026-10-01T10:00:00Z', 10, 'account-a'),
    { homeDir, requestStartedAt: '2026-10-01T09:00:00Z' },
  );
  await recordEngineAccountUsage(
    target,
    usage('2026-10-01T10:30:00Z', 20, 'account-b'),
    { homeDir, requestStartedAt: '2026-10-01T10:00:00Z' },
  );
  const result = await recordEngineAccountUsage(
    target,
    usage('2026-10-01T11:00:00Z', 99, 'account-a'),
    { homeDir, requestStartedAt: '2026-10-01T09:15:00Z' },
  );
  expect(
    result.observations.map((item) => item.windows[0]?.usedPercent),
  ).toEqual([20]);
});

test('concurrent captures retain both hours and corrupt history remains observable without rewriting it', async () => {
  const homeDir = makeTempDir('allowance-history-');
  const options = { homeDir };
  await Promise.all([
    recordEngineAccountUsage(
      target,
      usage('2026-10-01T10:00:00Z', 20),
      options,
    ),
    recordEngineAccountUsage(
      target,
      usage('2026-10-01T11:00:00Z', 30),
      options,
    ),
  ]);
  const history = await recordEngineAccountUsage(
    target,
    usage('2026-10-01T12:00:00Z', 40),
    options,
  );
  expect(
    history.observations.map((point) => point.windows[0]?.usedPercent),
  ).toEqual([20, 30, 40]);
  const file = (
    await readdir(join(homeDir, 'analytics', 'engine-allowance'))
  ).find((file) => file.endsWith('.json'))!;
  const path = join(homeDir, 'analytics', 'engine-allowance', file);
  await writeFile(path, '{invalid');
  await expect(
    recordEngineAccountUsage(
      target,
      usage('2026-10-01T13:00:00Z', 50),
      options,
    ),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});
