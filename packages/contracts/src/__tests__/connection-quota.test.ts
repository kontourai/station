import { describe, expect, test } from 'vitest';
import {
  type ConnectionQuotaSnapshot,
  type ConnectionQuotaSnapshotUpdate,
  mergeQuotaSnapshot,
} from '../connection-quota.js';

const baseline: ConnectionQuotaSnapshot = {
  connectionId: 'codex',
  provider: 'codex',
  source: 'provider-reported',
  accountScope: 'profile',
  observedAt: '2026-08-09T19:00:00.000Z',
  baselineAt: '2026-08-09T19:00:00.000Z',
  plan: { value: { type: 'pro' }, observedAt: '2026-08-09T19:00:00.000Z' },
  windows: [
    { id: 'primary', usedPercent: 42, observedAt: '2026-08-09T19:00:00.000Z' },
  ],
  credits: {
    value: { hasCredits: true, unlimited: false, balance: '10' },
    observedAt: '2026-08-09T19:00:00.000Z',
  },
  limitReached: { value: 'primary', observedAt: '2026-08-09T19:00:00.000Z' },
};

function update(
  overrides: Partial<ConnectionQuotaSnapshotUpdate> = {},
): ConnectionQuotaSnapshotUpdate {
  return {
    connectionId: 'codex',
    provider: 'codex',
    source: 'provider-reported',
    accountScope: 'profile',
    windows: [],
    ...overrides,
  };
}

