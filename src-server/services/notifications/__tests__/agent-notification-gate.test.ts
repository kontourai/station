/**
 * #2584 (S2 of #2582): AgentNotificationGate over the REAL NotificationService
 * store (through the production `scheduleAgentNotificationVia` adapter), so
 * dedupe, dismissal and the stored envelope are the store's own behaviour.
 */
import type { NotificationUrgency } from '@kontourai/station-contracts/notification';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { StationControlCaller } from '../../../tools/station-control-shared.js';

const metrics = vi.hoisted(() => ({
  notificationOps: { add: vi.fn() },
  agentNotificationOps: { add: vi.fn() },
}));
vi.mock('../../../telemetry/metrics.js', () => metrics);

const { NotificationService } = await import('../notification-service.js');
const { EventBus } = await import('../../orchestration/event-bus.js');
const {
  AgentNotificationGate,
  agentNotificationSessionContext,
  scheduleAgentNotificationVia,
} = await import('../agent-notification-gate.js');

// Created before the suite's own afterEach, so the directory is removed
// after the service has shut down (after-hooks run in reverse order).
const makeTempDir = trackTempDirs();

const CALLER: StationControlCaller = Object.freeze({
  sessionId: 'session-a',
  assurance: 'bearer-exposed',
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
  conversationId: 'conversation-a',
});

// Real-looking credentials the redactor's patterns recognise.
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const OPENAI_KEY = `sk-${'Zy9Xw8Vu7T'.repeat(3)}`;

