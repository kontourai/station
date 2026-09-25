import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import {
  AGENT_NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEDUPE_KEY_MAX,
  NOTIFICATION_LINK_MAX,
} from '@kontourai/station-contracts/notification';
import { describe, expect, test } from 'vitest';
import {
  agentNotificationCategory,
  agentNotificationDedupeTag,
  notificationPriorityForUrgency,
  parseNotificationEnvelope,
  readNotificationEnvelope,
} from '../notification-envelope.js';
import { classifyNotificationCategory } from '../notification-priority.js';

const READ_AT = '2026-09-24T12:00:00.000Z';

function fullEnvelope(): NotificationEnvelopeV1 {
  return {
    v: 1,
    source: {
      kind: 'agent',
      sessionId: 'session-1',
      projectId: 'project-1',
      agent: 'claude',
      conversationId: 'conversation-1',
      assurance: 'bound',
    },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency: 'attention',
    target: { kind: 'path', path: '/sessions/session-1' },
    interrupt: 'default',
    readAt: READ_AT,
    readBy: 'device:abc',
    dismissedAt: READ_AT,
    dismissedBy: 'local:tab-1',
  };
}

/** Deep-clone, then apply a mutation to a JSON-shaped copy. */
function mutated(
  mutate: (envelope: Record<string, any>) => void,
): Record<string, unknown> {
  const copy = structuredClone(fullEnvelope()) as Record<string, any>;
  mutate(copy);
  return copy;
}

