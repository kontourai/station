import { readFileSync } from 'node:fs';
import { NATIVE_PUSH_SESSION_REFERENCE_PATTERN } from '@kontourai/station-contracts/native-push';
import { describe, expect, test } from 'vitest';
import { parseSendRequest } from '../../../../deploy/push-gateway/src/send-request.js';
import {
  type AgentActivityPhase,
  type AgentActivitySessionFacts,
  type AgentActivitySnapshot,
  agentActivityAlertFields,
  agentActivityEntryId,
  agentActivityPhaseFor,
  buildAgentActivityCard,
  composeAgentActivityPlaintext,
} from '../agent-activity-card.js';
import { sealAgentActivityCard } from '../agent-activity-seal.js';

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
    entryKey: `entry:${sessionId}:${phase}:${ageMs}`,
    ...extra,
  };
}

const card = (sessions: AgentActivitySnapshot[], now = NOW) =>
  buildAgentActivityCard({ sessions, stationId: STATION, now });

/** What one phone decrypts: the card plus its alert. */
function plaintextFor(sessions: AgentActivitySnapshot[], now = NOW) {
  const built = card(sessions, now);
  return JSON.parse(
    composeAgentActivityPlaintext(
      built,
      agentActivityAlertFields(built.alertables),
      now,
    ),
  ) as Record<string, string>;
}

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
    const fields = plaintextFor([
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
    expect(fields.user_id).toBe(STATION);
    expect(fields.updated_at).toBe(String(NOW));
    expect(fields.active).toBe('true');
    expect(fields.activity_expires_at).toBe(String(NOW + 2 * 60 * MINUTE));
    // Routing fields travel outside the sealed card, never inside it.
    expect(fields.station_kind).toBeUndefined();
    expect(fields.device_id).toBeUndefined();
  });

  test('caps rows at five while counts cover every session', () => {
    const fields = plaintextFor([
      ...Array.from({ length: 4 }, (_, i) =>
        snapshot(`approve-${i}`, 'waiting_for_approval', i * MINUTE),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        snapshot(`run-${i}`, 'running', i * MINUTE),
      ),
      snapshot('done', 'completed', MINUTE),
    ]);
    expect(rows(fields)).toHaveLength(5);
    expect(fields.activity_active_count).toBe('10');
    expect(fields.activity_attention_count).toBe('4');
  });

  test('a blocked session is live but is not attention: the phone counts approval and input only', () => {
    const fields = plaintextFor([
      snapshot('blocked', 'stale'),
      snapshot('approve', 'waiting_for_approval'),
    ]);
    expect(fields.activity_attention_count).toBe('1');
    expect(fields.activity_active_count).toBe('2');
  });

  test('finished sessions leave after fifteen minutes, and the card then reads finished', () => {
    const recent = plaintextFor([snapshot('done', 'completed', 14 * MINUTE)]);
    expect(rows(recent)).toEqual(['Done\tTitle done\tStation']);
    expect(recent.active).toBe('false');
    expect(recent.activity_expires_at).toBe(String(NOW + 15 * MINUTE));

    const old = plaintextFor([
      snapshot('done', 'completed', 16 * MINUTE),
      snapshot('fail', 'failed', 16 * MINUTE),
    ]);
    expect(rows(old)).toEqual([]);
    // An empty card expires immediately, which clears it on the phone.
    expect(old.activity_expires_at).toBe(String(NOW));
    expect(old.activity_phase).toBeUndefined();
  });

  test('alerts on an approval or input request, with an id derived from the entry, not the clock', () => {
    const sessions = [
      snapshot('run', 'running', 0),
      snapshot('approve', 'waiting_for_approval', 30 * MINUTE),
    ];
    const first = plaintextFor(sessions);
    const later = plaintextFor(sessions, NOW + 5 * MINUTE);
    expect(first.alert_id).toBe(
      agentActivityEntryId({
        stationId: STATION,
        sessionId: 'approve',
        phase: 'waiting_for_approval',
        entryKey: 'entry:approve:waiting_for_approval:1800000',
      }),
    );
    expect(later.alert_id).toBe(first.alert_id);
    expect(first.alert_title).toBe('Approval needed');
    expect(first.alert_body).toBe('Title approve · Station');
  });

  test('a second request on the same session is a different alert', () => {
    const a = plaintextFor([
      snapshot('s', 'waiting_for_input', MINUTE, { entryKey: 'request:A' }),
    ]);
    const b = plaintextFor([
      snapshot('s', 'waiting_for_input', MINUTE, { entryKey: 'request:B' }),
    ]);
    expect(a.alert_id).not.toBe(b.alert_id);
  });

  test('alerts on a finish only within two minutes of it', () => {
    expect(plaintextFor([snapshot('s', 'completed', MINUTE)]).alert_title).toBe(
      'Agent finished',
    );
    expect(plaintextFor([snapshot('s', 'failed', MINUTE)]).alert_title).toBe(
      'Agent failed',
    );
    const stale = plaintextFor([snapshot('s', 'completed', 3 * MINUTE)]);
    expect(stale.alert_id).toBeUndefined();
  });

  test('running, starting and blocked sessions do not alert', () => {
    const fields = plaintextFor([
      snapshot('a', 'running'),
      snapshot('b', 'starting'),
      snapshot('c', 'stale'),
    ]);
    expect(fields.alert_id).toBeUndefined();
  });

  test('titles and projects are flattened and truncated so they cannot break the row format', () => {
    const fields = plaintextFor([
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
    expect(
      rows(plaintextFor([snapshot('s', 'running', 0, { title: '  ' })])),
    ).toEqual(['Working\tUntitled session\tStation']);
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

  test('a sealed card of long multibyte titles and a full alert still fits what the gateway forwards', () => {
    const wide = '界'.repeat(400);
    // Longest session references the contract allows (#2515), on the hero
    // and on a single-session alert (so the alert carries its own
    // reference), are inside the same budget.
    const sessions = Array.from({ length: 8 }, (_, i) =>
      snapshot(
        `${i}${'s'.repeat(127)}`,
        i === 0 ? 'waiting_for_approval' : 'running',
        i * MINUTE,
        {
          title: wide,
          project: wide,
          projectSlug: `${i}${'p'.repeat(127)}`,
        },
      ),
    );
    const built = card(sessions);
    const plaintext = composeAgentActivityPlaintext(
      built,
      agentActivityAlertFields(built.alertables),
      NOW,
    );
    const registrationId = 'r'.repeat(64);
    const data = {
      station_kind: 'agent_activity',
      device_id: registrationId,
      sealed: sealAgentActivityCard({
        plaintext,
        payloadKey: Buffer.alloc(32, 7).toString('base64url'),
        registrationId,
      }),
    };
    const parsed = parseSendRequest(
      new TextEncoder().encode(
        JSON.stringify({
          token: 't'.repeat(163),
          packageName: 'io.kontourai.station',
          data,
        }),
      ) as Uint8Array<ArrayBuffer>,
      ['io.kontourai.station'],
    );
    expect(parsed.ok).toBe(true);
    // Room left for the station_key the gateway stamps, under FCM's 4096.
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...data, station_key: 'k'.repeat(43) }),
      ),
    ).toBeLessThan(3800);
    const fields = JSON.parse(plaintext) as Record<string, string>;
    expect(rows(fields).length).toBeGreaterThan(0);
    expect(fields.activity_session_id).toBe(`0${'s'.repeat(127)}`);
    expect(fields.activity_project_slug).toBe(`0${'p'.repeat(127)}`);
    expect(fields.alert_session_id).toBe(`0${'s'.repeat(127)}`);
    expect(fields.alert_project_slug).toBe(`0${'p'.repeat(127)}`);
    // Counts still describe all eight, not just the rows that fit.
    expect(fields.activity_active_count).toBe('8');
    expect(fields.activity_attention_count).toBe('1');
  });
});