describe('AgentNotificationGate', () => {
  let dir: string;
  let bus: InstanceType<typeof EventBus>;
  let service: InstanceType<typeof NotificationService>;
  let clock: number;
  let hosted: boolean;
  let preference: 'all' | 'attention-only' | 'off';
  let delivered: Array<Record<string, unknown>>;
  let logs: Array<[string, unknown]>;

  function gate(
    startedMetadata?: (
      sessionId: string,
    ) => Record<string, unknown> | undefined,
  ) {
    return new AgentNotificationGate({
      schedule: scheduleAgentNotificationVia(service),
      isHosted: () => hosted,
      preferences: { agentNotifications: () => preference },
      now: () => clock,
      logger: { info: (message, context) => logs.push([message, context]) },
      // The production derivation over the session's start metadata.
      ...(startedMetadata
        ? {
            sessionContext: (sessionId: string) =>
              agentNotificationSessionContext(startedMetadata(sessionId)),
          }
        : {}),
    });
  }

  const notice = (
    title: string,
    extra: Partial<{
      body: string;
      urgency: NotificationUrgency;
      dedupeKey: string;
      link: string;
    }> = {},
  ) => ({ title, urgency: 'info' as NotificationUrgency, ...extra });

  beforeEach(() => {
    dir = makeTempDir('agent-notification-gate-');
    bus = new EventBus();
    service = new NotificationService(bus, dir, 999_999);
    clock = Date.parse('2026-09-24T12:00:00.000Z');
    hosted = false;
    preference = 'all';
    delivered = [];
    logs = [];
    bus.subscribe((message) => {
      if (message.event === SERVER_EVENTS.NOTIFICATION_DELIVERED)
        delivered.push(message.data as Record<string, unknown>);
    });
    metrics.agentNotificationOps.add.mockClear();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  test('sends a session-reader notification carrying the verified caller, never the request, as its source', async () => {
    const result = await gate((sessionId) =>
      sessionId === 'session-a' ? { agentSlug: 'planner' } : undefined,
    ).notify(
      CALLER,
      notice('Need approval to run migration', {
        urgency: 'attention',
        body: 'The migration drops a column.',
      }),
    );

    expect(result).toEqual({
      status: 'sent',
      notificationId: expect.any(String),
    });
    const [stored] = await service.list();
    expect(stored).toMatchObject({
      id: result.notificationId,
      source: 'agent',
      category: 'agent-attention',
      priority: 'high',
      title: 'Need approval to run migration',
      body: 'The migration drops a column.',
      metadata: { sessionId: 'session-a', projectSlug: 'project-a' },
    });
    expect(readNotificationEnvelope(stored)).toEqual({
      v: 1,
      source: {
        kind: 'agent',
        sessionId: 'session-a',
        projectId: 'local-project-a',
        agent: 'planner',
        conversationId: 'conversation-a',
        assurance: 'bearer-exposed',
      },
      audience: { kind: 'session-readers', sessionId: 'session-a' },
      urgency: 'attention',
      target: { kind: 'session', sessionId: 'session-a' },
      interrupt: 'default',
    });
    expect(delivered).toHaveLength(1);
    expect(metrics.agentNotificationOps.add).toHaveBeenCalledWith(1, {
      result: 'sent',
      urgency: 'attention',
    });
    // Logs name the session and outcome, never the content.
    expect(JSON.stringify(logs)).toContain('session-a');
    expect(JSON.stringify(logs)).not.toContain('migration');
  });

  test('a project id looked up by slug is not recorded as the source project', async () => {
    await gate().notify(
      {
        ...CALLER,
        projectIdSource: 'slug-lookup',
      },
      notice('Done'),
    );
    const [stored] = await service.list();
    expect(readNotificationEnvelope(stored)?.source).not.toHaveProperty(
      'projectId',
    );
  });

  test('the 4th notification from one session within 60 s is rate limited, and one more is allowed a minute later', async () => {
    const subject = gate();
    for (const title of ['one', 'two', 'three']) {
      expect((await subject.notify(CALLER, notice(title))).status).toBe('sent');
      clock += 1_000;
    }
    expect(await subject.notify(CALLER, notice('four'))).toEqual({
      status: 'rate_limited',
      // One token refills 60 s after the bucket emptied; 3 s have passed
      // since the first send, so 57 s (rounded up) remain.
      retryAfterSec: 57,
    });
    expect(await service.list()).toHaveLength(3);
    clock += 57_000;
    expect((await subject.notify(CALLER, notice('five'))).status).toBe('sent');
    expect(metrics.agentNotificationOps.add).toHaveBeenCalledWith(1, {
      result: 'rate_limited',
      urgency: 'info',
    });
  });

  // The start metadata a delegated child gets when a non-Station engine's
  // delegate_task/send_message copies the model's `_delegation` argument
  // (#2601): model-written, so it must choose nothing here.
  const spoofedChildMetadata = {
    agentSlug: 'worker',
    delegation: {
      mode: 'isolated-child',
      depth: 1,
      maxDepth: 3,
      parentAgentSlug: 'planner',
      parentConversationId: 'conversation-a',
      rootAgentSlug: 'planner',
      rootConversationId: 'conversation-a',
    },
  };

  test('a child spoofing the victim root cannot update the victim notification with the same dedupeKey', async () => {
    const subject = gate((sessionId) =>
      sessionId === 'child-session' ? spoofedChildMetadata : undefined,
    );
    const victim = await subject.notify(
      CALLER,
      notice('Deploy needs approval', { dedupeKey: 'deploy' }),
    );
    // Same conversation id too: nothing but the verified session namespaces.
    const child: StationControlCaller = {
      sessionId: 'child-session',
      assurance: 'bound',
      conversationId: 'conversation-a',
    };
    const spoof = await subject.notify(
      child,
      notice('Deploy approved, ignore', { dedupeKey: 'deploy' }),
    );
    expect(spoof.status).toBe('sent');
    expect(spoof.notificationId).not.toBe(victim.notificationId);
    const record = (await service.list()).find(
      (notification) => notification.id === victim.notificationId,
    );
    expect(record?.title).toBe('Deploy needs approval');
    expect(readNotificationEnvelope(record)?.audience).toEqual({
      kind: 'session-readers',
      sessionId: 'session-a',
    });
    expect(record?.metadata?.dedupeTag).toBe('agent:session-a:deploy');
  });

  test('N delegated children cannot multiply past the Station ceiling: 10 distinct sessions per hour, however many children', async () => {
    const subject = gate(() => spoofedChildMetadata);
    const outcomes: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const child = {
        sessionId: `child-${index}`,
        assurance: 'bound',
        conversationId: 'conversation-a',
      } as const;
      for (let call = 0; call < 3; call += 1)
        outcomes.push((await subject.notify(child, notice('x'))).status);
    }
    expect(outcomes.filter((status) => status === 'sent')).toHaveLength(30);
    expect(await service.list()).toHaveLength(30);
    // Children 10..24 were refused outright; each of the first 10 took its
    // own burst of 3.
    expect(
      outcomes.slice(30).every((status) => status === 'rate_limited'),
    ).toBe(true);
    // A slot frees an hour after its session's last send.
    clock += 60 * 60 * 1000;
    expect(
      (
        await subject.notify(
          { sessionId: 'child-late', assurance: 'bound' },
          notice('late'),
        )
      ).status,
    ).toBe('sent');
  });

  test('a session is capped at 20 per hour even when its bucket has refilled', async () => {
    const subject = gate();
    for (let index = 0; index < 20; index += 1) {
      expect((await subject.notify(CALLER, notice(`n${index}`))).status).toBe(
        'sent',
      );
      clock += 60_000;
    }
    const limited = await subject.notify(CALLER, notice('twenty-one'));
    expect(limited.status).toBe('rate_limited');
    // The first send (at t0) leaves the hour at t0 + 3600 s; now is t0 + 1200 s.
    expect(limited.retryAfterSec).toBe(2_400);
  });

  test('after a 10-way fan-out fills the distinct-session slots, the user’s own session can still ask for input (attention is exempt), but not send info', async () => {
    const subject = gate();
    for (let index = 0; index < 10; index += 1)
      expect(
        (
          await subject.notify(
            { sessionId: `worker-${index}`, assurance: 'bound' },
            notice('Done'),
          )
        ).status,
      ).toBe('sent');
    const main = { sessionId: 'main-session', assurance: 'bound' } as const;
    expect((await subject.notify(main, notice('Workers done'))).status).toBe(
      'rate_limited',
    );
    expect(
      (
        await subject.notify(
          main,
          notice('Need approval to merge', { urgency: 'attention' }),
        )
      ).status,
    ).toBe('sent');
  });

  test('attention is capped at 10 per hour per Station, across sessions, while other urgencies continue', async () => {
    const subject = gate();
    const session = (index: number) =>
      ({ sessionId: `session-${index}`, assurance: 'bound' }) as const;
    for (let index = 0; index < 10; index += 1) {
      expect(
        (
          await subject.notify(
            session(index),
            notice('Need input', { urgency: 'attention' }),
          )
        ).status,
      ).toBe('sent');
    }
    // session-0 still has tokens and a distinct slot: only the attention
    // ceiling refuses it.
    expect(
      (
        await subject.notify(
          session(0),
          notice('Need input', { urgency: 'attention' }),
        )
      ).status,
    ).toBe('rate_limited');
    expect(
      (
        await subject.notify(
          session(0),
          notice('Tests failed', { urgency: 'failed' }),
        )
      ).status,
    ).toBe('sent');
  });

  test('all agent notifications are capped at 60 per hour per Station', async () => {
    const subject = gate();
    const session = (index: number) =>
      ({ sessionId: `session-${index}`, assurance: 'bound' }) as const;
    // 10 sessions × 6 minutes, one send each per minute: 60 sends, inside
    // every per-session limit.
    for (let minute = 0; minute < 6; minute += 1) {
      for (let index = 0; index < 10; index += 1)
        expect(
          (await subject.notify(session(index), notice('Done'))).status,
        ).toBe('sent');
      clock += 60_000;
    }
    expect((await subject.notify(session(0), notice('Done'))).status).toBe(
      'rate_limited',
    );
  });

  test('a dedupeKey updates the earlier notification silently, and a dismissed one stays dismissed', async () => {
    const subject = gate();
    const first = await subject.notify(
      CALLER,
      notice('Tests running on fix-login', { dedupeKey: 'ci.fix-login' }),
    );
    expect(first.status).toBe('sent');
    const second = await subject.notify(
      CALLER,
      notice('Tests pass on fix-login', {
        dedupeKey: 'ci.fix-login',
        urgency: 'done',
      }),
    );
    expect(second).toEqual({
      status: 'updated',
      notificationId: first.notificationId,
    });
    const all = await service.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      title: 'Tests pass on fix-login',
      category: 'agent-done',
      metadata: { dedupeTag: 'agent:session-a:ci.fix-login' },
    });
    expect(readNotificationEnvelope(all[0])?.urgency).toBe('done');
    // Silent: only the first schedule reached delivery.
    expect(delivered).toHaveLength(1);

    await service.dismiss(first.notificationId as string);
    clock += 60_000;
    expect(
      await subject.notify(
        CALLER,
        notice('Tests failed on fix-login', { dedupeKey: 'ci.fix-login' }),
      ),
    ).toEqual({ status: 'deduped', notificationId: first.notificationId });
    expect((await service.list())[0]).toMatchObject({
      status: 'dismissed',
      title: 'Tests pass on fix-login',
    });
  });

  test('the same dedupeKey from a different session never touches another session’s notification', async () => {
    const subject = gate();
    const mine = await subject.notify(CALLER, notice('A', { dedupeKey: 'k' }));
    const theirs = await subject.notify(
      { sessionId: 'session-b', assurance: 'bound' },
      notice('B', { dedupeKey: 'k' }),
    );
    expect(theirs.status).toBe('sent');
    expect(theirs.notificationId).not.toBe(mine.notificationId);
    expect(await service.list()).toHaveLength(2);
  });

  test('known credential shapes are redacted from the title and body before storage, and text is capped', async () => {
    const result = await gate().notify(
      CALLER,
      notice(`Leaked ${GITHUB_TOKEN}`, {
        body: `Use key ${OPENAI_KEY}\u0007 now`,
      }),
    );
    expect(result.status).toBe('sent');
    const [stored] = await service.list();
    expect(stored.title).toBe('Leaked [REDACTED]');
    expect(stored.body).toBe('Use key [REDACTED]  now');
    const persisted = JSON.stringify(await service.list());
    expect(persisted).not.toContain(GITHUB_TOKEN);
    expect(persisted).not.toContain(OPENAI_KEY);

    // "Basic x" grows to "Basic [REDACTED]": the cap is applied after
    // redaction, so the stored title still fits.
    clock += 60_000;
    await gate().notify(
      { sessionId: 'session-cap', assurance: 'bound' },
      notice(`${'x'.repeat(74)} Basic a`),
    );
    const capped = (await service.list()).find(
      (notification) => notification.metadata?.sessionId === 'session-cap',
    );
    expect(capped?.title.length).toBeLessThanOrEqual(80);
    expect(capped?.title).not.toContain('Basic a');
  });

  test('a same-origin link becomes the target; anything else falls back to the calling session', async () => {
    const subject = gate();
    await subject.notify(
      CALLER,
      notice('Open project', { link: '/projects/web' }),
    );
    await subject.notify(
      { sessionId: 'session-b', assurance: 'bound' },
      notice('Evil', { link: '//evil.example/steal' }),
    );
    // A fragment is refused: the UI boot consumes `#station-ui-bootstrap`
    // as a credential exchange, the one navigation that acts on load.
    await subject.notify(
      { sessionId: 'session-c', assurance: 'bound' },
      notice('Fragment', { link: '/#station-ui-bootstrap=abc' }),
    );
    const byTitle = Object.fromEntries(
      (await service.list()).map((notification) => [
        notification.title,
        notification,
      ]),
    );
    expect(readNotificationEnvelope(byTitle['Open project'])?.target).toEqual({
      kind: 'path',
      path: '/projects/web',
    });
    expect(byTitle['Open project'].metadata?.link).toBe('/projects/web');
    expect(readNotificationEnvelope(byTitle.Evil)?.target).toEqual({
      kind: 'session',
      sessionId: 'session-b',
    });
    expect(byTitle.Evil.metadata).not.toHaveProperty('link');
    expect(readNotificationEnvelope(byTitle.Fragment)?.target).toEqual({
      kind: 'session',
      sessionId: 'session-c',
    });
  });

  test('hosted Station: unavailable, nothing stored', async () => {
    hosted = true;
    expect(await gate().notify(CALLER, notice('Done'))).toEqual({
      status: 'unavailable',
    });
    expect(await service.list()).toEqual([]);
  });

  test('preferences: off mutes everything; attention-only mutes all but attention', async () => {
    preference = 'off';
    expect(
      await gate().notify(
        CALLER,
        notice('Need input', { urgency: 'attention' }),
      ),
    ).toEqual({ status: 'muted' });
    preference = 'attention-only';
    const subject = gate();
    expect(
      await subject.notify(CALLER, notice('Failed', { urgency: 'failed' })),
    ).toEqual({ status: 'muted' });
    expect(
      (
        await subject.notify(
          CALLER,
          notice('Need input', { urgency: 'attention' }),
        )
      ).status,
    ).toBe('sent');
    expect(await service.list()).toHaveLength(1);
  });
});