describe('readNotificationEnvelope', () => {
  test('reads a fully populated envelope from metadata.envelope', () => {
    expect(
      readNotificationEnvelope({ metadata: { envelope: fullEnvelope() } }),
    ).toEqual(fullEnvelope());
  });

  test.each([
    ['system', { kind: 'system', subsystem: 'scheduler' }],
    ['provider', { kind: 'provider', providerId: 'github' }],
    [
      'agent (required fields only)',
      { kind: 'agent', sessionId: 's', assurance: 'bearer-exposed' },
    ],
  ])('accepts a %s source', (_label, source) => {
    const envelope = {
      v: 1,
      source,
      audience: { kind: 'owner' },
      urgency: 'info',
      interrupt: 'silent',
    };
    expect(parseNotificationEnvelope(envelope)).toEqual(envelope);
  });

  test.each([
    ['owner', { kind: 'owner' }],
    ['session-readers', { kind: 'session-readers', sessionId: 's' }],
    ['principal', { kind: 'principal', principalId: 'p' }],
  ])('accepts an %s audience', (_label, audience) => {
    const envelope = {
      v: 1,
      source: { kind: 'system', subsystem: 'x' },
      audience,
      urgency: 'done',
      target: { kind: 'session', sessionId: 's' },
      interrupt: 'default',
    };
    expect(parseNotificationEnvelope(envelope)).toEqual(envelope);
  });

  test('every urgency is accepted', () => {
    for (const urgency of ['info', 'attention', 'done', 'failed']) {
      expect(
        parseNotificationEnvelope(
          mutated((e) => {
            e.urgency = urgency;
          }),
        )?.urgency,
      ).toBe(urgency);
    }
  });

  test('absent metadata, absent envelope, and non-record metadata are legacy', () => {
    expect(readNotificationEnvelope({})).toBeUndefined();
    expect(readNotificationEnvelope({ metadata: {} })).toBeUndefined();
    expect(
      readNotificationEnvelope({ metadata: { envelope: null } }),
    ).toBeUndefined();
    expect(readNotificationEnvelope(undefined)).toBeUndefined();
    expect(
      readNotificationEnvelope({
        metadata: [] as unknown as Record<string, unknown>,
      }),
    ).toBeUndefined();
  });

  test('returns a fresh object, never the stored one', () => {
    const stored = fullEnvelope();
    const read = readNotificationEnvelope({ metadata: { envelope: stored } });
    expect(read).toEqual(stored);
    expect(read).not.toBe(stored);
    expect(read?.source).not.toBe(stored.source);
  });

  test('an optional key holding undefined is absent, and is omitted from the result', () => {
    const parsed = parseNotificationEnvelope({
      v: 1,
      source: {
        kind: 'agent',
        sessionId: 's',
        agent: undefined,
        assurance: 'bound',
      },
      audience: { kind: 'owner' },
      urgency: 'info',
      target: undefined,
      interrupt: 'default',
      readAt: undefined,
      readBy: undefined,
    });
    expect(parsed).toEqual({
      v: 1,
      source: { kind: 'agent', sessionId: 's', assurance: 'bound' },
      audience: { kind: 'owner' },
      urgency: 'info',
      interrupt: 'default',
    });
    expect(Object.hasOwn(parsed!, 'target')).toBe(false);
    expect(Object.hasOwn(parsed!.source, 'agent')).toBe(false);
  });

  // Each row breaks exactly one field of an otherwise valid envelope.
  test.each<[string, (e: Record<string, any>) => void]>([
    [
      'unknown top-level key',
      (e) => {
        e.extra = true;
      },
    ],
    [
      'missing v',
      (e) => {
        delete e.v;
      },
    ],
    [
      'v = 2',
      (e) => {
        e.v = 2;
      },
    ],
    [
      'v as string',
      (e) => {
        e.v = '1';
      },
    ],
    [
      'missing source',
      (e) => {
        delete e.source;
      },
    ],
    [
      'source not an object',
      (e) => {
        e.source = 'agent';
      },
    ],
    [
      'unknown source kind',
      (e) => {
        e.source = { kind: 'user', id: 'x' };
      },
    ],
    [
      'agent source missing sessionId',
      (e) => {
        delete e.source.sessionId;
      },
    ],
    [
      'agent source empty sessionId',
      (e) => {
        e.source.sessionId = '';
      },
    ],
    [
      'agent source padded sessionId',
      (e) => {
        e.source.sessionId = ' s ';
      },
    ],
    [
      'agent source missing assurance',
      (e) => {
        delete e.source.assurance;
      },
    ],
    [
      'agent source unknown assurance',
      (e) => {
        e.source.assurance = 'trusted';
      },
    ],
    [
      'agent source non-string projectId',
      (e) => {
        e.source.projectId = 7;
      },
    ],
    [
      'agent source empty agent',
      (e) => {
        e.source.agent = '';
      },
    ],
    [
      'agent source non-string conversationId',
      (e) => {
        e.source.conversationId = null;
      },
    ],
    [
      'agent source unknown key',
      (e) => {
        e.source.principal = 'p';
      },
    ],
    [
      'system source missing subsystem',
      (e) => {
        e.source = { kind: 'system' };
      },
    ],
    [
      'system source unknown key',
      (e) => {
        e.source = { kind: 'system', subsystem: 'x', sessionId: 's' };
      },
    ],
    [
      'provider source empty providerId',
      (e) => {
        e.source = { kind: 'provider', providerId: '' };
      },
    ],
    [
      'missing audience',
      (e) => {
        delete e.audience;
      },
    ],
    [
      'unknown audience kind',
      (e) => {
        e.audience = { kind: 'everyone' };
      },
    ],
    [
      'owner audience with extra key',
      (e) => {
        e.audience = { kind: 'owner', sessionId: 's' };
      },
    ],
    [
      'session-readers audience missing sessionId',
      (e) => {
        e.audience = { kind: 'session-readers' };
      },
    ],
    [
      'principal audience non-string id',
      (e) => {
        e.audience = { kind: 'principal', principalId: 1 };
      },
    ],
    [
      'missing urgency',
      (e) => {
        delete e.urgency;
      },
    ],
    [
      'unknown urgency',
      (e) => {
        e.urgency = 'urgent';
      },
    ],
    [
      'urgency wrong case',
      (e) => {
        e.urgency = 'Info';
      },
    ],
    [
      'missing interrupt',
      (e) => {
        delete e.interrupt;
      },
    ],
    [
      'unknown interrupt',
      (e) => {
        e.interrupt = 'loud';
      },
    ],
    [
      'target not an object',
      (e) => {
        e.target = '/sessions/s';
      },
    ],
    [
      'target null',
      (e) => {
        e.target = null;
      },
    ],
    [
      'unknown target kind',
      (e) => {
        e.target = { kind: 'url', url: 'https://x' };
      },
    ],
    [
      'session target missing sessionId',
      (e) => {
        e.target = { kind: 'session' };
      },
    ],
    [
      'path target absolute URL',
      (e) => {
        e.target.path = 'https://evil.example/';
      },
    ],
    [
      'path target protocol-relative',
      (e) => {
        e.target.path = '//evil.example/';
      },
    ],
    [
      'path target backslash',
      (e) => {
        e.target.path = '/\\evil.example/';
      },
    ],
    [
      'path target with whitespace',
      (e) => {
        e.target.path = '/sessions/ s';
      },
    ],
    [
      'path target with control char',
      (e) => {
        e.target.path = '/sessions/\u0000';
      },
    ],
    [
      'path target too long',
      (e) => {
        e.target.path = `/${'a'.repeat(NOTIFICATION_LINK_MAX)}`;
      },
    ],
    [
      'path target unknown key',
      (e) => {
        e.target.sessionId = 's';
      },
    ],
    [
      'readAt not canonical ISO',
      (e) => {
        e.readAt = '2026-09-24';
      },
    ],
    [
      'readAt without readBy',
      (e) => {
        delete e.readBy;
      },
    ],
    [
      'readBy without readAt',
      (e) => {
        delete e.readAt;
      },
    ],
    [
      'readBy empty',
      (e) => {
        e.readBy = '';
      },
    ],
    [
      'dismissedAt not a string',
      (e) => {
        e.dismissedAt = Date.now();
      },
    ],
    [
      'dismissedBy without dismissedAt',
      (e) => {
        delete e.dismissedAt;
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const envelope = mutated(mutate);
    expect(parseNotificationEnvelope(envelope)).toBeUndefined();
    expect(
      readNotificationEnvelope({ metadata: { envelope } }),
    ).toBeUndefined();
  });

  test('rejects non-object and non-plain envelopes', () => {
    for (const value of [1, 'x', true, [], new Date(), new Map()]) {
      expect(parseNotificationEnvelope(value)).toBeUndefined();
    }
  });

  test('never throws, even when reading a field throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => parseNotificationEnvelope(hostile)).not.toThrow();
    expect(parseNotificationEnvelope(hostile)).toBeUndefined();
    const metadata = {
      get envelope() {
        throw new Error('boom');
      },
    };
    expect(readNotificationEnvelope({ metadata })).toBeUndefined();
  });
});

describe('agent notification helpers', () => {
  test('dedupe tags are namespaced by root session', () => {
    expect(agentNotificationDedupeTag('root-a', 'build.status')).toBe(
      'agent:root-a:build.status',
    );
    expect(agentNotificationDedupeTag('root-a', 'k')).not.toBe(
      agentNotificationDedupeTag('root-b', 'k'),
    );
  });

  test.each([
    ['empty key', 'root', ''],
    ['key with space', 'root', 'a b'],
    ['key with slash', 'root', 'a/b'],
    ['key over the limit', 'root', 'a'.repeat(NOTIFICATION_DEDUPE_KEY_MAX + 1)],
    ['empty root', '', 'k'],
    // A colon in the root would let `a` + `b:k` alias `a:b` + `k`.
    ['root containing the separator', 'a:b', 'k'],
  ])('dedupe tag refuses %s', (_label, root, key) => {
    expect(() => agentNotificationDedupeTag(root, key)).toThrow(RangeError);
  });

  test('a key at the limit is accepted', () => {
    const key = 'a'.repeat(NOTIFICATION_DEDUPE_KEY_MAX);
    expect(agentNotificationDedupeTag('root', key)).toBe(`agent:root:${key}`);
  });

  test('each urgency maps to its agent category and that category is ranked', () => {
    expect(agentNotificationCategory('info')).toBe('agent-info');
    expect(agentNotificationCategory('attention')).toBe('agent-attention');
    expect(agentNotificationCategory('done')).toBe('agent-done');
    expect(agentNotificationCategory('failed')).toBe('agent-failed');
    for (const category of Object.values(AGENT_NOTIFICATION_CATEGORIES)) {
      expect(classifyNotificationCategory(category)).toBeDefined();
    }
  });

  test('priority is high for attention/failed and normal otherwise', () => {
    expect(notificationPriorityForUrgency('attention')).toBe('high');
    expect(notificationPriorityForUrgency('failed')).toBe('high');
    expect(notificationPriorityForUrgency('done')).toBe('normal');
    expect(notificationPriorityForUrgency('info')).toBe('normal');
  });
});