describe('mergeQuotaSnapshot', () => {
  test('preserves a field present in one rolling update when the next omits it', () => {
    const presentThenAbsent = mergeQuotaSnapshot(
      baseline,
      update({
        plan: {
          value: { type: 'team' },
          observedAt: '2026-08-09T19:05:00.000Z',
        },
      }),
    )!;
    const absent = mergeQuotaSnapshot(presentThenAbsent, update());
    expect(absent).toMatchObject({
      plan: { value: { type: 'team' }, observedAt: '2026-08-09T19:05:00.000Z' },
    });
  });

  test('preserves prior values for explicit-null sparse groups', () => {
    const explicitNull = mergeQuotaSnapshot(
      baseline,
      update({ plan: null, credits: null, limitReached: null }),
    );
    expect(explicitNull).toMatchObject({
      plan: baseline.plan,
      credits: baseline.credits,
      limitReached: baseline.limitReached,
    });
  });

  test('keeps a stale window observation while a later sparse window updates', () => {
    const first = mergeQuotaSnapshot(
      baseline,
      update({
        windows: [
          {
            id: 'secondary',
            usedPercent: 7,
            observedAt: '2026-08-09T19:05:00.000Z',
          },
        ],
      }),
    )!;
    const second = mergeQuotaSnapshot(
      first,
      update({
        windows: [
          {
            id: 'secondary',
            usedPercent: 9,
            observedAt: '2026-08-09T19:10:00.000Z',
          },
        ],
      }),
    )!;
    expect(second.windows).toEqual([
      expect.objectContaining({
        id: 'primary',
        observedAt: '2026-08-09T19:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'secondary',
        usedPercent: 9,
        observedAt: '2026-08-09T19:10:00.000Z',
      }),
    ]);
    expect(second.observedAt).toBe('2026-08-09T19:10:00.000Z');
  });

  test('refuses to merge observations of a different connection or account scope', () => {
    // Blending two accounts' numbers under one label is the mislabeling this
    // contract exists to prevent — null (nothing observed) beats a lie.
    expect(
      mergeQuotaSnapshot(baseline, update({ connectionId: 'other-runtime' })),
    ).toBeNull();
    expect(
      mergeQuotaSnapshot(baseline, update({ accountScope: 'global' })),
    ).toBeNull();
    expect(
      mergeQuotaSnapshot(baseline, update({ provider: 'claude' })),
    ).toBeNull();
    // Same identity still merges.
    expect(mergeQuotaSnapshot(baseline, update())).not.toBeNull();
  });

  test('lets an equal-timestamp observation win, since ties are resolved by arrival', () => {
    // Deliberate semantic, pinned so it cannot drift silently: only a
    // STRICTLY older observation is rejected. Codex stamps notifications with
    // ARRIVAL time (documented on the contract), so two values sharing a
    // millisecond mean the one that arrived second is genuinely the later
    // observation — rejecting it would freeze the field at the first value
    // seen within any given millisecond.
    const merged = mergeQuotaSnapshot(
      baseline,
      update({
        windows: [
          {
            id: 'primary',
            usedPercent: 99,
            observedAt: baseline.windows[0]!.observedAt,
          },
        ],
      }),
    );
    expect(
      merged?.windows.find((window) => window.id === 'primary')?.usedPercent,
    ).toBe(99);
  });

  test('does not zero-fill a sparse update without a baseline', () => {
    expect(
      mergeQuotaSnapshot(
        undefined,
        update({
          windows: [
            {
              id: 'primary',
              usedPercent: 7,
              observedAt: '2026-08-09T19:05:00.000Z',
            },
          ],
        }),
      ),
    ).toMatchObject({ windows: [{ id: 'primary', usedPercent: 7 }] });
  });

  test('preserves nested window and credits fields in a newer sparse observation', () => {
    const enriched: ConnectionQuotaSnapshot = {
      ...baseline,
      windows: [
        {
          id: 'primary',
          usedPercent: 42,
          label: '5h',
          windowDurationMins: 300,
          resetsAt: 1_786_300_800,
          observedAt: '2026-08-09T19:00:00.000Z',
        },
      ],
    };
    expect(
      mergeQuotaSnapshot(
        enriched,
        update({
          windows: [
            {
              id: 'primary',
              usedPercent: 80,
              observedAt: '2026-08-09T19:10:00.000Z',
            },
          ],
          credits: {
            value: { hasCredits: true, unlimited: false },
            observedAt: '2026-08-09T19:10:00.000Z',
          },
        }),
      ),
    ).toEqual({
      ...enriched,
      observedAt: '2026-08-09T19:10:00.000Z',
      windows: [
        {
          id: 'primary',
          usedPercent: 80,
          label: '5h',
          windowDurationMins: 300,
          resetsAt: 1_786_300_800,
          observedAt: '2026-08-09T19:10:00.000Z',
        },
      ],
      credits: {
        value: { hasCredits: true, unlimited: false, balance: '10' },
        observedAt: '2026-08-09T19:10:00.000Z',
      },
    });
  });

  test('rejects delayed observations for every independently observed group', () => {
    const newer = mergeQuotaSnapshot(
      baseline,
      update({
        windows: [
          {
            id: 'primary',
            usedPercent: 80,
            observedAt: '2026-08-09T19:10:00.000Z',
          },
        ],
        plan: {
          value: { type: 'team' },
          observedAt: '2026-08-09T19:10:00.000Z',
        },
        credits: {
          value: { hasCredits: false, unlimited: false, balance: '5' },
          observedAt: '2026-08-09T19:10:00.000Z',
        },
        limitReached: {
          value: 'secondary',
          observedAt: '2026-08-09T19:10:00.000Z',
        },
        spendControl: {
          value: { limit: '10', used: '4', remainingPercent: 60, resetsAt: 9 },
          observedAt: '2026-08-09T19:10:00.000Z',
        },
      }),
    )!;
    const delayed = mergeQuotaSnapshot(
      newer,
      update({
        windows: [
          {
            id: 'primary',
            usedPercent: 20,
            observedAt: '2026-08-09T19:05:00.000Z',
          },
        ],
        plan: {
          value: { type: 'free' },
          observedAt: '2026-08-09T19:05:00.000Z',
        },
        credits: {
          value: { hasCredits: true, unlimited: true },
          observedAt: '2026-08-09T19:05:00.000Z',
        },
        limitReached: {
          value: 'primary',
          observedAt: '2026-08-09T19:05:00.000Z',
        },
        spendControl: {
          value: { limit: '1', used: '1', remainingPercent: 0, resetsAt: 1 },
          observedAt: '2026-08-09T19:05:00.000Z',
        },
      }),
    );
    expect(delayed).toEqual(newer);
  });
});
