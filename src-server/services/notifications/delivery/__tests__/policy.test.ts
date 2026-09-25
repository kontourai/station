import {
  type NotificationEnvelopeV1,
  type NotificationUrgency,
} from '@kontourai/station-contracts/notification';
import {
  defaultNotificationPreferences,
  type NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import { describe, expect, test } from 'vitest';
import type { SurfaceId } from '../channel.js';
import {
  deliveryKey,
  FOCUS_LEASE_MS,
  type FocusEntry,
  isWithinQuietHours,
  type PlanInput,
  type PlanStep,
  plan,
} from '../policy.js';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0); // 12:00 UTC
const PHONE: SurfaceId = 'device:phone';
const LAPTOP: SurfaceId = 'device:laptop';
const DESK: SurfaceId = 'local:desk-session';
const ALICE = 'human:local:operator';
const BOB = 'device:bob-principal';

function agentEnvelope(
  urgency: NotificationUrgency,
  overrides: Partial<NotificationEnvelopeV1> = {},
): NotificationEnvelopeV1 {
  return {
    v: 1,
    source: {
      kind: 'agent',
      sessionId: 'session-1',
      projectId: 'project-a',
      agent: 'builder',
      assurance: 'bound',
    },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency,
    interrupt: 'default',
    ...overrides,
  };
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    env: agentEnvelope('attention'),
    now: NOW,
    surfaces: [
      { id: PHONE, principalId: ALICE, channels: ['web-push'] },
      { id: LAPTOP, principalId: ALICE, channels: ['web-push'] },
    ],
    focus: new Map(),
    liveInApp: new Set([PHONE, LAPTOP, DESK]),
    prefs: defaultNotificationPreferences(),
    priorDeliveries: new Set(),
    timeZone: 'UTC',
    ...overrides,
  };
}

function prefs(
  overrides: Partial<NotificationPreferencesV1>,
): NotificationPreferencesV1 {
  return { ...defaultNotificationPreferences(), ...overrides };
}

function focused(reportedAt = NOW - 1_000, principalId = ALICE): FocusEntry {
  return { state: 'focused', reportedAt, principalId };
}

/** The non-in-app decision for one surface, as `action:reason`. */
function decision(steps: PlanStep[], surface: SurfaceId): string {
  const step = steps.find(
    (candidate) =>
      candidate.surface === surface && candidate.channel !== 'in-app',
  );
  return step ? `${step.action}:${step.reason}` : 'none';
}

describe('plan() — rule 3, nothing focused', () => {
  test.each<NotificationUrgency>(['info', 'done', 'failed', 'attention'])(
    '%s goes to every channel on every surface',
    (urgency) => {
      const steps = plan(input({ env: agentEnvelope(urgency) }));
      expect(decision(steps, PHONE)).toBe('send:nothing-focused');
      expect(decision(steps, LAPTOP)).toBe('send:nothing-focused');
    },
  );

  test('in-app is planned for every surface and never suppressed', () => {
    const steps = plan(
      input({
        env: agentEnvelope('info', { interrupt: 'silent' }),
        prefs: prefs({ agentNotifications: 'off' }),
      }),
    );
    expect(
      steps
        .filter((step) => step.channel === 'in-app')
        .map((step) => `${step.surface}:${step.action}`),
    ).toEqual([`${PHONE}:send`, `${LAPTOP}:send`]);
  });

  test('a pair already delivered is not sent again', () => {
    const steps = plan(
      input({ priorDeliveries: new Set([deliveryKey(PHONE, 'web-push')]) }),
    );
    expect(decision(steps, PHONE)).toBe('skip:already-delivered');
    expect(decision(steps, LAPTOP)).toBe('send:nothing-focused');
  });
});