describe('session references (#2515)', () => {
  test('the card names its first row’s session and project slug, inside the plaintext', () => {
    const fields = plaintextFor([
      snapshot('run-1', 'running', 0, { projectSlug: 'login-app' }),
      snapshot('approve-1', 'waiting_for_approval', 5 * MINUTE, {
        projectSlug: 'station',
      }),
    ]);
    // Row 0 is the approval (attention ranks first), so the tap opens it.
    expect(rows(fields)[0]).toBe('Approval\tTitle approve-1\tStation');
    expect(fields.activity_session_id).toBe('approve-1');
    expect(fields.activity_project_slug).toBe('station');
    // The single alert names the same session.
    expect(fields.alert_session_id).toBe('approve-1');
    expect(fields.alert_project_slug).toBe('station');
  });

  test('a session with no project is referenced by id alone', () => {
    const fields = plaintextFor([
      snapshot('solo', 'waiting_for_input', 0, { projectSlug: undefined }),
    ]);
    expect(fields.activity_session_id).toBe('solo');
    expect(fields).not.toHaveProperty('activity_project_slug');
    expect(fields.alert_session_id).toBe('solo');
    expect(fields).not.toHaveProperty('alert_project_slug');
  });

  test('ids outside the contract grammar are not sent, so the tap opens the app where it was', () => {
    for (const [sessionId, projectSlug] of [
      ['../etc', undefined],
      ['s/1', undefined],
      ['-leading-dash', undefined],
      ['s'.repeat(129), undefined],
      ['ok', 'has space'],
      ['ok', 'https://evil.example'],
    ] as const) {
      const fields = plaintextFor([
        snapshot(sessionId, 'waiting_for_approval', 0, {
          ...(projectSlug ? { projectSlug } : {}),
        }),
      ]);
      expect(fields.alert_id).toBeDefined();
      expect(fields).not.toHaveProperty('activity_session_id');
      expect(fields).not.toHaveProperty('activity_project_slug');
      expect(fields).not.toHaveProperty('alert_session_id');
      expect(fields).not.toHaveProperty('alert_project_slug');
    }
  });

  test('a grouped alert names no session; the card still names its first row', () => {
    const fields = plaintextFor([
      snapshot('a', 'waiting_for_approval', 0),
      snapshot('b', 'waiting_for_input', MINUTE),
    ]);
    expect(fields.alert_title).toBe('2 agents need you');
    expect(fields).not.toHaveProperty('alert_session_id');
    expect(fields.activity_session_id).toBe('a');
  });

  test('a card with no rows names no session', () => {
    const built = card([snapshot('a', 'waiting_for_approval', 0)]);
    const fields = JSON.parse(
      composeAgentActivityPlaintext({ ...built, rows: [] }, {}, NOW),
    ) as Record<string, string>;
    expect(fields).not.toHaveProperty('activity_session_id');
  });

  test('the phone refuses exactly what the Station does not send: one grammar on both sides', () => {
    const model = readFileSync(
      new URL(
        '../../../../src-desktop/plugins/agent-activity/android/src/main/java/io/kontourai/station/agentactivity/AgentActivityModel.kt',
        import.meta.url,
      ),
      'utf8',
    );
    const kotlin = model.match(
      /internal val SESSION_REFERENCE = Regex\("([^"]+)"\)/,
    )?.[1];
    expect(kotlin).toBe(NATIVE_PUSH_SESSION_REFERENCE_PATTERN.source);
    expect(NATIVE_PUSH_SESSION_REFERENCE_PATTERN.flags).toBe('');
  });

  test('the content key changes when the first row names a different session with the same text', () => {
    const one = card([snapshot('a', 'running', 0, { title: 'Same' })]);
    const other = card([snapshot('b', 'running', 0, { title: 'Same' })]);
    expect(one.rows).toEqual(other.rows);
    expect(one.contentKey).not.toBe(other.contentKey);
  });
});

