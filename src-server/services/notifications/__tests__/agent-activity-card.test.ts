import { describe, expect, test } from 'vitest';
import { parseSendRequest } from '../../../../deploy/push-gateway/src/send-request.js';
import {
  type AgentActivityPhase,
  type AgentActivitySessionFacts,
  type AgentActivitySnapshot,
  agentActivityAlertId,
  agentActivityPhaseFor,
  buildAgentActivityCard,
} from '../agent-activity-card.js';

const STATION = 'station-1';
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function snapshot(
  sessionId: string,
  phase: AgentActivityPhase,
  ageMs = 0,
  extra: Partial<AgentActivitySnapshot> = {},
): AgentActivitySnapshot {
  return {
    sessionId,
    title: `Title ${sessionId}`,
    project: 'Station',
    phase,
    enteredAt: NOW - ageMs,
    ...extra,
  };
}

const card = (sessions: AgentActivitySnapshot[], now = NOW) =>
  buildAgentActivityCard({ sessions, stationId: STATION, now });

const rows = (fields: Record<string, string>) =>
  Object.keys(fields)
    .filter((key) => key.startsWith('activity_line_'))
    .sort()
    .map((key) => fields[key]);

describe('agentActivityPhaseFor', () => {
  const loaded = (facts: Partial<AgentActivitySessionFacts>) =>
    agentActivityPhaseFor({ isLoaded: true, ...facts });

  test.each([
    [{ lifecycleState: 'running' }, 'running'],
    [{ lifecycleState: 'queued', hasActiveTurn: true }, 'starting'],
    // An attached-but-idle session projects `queued` too; it is not activity.
    [{ lifecycleState: 'queued', hasActiveTurn: false }, null],
    [{ lifecycleState: 'queued' }, null],
    // The approval request: an unresolved non-input request.opened folds to
    // review_pending with pendingReview set.
    [
      { lifecycleState: 'review_pending', pendingReview: true },
      'waiting_for_approval',
    ],
    [
      { lifecycleState: 'running', pendingReview: true },
      'waiting_for_approval',
    ],
    [{ lifecycleState: 'needs_input' }, 'waiting_for_input'],
    [{ lifecycleState: 'blocked' }, 'stale'],
    [{ lifecycleState: 'completed' }, 'completed'],
    [{ lifecycleState: 'failed' }, 'failed'],
    // A first send that did not take reads Failed, as on every other surface.
    [
      {
        lifecycleState: 'queued',
        terminalAttribution: { kind: 'send_failed' },
      },
      'failed',
    ],
    [{ lifecycleState: 'canceled' }, null],
    [{ lifecycleState: 'running', status: 'closed' }, 'completed'],
    [{ lifecycleState: undefined }, null],
    [{ lifecycleState: 'running', draft: true }, null],
  ] as const)('%j → %s', (facts, expected) => {
    expect(loaded(facts as Partial<AgentActivitySessionFacts>)).toBe(expected);
  });

  test('live phases require the runtime to be attached; outcomes do not', () => {
    expect(
      agentActivityPhaseFor({ isLoaded: false, lifecycleState: 'running' }),
    ).toBeNull();
    expect(
      agentActivityPhaseFor({ isLoaded: false, lifecycleState: 'needs_input' }),
    ).toBeNull();
    expect(
      agentActivityPhaseFor({ isLoaded: false, lifecycleState: 'completed' }),
    ).toBe('completed');
    expect(
      agentActivityPhaseFor({ isLoaded: false, lifecycleState: 'failed' }),
    ).toBe('failed');
  });
});