describe('plan() — rule 2, some surface focused', () => {
  const focusOnLaptop = new Map([[LAPTOP, focused()]]);

  test.each<[NotificationUrgency, string]>([
    ['info', 'skip:another-surface-focused'],
    ['done', 'skip:another-surface-focused'],
    ['failed', 'defer:escalate-if-unread'],
    ['attention', 'defer:escalate-if-unread'],
  ])('%s on the other surfaces → %s', (urgency, expected) => {
    const steps = plan(
      input({ env: agentEnvelope(urgency), focus: focusOnLaptop }),
    );
    expect(decision(steps, PHONE)).toBe(expected);
    // The focused surface itself only gets the in-app toast.
    expect(decision(steps, LAPTOP)).toBe('skip:focused-surface');
  });

  test('the deferral carries escalateAfterMs', () => {
    const steps = plan(
      input({
        focus: focusOnLaptop,
        prefs: prefs({ escalateAfterMs: 42_000 }),
      }),
    );
    expect(steps.find((step) => step.action === 'defer')?.deferMs).toBe(42_000);
  });

  test('a focused local surface with no channels still counts as focus', () => {
    const steps = plan(
      input({
        surfaces: [
          { id: PHONE, principalId: ALICE, channels: ['web-push'] },
          { id: DESK, principalId: ALICE, channels: [] },
        ],
        focus: new Map([[DESK, focused()]]),
      }),
    );
    expect(decision(steps, PHONE)).toBe('defer:escalate-if-unread');
  });

  test('visible and hidden are not focus', () => {
    for (const state of ['visible', 'hidden'] as const) {
      const steps = plan(
        input({
          focus: new Map([
            [LAPTOP, { state, reportedAt: NOW, principalId: ALICE }],
          ]),
        }),
      );
      expect(decision(steps, PHONE)).toBe('send:nothing-focused');
    }
  });

  test('a focus report older than the lease is not focus', () => {
    const at = (reportedAt: number) =>
      decision(
        plan(input({ focus: new Map([[LAPTOP, focused(reportedAt)]]) })),
        PHONE,
      );
    expect(at(NOW - FOCUS_LEASE_MS)).toBe('defer:escalate-if-unread');
    expect(at(NOW - FOCUS_LEASE_MS - 1)).toBe('send:nothing-focused');
  });

  test("another person's focus never quiets this person's surfaces", () => {
    const steps = plan(
      input({
        surfaces: [
          { id: PHONE, principalId: ALICE, channels: ['web-push'] },
          { id: LAPTOP, principalId: BOB, channels: ['web-push'] },
        ],
        focus: new Map([[LAPTOP, focused(NOW, BOB)]]),
      }),
    );
    expect(decision(steps, PHONE)).toBe('send:nothing-focused');
    expect(decision(steps, LAPTOP)).toBe('skip:focused-surface');
  });

  test('a surface with no resolved principal is never quieted by focus', () => {
    const steps = plan(
      input({
        surfaces: [
          { id: PHONE, channels: ['web-push'] },
          { id: LAPTOP, principalId: ALICE, channels: ['web-push'] },
        ],
        focus: focusOnLaptop,
      }),
    );
    expect(decision(steps, PHONE)).toBe('send:nothing-focused');
  });

  test('a focused surface without a live in-app channel is not focus', () => {
    // It could not show the toast, so it must not silence the phone.
    const steps = plan(
      input({ focus: focusOnLaptop, liveInApp: new Set([PHONE]) }),
    );
    expect(decision(steps, PHONE)).toBe('send:nothing-focused');
    expect(decision(steps, LAPTOP)).toBe('send:nothing-focused');
  });

  test('attention is never dropped because another surface is focused — only deferred', () => {
    const shapes: Array<Partial<PlanInput>> = [
      { focus: focusOnLaptop },
      {
        focus: new Map([
          [LAPTOP, focused()],
          [DESK, focused()],
        ]),
      },
      {
        surfaces: [
          { id: PHONE, principalId: ALICE, channels: ['web-push'] },
          {
            id: LAPTOP,
            principalId: ALICE,
            channels: ['web-push', 'fcm-alert'],
          },
          { id: DESK, principalId: ALICE, channels: [] },
        ],
        focus: new Map([[DESK, focused()]]),
      },
    ];
    for (const shape of shapes) {
      const steps = plan(input({ env: agentEnvelope('attention'), ...shape }));
      for (const step of steps) {
        if (step.channel === 'in-app') continue;
        const focusedHere = shape.focus?.has(step.surface) === true;
        if (focusedHere) expect(step.reason).toBe('focused-surface');
        else
          expect(step).toMatchObject({
            action: 'defer',
            reason: 'escalate-if-unread',
          });
      }
      // ...and once the deferral runs out, it is sent.
      const escalated = plan(
        input({
          env: agentEnvelope('attention'),
          ...shape,
          phase: 'escalation',
        }),
      );
      expect(decision(escalated, PHONE)).toBe('send:escalation');
    }
  });

  test('escalation phase sends the deferred surfaces, never the focused one, never in-app again', () => {
    const steps = plan(input({ focus: focusOnLaptop, phase: 'escalation' }));
    expect(decision(steps, PHONE)).toBe('send:escalation');
    expect(decision(steps, LAPTOP)).toBe('skip:focused-surface');
    expect(steps.some((step) => step.channel === 'in-app')).toBe(false);
  });
});