describe('agentActivityAlertFields', () => {
  const entries = (phases: AgentActivityPhase[]) =>
    card(phases.map((phase, i) => snapshot(`s${i}`, phase, i * 1000)))
      .alertables;

  test('groups several alerts into one, with an id over the sorted set', () => {
    const grouped = agentActivityAlertFields(
      entries(['waiting_for_approval', 'waiting_for_input']),
    );
    expect(grouped.alert_title).toBe('2 agents need you');
    expect(grouped.alert_body).toBe('Approval: Title s0\nInput: Title s1');
    const reversed = agentActivityAlertFields(
      [...entries(['waiting_for_approval', 'waiting_for_input'])].reverse(),
    );
    expect(reversed.alert_id).toBe(grouped.alert_id);
    expect(grouped.alert_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test('lists at most five and bounds the body under the phone’s 608 characters', () => {
    const many = card(
      Array.from({ length: 8 }, (_, i) =>
        snapshot(`s${i}`, 'waiting_for_approval', i * 1000, {
          title: 'x'.repeat(200),
        }),
      ),
    ).alertables;
    const fields = agentActivityAlertFields(many);
    expect(fields.alert_title).toBe('8 agents need you');
    expect(Array.from(fields.alert_body ?? '').length).toBeLessThanOrEqual(600);
    expect(fields.alert_body?.split('\n').length).toBeLessThanOrEqual(6);
  });

  test('mixed updates and finishes say so', () => {
    expect(
      agentActivityAlertFields(entries(['completed', 'failed'])).alert_title,
    ).toBe('2 agents finished');
    expect(
      agentActivityAlertFields(entries(['completed', 'waiting_for_input']))
        .alert_title,
    ).toBe('2 agent updates');
  });

  test('nothing to alert is no alert fields', () => {
    expect(agentActivityAlertFields([])).toEqual({});
  });
});
