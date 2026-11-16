import type {
  Notification,
  NotificationEnvelopeV1,
  NotificationUrgency,
} from '@kontourai/station-contracts/notification';
import {
  defaultNotificationPreferences,
  type NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import { describe, expect, test } from 'vitest';
import { deliveryEnvelopeFor, type SurfaceId } from '../channel.js';
import {
  deliveryKey,
  FOCUS_LEASE_MS,
  type FocusEntry,
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

  test('unreadable preferences: agent notifications stay in-app, system ones still go out', () => {
    const agent = plan(input({ preferencesUnreadable: true }));
    expect(decision(agent, PHONE)).toBe('skip:preferences-unreadable');
    expect(
      agent.some((s) => s.channel === 'in-app' && s.action === 'send'),
    ).toBe(true);
    const system = plan(
      input({
        preferencesUnreadable: true,
        env: {
          v: 1,
          source: { kind: 'system', subsystem: 'approval-inbox' },
          audience: { kind: 'owner' },
          urgency: 'attention',
          interrupt: 'default',
        },
      }),
    );
    expect(decision(system, PHONE)).toBe('send:nothing-focused');
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

  test.each<[string, string, number, string]>([
    ['23:30 UTC', 'skip:quiet-hours', Date.UTC(2026, 0, 1, 23, 30), 'UTC'],
    ['06:59 UTC', 'skip:quiet-hours', Date.UTC(2026, 0, 1, 6, 59), 'UTC'],
    ['07:00 UTC', 'send:nothing-focused', Date.UTC(2026, 0, 1, 7, 0), 'UTC'],
    ['12:00 UTC', 'send:nothing-focused', Date.UTC(2026, 0, 1, 12, 0), 'UTC'],
    // 12:00 UTC is 23:00 in Sydney (AEDT, January).
    [
      '12:00 UTC in Sydney',
      'skip:quiet-hours',
      Date.UTC(2026, 0, 1, 12, 0),
      'Australia/Sydney',
    ],
  ])(
    'a 22:00–07:00 window wraps midnight in the Station time zone: %s → %s',
    (_label, expected, now, timeZone) => {
      const overnight = prefs({
        quietHours: { start: '22:00', end: '07:00', allowAttention: false },
      });
      expect(
        decision(plan(input({ prefs: overnight, now, timeZone })), PHONE),
      ).toBe(expected);
    },
  );
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

describe('plan() — focus is per session for a finished session (viewingSessionIds)', () => {
  const finished = agentEnvelope('done', {
    target: { kind: 'session', sessionId: 'session-1' },
  });
  const watching = (viewingSessionIds: readonly string[]): FocusEntry => ({
    ...focused(),
    viewingSessionIds,
  });

  test('the laptop showing that session quiets the phone and itself', () => {
    const steps = plan(
      input({
        env: finished,
        focus: new Map([[LAPTOP, watching(['session-1'])]]),
      }),
    );
    expect(decision(steps, LAPTOP)).toBe('skip:focused-surface');
    expect(decision(steps, PHONE)).toBe('skip:another-surface-focused');
  });

  test.each([
    ['another chat', ['session-2']],
    ['no chat at all', []],
  ])('the laptop showing %s quiets nothing', (_label, viewing) => {
    const steps = plan(
      input({ env: finished, focus: new Map([[LAPTOP, watching(viewing)]]) }),
    );
    expect(decision(steps, LAPTOP)).toBe('send:nothing-focused');
    expect(decision(steps, PHONE)).toBe('send:nothing-focused');
  });

  test('a client that does not report what it shows keeps the device-wide rule', () => {
    const steps = plan(
      input({ env: finished, focus: new Map([[LAPTOP, focused()]]) }),
    );
    expect(decision(steps, PHONE)).toBe('skip:another-surface-focused');
  });

  test('attention and failed keep surface-wide focus: deferred, not sent now', () => {
    for (const urgency of ['attention', 'failed'] as const) {
      const steps = plan(
        input({
          env: agentEnvelope(urgency, {
            target: { kind: 'session', sessionId: 'session-1' },
          }),
          focus: new Map([[LAPTOP, watching(['session-2'])]]),
        }),
      );
      expect(decision(steps, PHONE), urgency).toBe('defer:escalate-if-unread');
    }
  });
});

describe('plan() — per-Project notification settings (#5072)', () => {
  const turn = (
    urgency: NotificationUrgency,
    /** `null`: a record that names no Project. */
    projectId: string | null = 'project-a',
  ): NotificationEnvelopeV1 => ({
    v: 1,
    source: {
      kind: 'system',
      subsystem: 'turn-completion',
      ...(projectId ? { projectId } : {}),
    },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency,
    target: { kind: 'session', sessionId: 'session-1' },
    interrupt: 'default',
  });
  // The approval inbox writes no envelope; its legacy reading names the
  // Project from the record's metadata, exactly as the router reads it.
  const { envelope: approval } = deliveryEnvelopeFor({
    id: 'n-1',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Provider approval needed',
    body: 'Run tests?',
    priority: 'high',
    createdAt: '2026-09-24T12:00:00.000Z',
    metadata: { sessionId: 'session-1', projectId: 'project-a' },
  } as unknown as Notification);

  test('a legacy approval record reads its Project from metadata', () => {
    expect(approval.source).toEqual({
      kind: 'system',
      subsystem: 'approval-inbox',
      projectId: 'project-a',
    });
    expect(approval.urgency).toBe('attention');
  });
  const blocked = prefs({ perProject: { 'project-a': 'attention-only' } });
  /** The `project-overview` Feature Preview on. */
  const on = (overrides: Partial<PlanInput>) =>
    input({ projectSettings: true, ...overrides });
  const sends = (steps: PlanStep[]) =>
    steps.filter((step) => step.channel !== 'in-app' && step.action === 'send')
      .length;

  test('"Only when blocked": a finished Task interrupts nothing, a request for input interrupts once per surface', () => {
    const finished = plan(on({ env: turn('done'), prefs: blocked }));
    expect(decision(finished, PHONE)).toBe('skip:muted');
    expect(decision(finished, LAPTOP)).toBe('skip:muted');
    expect(sends(finished)).toBe(0);
    // The inbox still gets it.
    expect(finished.filter((step) => step.channel === 'in-app').length).toBe(2);

    const asking = plan(
      on({
        env: approval,
        prefs: blocked,
        surfaces: [{ id: PHONE, principalId: ALICE, channels: ['web-push'] }],
      }),
    );
    expect(decision(asking, PHONE)).toBe('send:nothing-focused');
    expect(sends(asking)).toBe(1);
  });

  test('"Only when blocked" still sends a failure; "Off" sends nothing; "Everything" sends a finish', () => {
    expect(
      decision(plan(on({ env: turn('failed'), prefs: blocked })), PHONE),
    ).toBe('send:nothing-focused');
    const off = prefs({ perProject: { 'project-a': 'off' } });
    expect(decision(plan(on({ env: approval, prefs: off })), PHONE)).toBe(
      'skip:muted',
    );
    const all = prefs({ perProject: { 'project-a': 'all' } });
    expect(decision(plan(on({ env: turn('done'), prefs: all })), PHONE)).toBe(
      'send:nothing-focused',
    );
  });

  test('another Project, a record with no Project, and the global level leave system records alone', () => {
    expect(
      decision(
        plan(on({ env: turn('done', 'project-b'), prefs: blocked })),
        PHONE,
      ),
    ).toBe('send:nothing-focused');
    expect(
      decision(plan(on({ env: turn('done', null), prefs: blocked })), PHONE),
    ).toBe('send:nothing-focused');
    expect(
      decision(
        plan(
          on({
            env: turn('done'),
            prefs: prefs({ agentNotifications: 'off' }),
          }),
        ),
        PHONE,
      ),
    ).toBe('send:nothing-focused');
  });

  test('a subsystem that is not a Project’s own work is never muted by its level', () => {
    const pairing: NotificationEnvelopeV1 = {
      ...approval,
      source: {
        kind: 'system',
        subsystem: 'device-pairing',
        projectId: 'project-a',
      },
    };
    const off = prefs({ perProject: { 'project-a': 'off' } });
    expect(decision(plan(on({ env: pairing, prefs: off })), PHONE)).toBe(
      'send:nothing-focused',
    );
  });

  test('a device showing the Project quiets that Project’s finished turns', () => {
    const viewingProject = (projectId: string): FocusEntry => ({
      ...focused(),
      viewingSessionIds: [],
      viewingProjectIds: [projectId],
    });
    const quiet = plan(
      on({
        env: turn('done'),
        focus: new Map([[LAPTOP, viewingProject('project-a')]]),
      }),
    );
    expect(decision(quiet, LAPTOP)).toBe('skip:focused-surface');
    const other = plan(
      on({
        env: turn('done'),
        focus: new Map([[LAPTOP, viewingProject('project-b')]]),
      }),
    );
    expect(decision(other, LAPTOP)).toBe('send:nothing-focused');
  });

  test('with the preview off, a Project’s level and its foreground leave system records alone', () => {
    expect(
      decision(plan(input({ env: turn('done'), prefs: blocked })), PHONE),
    ).toBe('send:nothing-focused');
    const steps = plan(
      input({
        env: turn('done'),
        focus: new Map([
          [
            LAPTOP,
            {
              ...focused(),
              viewingSessionIds: [],
              viewingProjectIds: ['project-a'],
            },
          ],
        ]),
      }),
    );
    expect(decision(steps, LAPTOP)).toBe('send:nothing-focused');
  });
});