describe('plan() — rule 1, silent or muted', () => {
  test('silent reaches in-app only', () => {
    const steps = plan(
      input({ env: agentEnvelope('attention', { interrupt: 'silent' }) }),
    );
    expect(decision(steps, PHONE)).toBe('skip:silent');
    expect(decision(steps, LAPTOP)).toBe('skip:silent');
  });

  test.each<
    [
      NotificationPreferencesV1['agentNotifications'],
      NotificationUrgency,
      string,
    ]
  >([
    ['off', 'attention', 'skip:muted'],
    ['off', 'info', 'skip:muted'],
    ['attention-only', 'attention', 'send:nothing-focused'],
    // Failures pass attention-only: the person acts on them.
    ['attention-only', 'failed', 'send:nothing-focused'],
    ['attention-only', 'info', 'skip:muted'],
    ['attention-only', 'done', 'skip:muted'],
    ['all', 'info', 'send:nothing-focused'],
  ])('agentNotifications %s, %s → %s', (level, urgency, expected) => {
    const steps = plan(
      input({
        env: agentEnvelope(urgency),
        prefs: prefs({ agentNotifications: level }),
      }),
    );
    expect(decision(steps, PHONE)).toBe(expected);
  });

  test('a per-agent override beats a per-project one, which beats the global level', () => {
    const muted = (p: Partial<NotificationPreferencesV1>) =>
      decision(plan(input({ prefs: prefs(p) })), PHONE);
    expect(muted({ perProject: { 'project-a': 'off' } })).toBe('skip:muted');
    expect(
      muted({
        perProject: { 'project-a': 'off' },
        perAgent: { builder: 'all' },
      }),
    ).toBe('send:nothing-focused');
    expect(
      muted({ agentNotifications: 'off', perProject: { 'project-a': 'all' } }),
    ).toBe('send:nothing-focused');
  });

  test('system notifications are never muted by agent preferences', () => {
    const steps = plan(
      input({
        env: {
          v: 1,
          source: { kind: 'system', subsystem: 'approval-inbox' },
          audience: { kind: 'owner' },
          urgency: 'attention',
          interrupt: 'default',
        },
        prefs: prefs({ agentNotifications: 'off' }),
      }),
    );
    expect(decision(steps, PHONE)).toBe('send:nothing-focused');
  });
});

