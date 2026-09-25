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
  isSurfaceId,
  notificationPriorityForUrgency,
  parseNotificationEnvelope,
  parseNotificationEnvelopeForWrite,
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
      'system source missing subsystem',
      (e) => {
        e.source = { kind: 'system' };
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
      'readBy not a surface id',
      (e) => {
        e.readBy = 'phone';
      },
    ],
    [
      'source kind not a string',
      (e) => {
        e.source = { kind: 7, sessionId: 's' };
      },
    ],
    [
      'known source kind with an invalid known field',
      (e) => {
        e.source = { kind: 'system', subsystem: 5, extra: 'ignored' };
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

  describe('forward compatibility (a newer v1 writer)', () => {
    test('unknown keys are ignored at the top level and inside known kinds', () => {
      const envelope = mutated((e) => {
        e.priorityHint = 'x';
        e.source.model = 'opus';
        e.audience.note = 'n';
        e.target.fragment = 'f';
      });
      expect(parseNotificationEnvelope(envelope)).toEqual(fullEnvelope());
    });

    test('an unknown source kind reads as unknown and forces in-app only', () => {
      const envelope = mutated((e) => {
        e.source = { kind: 'workflow', runId: 'r' };
      });
      expect(parseNotificationEnvelope(envelope)).toMatchObject({
        source: { kind: 'unknown', observedKind: 'workflow' },
        interrupt: 'silent',
        urgency: 'attention',
      });
    });

    test('an unknown audience kind reads as owner and forces in-app only', () => {
      const envelope = mutated((e) => {
        e.audience = { kind: 'team', teamId: 't' };
      });
      expect(parseNotificationEnvelope(envelope)).toMatchObject({
        audience: { kind: 'owner' },
        interrupt: 'silent',
      });
    });

    test('an unknown target kind is dropped (no target)', () => {
      const parsed = parseNotificationEnvelope(
        mutated((e) => {
          e.target = { kind: 'artifact', artifactId: 'a' };
        }),
      );
      expect(parsed).toBeDefined();
      expect(Object.hasOwn(parsed!, 'target')).toBe(false);
      expect(parsed?.interrupt).toBe('default');
    });

    test('an unknown v reads as legacy', () => {
      expect(
        parseNotificationEnvelope(
          mutated((e) => {
            e.v = 2;
          }),
        ),
      ).toBeUndefined();
    });
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

describe('parseNotificationEnvelopeForWrite', () => {
  /** A producer's envelope: no read/dismiss markers. */
  function producerEnvelope(): Record<string, any> {
    const {
      readAt: _ra,
      readBy: _rb,
      dismissedAt: _da,
      dismissedBy: _db,
      ...rest
    } = fullEnvelope();
    return structuredClone(rest);
  }

  test('accepts a well-formed producer envelope', () => {
    expect(parseNotificationEnvelopeForWrite(producerEnvelope())).toEqual(
      producerEnvelope(),
    );
  });

  test.each<[string, (e: Record<string, any>) => void]>([
    ['an unknown top-level key', (e) => Object.assign(e, { extra: 1 })],
    ['an unknown source key', (e) => Object.assign(e.source, { model: 'x' })],
    ['an unknown audience key', (e) => Object.assign(e.audience, { n: 1 })],
    ['an unknown target key', (e) => Object.assign(e.target, { f: 'x' })],
    [
      'an unknown source kind',
      (e) => Object.assign(e, { source: { kind: 'workflow' } }),
    ],
    [
      'the read-side unknown source',
      (e) =>
        Object.assign(e, { source: { kind: 'unknown', observedKind: 'x' } }),
    ],
    [
      'an unknown audience kind',
      (e) => Object.assign(e, { audience: { kind: 'team' } }),
    ],
    [
      'a principal audience (no resolver yet)',
      (e) =>
        Object.assign(e, { audience: { kind: 'principal', principalId: 'p' } }),
    ],
    [
      'an unknown target kind',
      (e) => Object.assign(e, { target: { kind: 'artifact' } }),
    ],
    [
      'a pre-set read marker',
      (e) => Object.assign(e, { readAt: READ_AT, readBy: 'device:a' }),
    ],
    [
      'a pre-set dismiss marker',
      (e) =>
        Object.assign(e, { dismissedAt: READ_AT, dismissedBy: 'device:a' }),
    ],
  ])('refuses %s', (_label, mutate) => {
    const envelope = producerEnvelope();
    mutate(envelope);
    expect(parseNotificationEnvelopeForWrite(envelope)).toBeUndefined();
  });

  test('surface ids are device: or local: prefixed', () => {
    expect(isSurfaceId('device:abc')).toBe(true);
    expect(isSurfaceId('local:tab-1')).toBe(true);
    for (const value of [
      'abc',
      'device:',
      'user:x',
      ' device:a',
      'device:a b',
      7,
    ]) {
      expect(isSurfaceId(value)).toBe(false);
    }
  });
});

describe('agent notification helpers', () => {
  test('dedupe tags are namespaced by session', () => {
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