describe('buildAgentActivityCard', () => {
  test('orders attention, then failed, then live, then recently finished, and uses the plugin row format', () => {
    const { fields } = card([
      snapshot('done', 'completed', 1 * MINUTE),
      snapshot('run', 'running', 5 * MINUTE),
      snapshot('fail', 'failed', 3 * MINUTE),
      snapshot('input', 'waiting_for_input', 10 * MINUTE),
      snapshot('approve', 'waiting_for_approval', 2 * MINUTE),
    ]);
    expect(rows(fields)).toEqual([
      'Approval\tTitle approve\tStation',
      'Input\tTitle input\tStation',
      'Failed\tTitle fail\tStation',
      'Working\tTitle run\tStation',
      'Done\tTitle done\tStation',
    ]);
    expect(fields.activity_phase).toBe('waiting_for_approval');
    expect(fields.station_kind).toBe('agent_activity');
    expect(fields.user_id).toBe(STATION);
    expect(fields.active).toBe('true');
    expect(fields.activity_expires_at).toBe(String(NOW + 2 * 60 * MINUTE));
  });

  test('caps rows at five while counts cover every session', () => {
    const sessions = [
      ...Array.from({ length: 4 }, (_, i) =>
        snapshot(`approve-${i}`, 'waiting_for_approval', i * MINUTE),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        snapshot(`run-${i}`, 'running', i * MINUTE),
      ),
      snapshot('done', 'completed', MINUTE),
    ];
    const { fields } = card(sessions);
    expect(rows(fields)).toHaveLength(5);
    expect(fields.activity_active_count).toBe('10');
    expect(fields.activity_attention_count).toBe('4');
  });

  test('finished sessions leave after fifteen minutes, and the card then reads finished', () => {
    const recent = card([snapshot('done', 'completed', 14 * MINUTE)]);
    expect(rows(recent.fields)).toEqual(['Done\tTitle done\tStation']);
    expect(recent.fields.active).toBe('false');
    expect(recent.fields.activity_expires_at).toBe(String(NOW + 15 * MINUTE));

    const old = card([
      snapshot('done', 'completed', 16 * MINUTE),
      snapshot('fail', 'failed', 16 * MINUTE),
    ]);
    expect(rows(old.fields)).toEqual([]);
    expect(old.empty).toBe(true);
    // An empty card expires immediately, which clears it on the phone.
    expect(old.fields.activity_expires_at).toBe(String(NOW));
    expect(old.fields.activity_active_count).toBe('0');
  });

  test('alerts on an approval or input request, with an id stable across rebuilds', () => {
    const sessions = [
      snapshot('run', 'running', 0),
      snapshot('approve', 'waiting_for_approval', 30 * MINUTE),
    ];
    const first = card(sessions);
    const later = card(sessions, NOW + 5 * MINUTE);
    expect(first.fields.alert_id).toBe(
      agentActivityAlertId({
        stationId: STATION,
        sessionId: 'approve',
        phase: 'waiting_for_approval',
        enteredAt: NOW - 30 * MINUTE,
      }),
    );
    expect(first.fields.alert_id).toMatch(/^[0-9a-f]{64}$/);
    expect(later.fields.alert_id).toBe(first.fields.alert_id);
    expect(first.fields.alert_title).toBe('Approval needed');
    expect(first.fields.alert_body).toBe('Title approve · Station');
  });

  test('a new entry into the same phase is a new alert', () => {
    const a = card([snapshot('s', 'waiting_for_input', 5 * MINUTE)]);
    const b = card([snapshot('s', 'waiting_for_input', 1 * MINUTE)]);
    expect(a.fields.alert_id).not.toBe(b.fields.alert_id);
    expect(b.fields.alert_title).toBe('Input needed');
  });

  test('alerts on a finish only within two minutes of it', () => {
    expect(card([snapshot('s', 'completed', MINUTE)]).fields.alert_title).toBe(
      'Agent finished',
    );
    expect(card([snapshot('s', 'failed', MINUTE)]).fields.alert_title).toBe(
      'Agent failed',
    );
    const stale = card([snapshot('s', 'completed', 3 * MINUTE)]).fields;
    expect(stale.alert_id).toBeUndefined();
    expect(stale.alert_title).toBeUndefined();
  });

  test('running, starting and blocked sessions do not alert', () => {
    const { fields } = card([
      snapshot('a', 'running'),
      snapshot('b', 'starting'),
      snapshot('c', 'stale'),
    ]);
    expect(fields.alert_id).toBeUndefined();
    // Blocked waits on the user: counted as attention.
    expect(fields.activity_attention_count).toBe('1');
  });

  test('the most recent alertable entry wins', () => {
    const { fields } = card([
      snapshot('older', 'waiting_for_approval', 10 * MINUTE),
      snapshot('newer', 'completed', MINUTE),
    ]);
    expect(fields.alert_title).toBe('Agent finished');
    expect(fields.alert_body).toBe('Title newer · Station');
  });

  test('titles and projects are flattened and truncated so they cannot break the row format', () => {
    const { fields } = card([
      snapshot('s', 'running', 0, {
        title: `Fix\tthe\nlogin\r\u0007test ${'x'.repeat(300)}`,
        project: `Proj\tect ${'p'.repeat(300)}`,
      }),
    ]);
    const [row] = rows(fields);
    const [status, title, project] = row?.split('\t') ?? [];
    expect(row?.split('\t')).toHaveLength(3);
    expect(status).toBe('Working');
    expect(title?.startsWith('Fix the login test x')).toBe(true);
    expect(Array.from(title ?? '')).toHaveLength(120);
    expect(title?.endsWith('…')).toBe(true);
    expect(Array.from(project ?? '')).toHaveLength(120);
    expect(project?.startsWith('Proj ect')).toBe(true);
  });

  test('an untitled session still renders a row the phone accepts', () => {
    const { fields } = card([snapshot('s', 'running', 0, { title: '  ' })]);
    expect(rows(fields)).toEqual(['Working\tUntitled session\tStation']);
  });

  test('the content key ignores the clock but tracks what the phone renders', () => {
    const sessions = [snapshot('s', 'running')];
    expect(card(sessions).contentKey).toBe(
      card(sessions, NOW + MINUTE).contentKey,
    );
    expect(card(sessions).contentKey).not.toBe(
      card([snapshot('s', 'waiting_for_input')]).contentKey,
    );
  });

  test('a card of long multibyte titles still fits what the gateway forwards', () => {
    const wide = '界'.repeat(400);
    const { fields } = card(
      Array.from({ length: 8 }, (_, i) =>
        snapshot(`s${i}`, 'waiting_for_approval', i * MINUTE, {
          title: wide,
          project: wide,
        }),
      ),
    );
    expect(rows(fields).length).toBeGreaterThan(0);
    const parsed = parseSendRequest(
      new TextEncoder().encode(
        JSON.stringify({
          token: 't'.repeat(163),
          packageName: 'io.kontourai.station',
          data: {
            ...fields,
            device_id: 'r'.repeat(22),
            updated_at: String(NOW),
          },
        }),
      ) as Uint8Array<ArrayBuffer>,
      ['io.kontourai.station'],
    );
    expect(parsed.ok).toBe(true);
    // Counts still describe all eight, not just the rows that fit.
    expect(fields.activity_attention_count).toBe('8');
  });
});