describe('plan() — rule 4, quiet hours', () => {
  const night = prefs({
    quietHours: { start: '11:00', end: '13:00', allowAttention: false },
  });

  test('inside the window nothing interrupts, focused or not', () => {
    expect(decision(plan(input({ prefs: night })), PHONE)).toBe(
      'skip:quiet-hours',
    );
    // Quiet hours never become a deferred interruption either.
    expect(
      decision(
        plan(input({ prefs: night, focus: new Map([[LAPTOP, focused()]]) })),
        PHONE,
      ),
    ).toBe('skip:quiet-hours');
  });

  test('allowAttention lets attention through, and only attention', () => {
    const allow = prefs({
      quietHours: { start: '11:00', end: '13:00', allowAttention: true },
    });
    expect(decision(plan(input({ prefs: allow })), PHONE)).toBe(
      'send:nothing-focused',
    );
    expect(
      decision(
        plan(input({ prefs: allow, env: agentEnvelope('failed') })),
        PHONE,
      ),
    ).toBe('skip:quiet-hours');
  });

  test('outside the window it does nothing', () => {
    const later = prefs({
      quietHours: { start: '13:00', end: '14:00', allowAttention: false },
    });
    expect(decision(plan(input({ prefs: later })), PHONE)).toBe(
      'send:nothing-focused',
    );
  });

  test("the window is read in the person's stored zone, not the host's", () => {
    // 12:00 UTC is 21:00 in Tokyo: inside 20:00–23:00 there, outside in UTC.
    const tokyo = prefs({
      quietHours: {
        start: '20:00',
        end: '23:00',
        allowAttention: false,
        timeZone: 'Asia/Tokyo',
      },
    });
    expect(
      decision(plan(input({ prefs: tokyo, timeZone: 'UTC' })), PHONE),
    ).toBe('skip:quiet-hours');
    const { timeZone: _zone, ...hostZone } = tokyo.quietHours!;
    expect(
      decision(
        plan(
          input({ prefs: prefs({ quietHours: hostZone }), timeZone: 'UTC' }),
        ),
        PHONE,
      ),
    ).toBe('send:nothing-focused');
  });

  test('windows wrap midnight and are read in the Station time zone', () => {
    const overnight = { start: '22:00', end: '07:00', allowAttention: false };
    expect(
      isWithinQuietHours(overnight, Date.UTC(2026, 0, 1, 23, 30), 'UTC'),
    ).toBe(true);
    expect(
      isWithinQuietHours(overnight, Date.UTC(2026, 0, 1, 6, 59), 'UTC'),
    ).toBe(true);
    expect(
      isWithinQuietHours(overnight, Date.UTC(2026, 0, 1, 7, 0), 'UTC'),
    ).toBe(false);
    expect(
      isWithinQuietHours(overnight, Date.UTC(2026, 0, 1, 12, 0), 'UTC'),
    ).toBe(false);
    // 12:00 UTC is 23:00 in Sydney (AEDT, January).
    expect(
      isWithinQuietHours(
        overnight,
        Date.UTC(2026, 0, 1, 12, 0),
        'Australia/Sydney',
      ),
    ).toBe(true);
  });
});

describe('plan() — rule 5, per-surface minUrgency', () => {
  test.each<[NotificationUrgency, NotificationUrgency, string]>([
    ['attention', 'info', 'send:nothing-focused'],
    ['failed', 'attention', 'skip:below-min-urgency'],
    ['failed', 'failed', 'send:nothing-focused'],
    ['done', 'failed', 'skip:below-min-urgency'],
    ['info', 'done', 'skip:below-min-urgency'],
  ])('%s against minUrgency %s → %s', (urgency, minUrgency, expected) => {
    const steps = plan(
      input({
        env: agentEnvelope(urgency),
        prefs: prefs({
          perSurface: { [PHONE]: { minUrgency, hideContent: false } },
        }),
      }),
    );
    expect(decision(steps, PHONE)).toBe(expected);
    // Only the surface that set it.
    expect(decision(steps, LAPTOP)).toBe('send:nothing-focused');
  });
});
