import {
  type ChatAppCapabilityChip,
  type ChatChannelBinding,
  type ChatDeliveryLogEntry,
  type ChatIdentityLink,
  type ChatLinkCode,
  legacyDiscordBindingId,
  parseChatAppCapabilityChip,
  parseChatAppId,
  parseChatAppKillSwitch,
  parseChatChannelBinding,
  parseChatDeliveryLogEntry,
  parseChatIdentityLink,
  parseChatLinkCode,
  parseChatLinkConfirmRequest,
} from '@kontourai/station-contracts/chat-app';
import { parseIntegrationActionStatus } from '@kontourai/station-contracts/integration-status';
import { describe, expect, test } from 'vitest';

const time = '2026-10-26T12:00:00.000Z';
const later = '2026-10-26T12:01:00.000Z';
const snowflake = '123456789'.repeat(2);
const link: ChatIdentityLink = {
  app: 'discord',
  externalUserId: snowflake,
  principalId: 'person-1',
  linkedAt: time,
};
const binding: ChatChannelBinding = {
  id: 'binding-1',
  app: 'slack',
  externalWorkspaceId: 'TABC123',
  externalChannelId: 'CABC123',
  target: { kind: 'project', projectId: 'project-1' },
  boundByPrincipalId: 'operator',
  boundAt: time,
};
const delivery: ChatDeliveryLogEntry = {
  id: 'delivery-1',
  app: 'discord',
  externalWorkspaceId: snowflake,
  externalChannelId: snowflake,
  direction: 'inbound',
  action: 'start',
  outcome: { state: 'refused', reason: 'unlinked-sender' },
  createdAt: time,
};
const linkCode: ChatLinkCode = {
  app: 'slack',
  challengeId: 'challenge-1',
  codeHash: 'a'.repeat(64),
  externalUserId: 'UABC123',
  failedAttempts: 0,
  issuedAt: time,
  expiresAt: later,
};
const confirm = {
  app: 'slack',
  challengeId: 'challenge-1',
  code: 'ABCD234567',
};
const killSwitch = {
  app: 'slack',
  disabled: true,
  updatedAt: time,
  updatedByPrincipalId: 'operator',
};
const chip: ChatAppCapabilityChip = {
  action: 'notify',
  computedBy: 'discord.gateway',
  state: 'works',
  reason: 'Gateway connected',
};

describe('chat app boundary contracts', () => {
  test('admits only Discord and Slack app ids', () => {
    expect(parseChatAppId('discord')).toBe('discord');
    expect(parseChatAppId('slack')).toBe('slack');
    expect(parseChatAppId('teams')).toBeNull();
    expect(parseChatAppId(null)).toBeNull();
  });

  test.each(['notify', 'start', 'continue', 'approve'])(
    'shares the %s chip shape and reason with integration status',
    (action) => {
      const value = { ...chip, action };
      expect(parseChatAppCapabilityChip(value)).toEqual(value);
      expect(parseIntegrationActionStatus(value)).toEqual(value);
      expect(
        parseChatAppCapabilityChip({
          action,
          state: 'works',
          reason: 'Connected',
        }),
      ).toBeNull();
      expect(
        parseChatAppCapabilityChip({ ...value, computedBy: '' }),
      ).toBeNull();
      expect(parseChatAppCapabilityChip({ ...value, reason: '' })).toBeNull();
    },
  );

  test('refuses non-chat actions and unsupported chip states', () => {
    expect(parseChatAppCapabilityChip({ ...chip, action: 'read' })).toBeNull();
    expect(parseChatAppCapabilityChip({ ...chip, state: true })).toBeNull();
    expect(
      parseChatAppCapabilityChip({ ...chip, probe: 'old-vocabulary' }),
    ).toBeNull();
  });

  const parsers = [
    ['chip', parseChatAppCapabilityChip, chip],
    ['identity', parseChatIdentityLink, link],
    ['binding', parseChatChannelBinding, binding],
    ['delivery', parseChatDeliveryLogEntry, delivery],
    ['kill switch', parseChatAppKillSwitch, killSwitch],
    ['link code', parseChatLinkCode, linkCode],
    ['confirm', parseChatLinkConfirmRequest, confirm],
  ] as const;
  test.each(parsers)(
    '%s parses its public shape and refuses extra keys and non-records',
    (_name, parse, valid) => {
      expect(parse(valid)).toEqual(valid);
      for (const invalid of [
        null,
        [],
        'value',
        1,
        { ...valid, unexpected: true },
        { ...valid, [Symbol('extra')]: true },
        JSON.parse(JSON.stringify(valid).replace(/}$/, ',"__proto__":{}}')),
      ])
        expect(parse(invalid)).toBeNull();
    },
  );

  test('retains revocation and refuses reversed or invalid timestamps for new links', () => {
    expect(parseChatIdentityLink({ ...link, revokedAt: later })).toEqual({
      ...link,
      revokedAt: later,
    });
    expect(
      parseChatIdentityLink({ ...link, linkedAt: later, revokedAt: time }),
    ).toBeNull();
    expect(
      parseChatIdentityLink({ ...link, linkedAt: '2026-02-30T12:00:00.000Z' }),
    ).toBeNull();
    expect(
      parseChatIdentityLink({ ...link, revokedAt: 'tomorrow' }),
    ).toBeNull();
    expect(
      parseChatIdentityLink({
        app: 'discord',
        externalUserId: snowflake,
        principalId: 'person-1',
      }),
    ).toBeNull();
  });

  test('binds only a Project or a conversation with a closed target', () => {
    const target = { kind: 'conversation', conversationId: 'conversation-1' };
    expect(parseChatChannelBinding({ ...binding, target })).toEqual({
      ...binding,
      target,
    });
    for (const invalid of [
      { kind: 'task', projectId: 'p' },
      { kind: 'conversation', projectId: 'p' },
      { kind: 'project', projectId: 'p', conversationId: 'c' },
      { ...target, extra: true },
    ])
      expect(
        parseChatChannelBinding({ ...binding, target: invalid }),
      ).toBeNull();
  });

  test('imported binding ids are deterministic and cannot acquire fabricated operator metadata', () => {
    const imported = {
      id: `legacy-discord:${snowflake}:${snowflake}`,
      app: 'discord',
      externalWorkspaceId: snowflake,
      externalChannelId: snowflake,
      target: { kind: 'conversation', conversationId: 'session-1' },
      provenance: { source: 'legacy-import' },
    };
    expect(legacyDiscordBindingId(snowflake, snowflake)).toBe(imported.id);
    expect(parseChatChannelBinding(imported)).toEqual(imported);
    for (const change of [
      { id: 'arbitrary' },
      { boundAt: time },
      { boundByPrincipalId: 'operator' },
      { externalThreadId: snowflake },
      { target: { kind: 'project', projectId: 'p' } },
      { provenance: { source: 'legacy-import', extra: true } },
    ])
      expect(parseChatChannelBinding({ ...imported, ...change })).toBeNull();
  });

  test.each([
    'unlinked-sender',
    'link-revoked',
    'execute-required',
    'approve-required',
    'app-disabled',
    'approval-expired',
  ])('retains the %s delivery refusal', (reason) => {
    const value = { ...delivery, outcome: { state: 'refused', reason } };
    expect(parseChatDeliveryLogEntry(value)).toEqual(value);
  });

  test('retains pending, delivered and failed attempts and their retry linkage', () => {
    for (const outcome of [
      { state: 'pending' },
      { state: 'delivered', externalMessageId: snowflake },
      { state: 'failed', reason: 'provider disconnected' },
    ]) {
      const value = {
        ...delivery,
        outcome,
        retryOf: 'delivery-0',
        taskId: 'task-1',
        principalId: 'person-1',
      };
      expect(parseChatDeliveryLogEntry(value)).toEqual(value);
    }
    expect(
      parseChatDeliveryLogEntry({ ...delivery, retryOf: delivery.id }),
    ).toBeNull();
    for (const outcome of [
      { state: 'refused', reason: 'unknown' },
      { state: 'pending', reason: 'hidden' },
      { state: 'delivered' },
      { state: 'failed', reason: '' },
      { ...delivery.outcome, extra: true },
    ])
      expect(parseChatDeliveryLogEntry({ ...delivery, outcome })).toBeNull();
  });

  test.each([
    { state: 'refused', reason: 'unlinked-sender' },
    { state: 'failed', reason: 'disconnected' },
  ])(
    'refuses cross-variant extra keys on $state delivery outcomes',
    (outcome) => {
      expect(
        parseChatDeliveryLogEntry({ ...delivery, outcome }),
      ).not.toBeNull();
      // A valid message id reaches the cross-variant key guard, not an ID-format guard.
      expect(
        parseChatDeliveryLogEntry({
          ...delivery,
          outcome: { ...outcome, externalMessageId: snowflake },
        }),
      ).toBeNull();
    },
  );

  test('unlinked-sender cannot claim an attributed principal', () => {
    expect(parseChatDeliveryLogEntry(delivery)).toEqual(delivery);
    expect(
      parseChatDeliveryLogEntry({ ...delivery, principalId: 'person-1' }),
    ).toBeNull();
    const revoked = {
      ...delivery,
      outcome: { state: 'refused', reason: 'link-revoked' },
      principalId: 'person-1',
    };
    expect(parseChatDeliveryLogEntry(revoked)).toEqual(revoked);
  });

  test('correlates approval deliveries, including refusals, with the session and request', () => {
    const value = {
      ...delivery,
      action: 'approve',
      approval: { sessionId: 'session-1', requestId: 'request-1' },
    };
    expect(parseChatDeliveryLogEntry(value)).toEqual(value);
    for (const approval of [
      { sessionId: 's' },
      { requestId: 'r' },
      { sessionId: '', requestId: 'r' },
      { sessionId: 's', requestId: 'r', extra: true },
      { sessionId: 's', requestId: 'r', [Symbol('extra')]: true },
    ])
      expect(parseChatDeliveryLogEntry({ ...value, approval })).toBeNull();
  });

  const boundedFields = [
    [parseChatIdentityLink, link, 'principalId', 256],
    [parseChatLinkConfirmRequest, confirm, 'code', 128],
    [parseChatAppCapabilityChip, chip, 'computedBy', 256],
    [parseChatAppCapabilityChip, chip, 'reason', 1000],
    [parseChatChannelBinding, binding, 'id', 256],
    [parseChatChannelBinding, binding, 'boundByPrincipalId', 256],
    [parseChatDeliveryLogEntry, delivery, 'id', 256],
    ...(['projectId', 'conversationId', 'taskId', 'retryOf'] as const).map(
      (key) => [parseChatDeliveryLogEntry, delivery, key, 256] as const,
    ),
    [parseChatAppKillSwitch, killSwitch, 'updatedByPrincipalId', 256],
    [parseChatAppKillSwitch, killSwitch, 'reason', 1000],
  ] as const;
  test.each(boundedFields)(
    'refuses max+1 for %s / %s / %s',
    (parse, valid, key, max) => {
      const atMax = { ...valid, [key]: 'A'.repeat(max) };
      expect(parse(atMax)).toEqual(atMax);
      expect(parse({ ...valid, [key]: 'A'.repeat(max + 1) })).toBeNull();
      expect(parse({ ...valid, [key]: '' })).toBeNull();
    },
  );

  test('bounds nested target ids, approval ids and failure diagnostics', () => {
    for (const [kind, key] of [
      ['project', 'projectId'],
      ['conversation', 'conversationId'],
    ]) {
      const target = { kind, [key]: 'x'.repeat(256) };
      expect(parseChatChannelBinding({ ...binding, target })).toEqual({
        ...binding,
        target,
      });
      expect(
        parseChatChannelBinding({
          ...binding,
          target: { ...target, [key]: 'x'.repeat(257) },
        }),
      ).toBeNull();
    }
    const value = {
      ...delivery,
      outcome: { state: 'failed', reason: 'x'.repeat(1000) },
    };
    expect(parseChatDeliveryLogEntry(value)).toEqual(value);
    expect(
      parseChatDeliveryLogEntry({
        ...value,
        outcome: { state: 'failed', reason: 'x'.repeat(1001) },
      }),
    ).toBeNull();
    for (const key of ['sessionId', 'requestId']) {
      const approval = {
        sessionId: 's',
        requestId: 'r',
        [key]: 'x'.repeat(256),
      };
      expect(parseChatDeliveryLogEntry({ ...delivery, approval })).toEqual({
        ...delivery,
        approval,
      });
      expect(
        parseChatDeliveryLogEntry({
          ...delivery,
          approval: { ...approval, [key]: 'x'.repeat(257) },
        }),
      ).toBeNull();
    }
  });

  test.each([
    ' person',
    'person ',
    'person\n',
    '\ud800',
    'a\u0000b',
    'a\u007fb',
    'a\u0085b',
    'a\u009fb',
    'a\u202eb',
    'a\u202ab',
    'a\u2066b',
    'a\u200bb',
    'a\u200db',
    'a\ufeffb',
    123,
  ])(
    'refuses whitespace, DEL, C1, invisible controls and malformed Unicode: %j',
    (principalId) => {
      expect(parseChatIdentityLink({ ...link, principalId })).toBeNull();
      expect(
        parseChatAppCapabilityChip({ ...chip, computedBy: principalId }),
      ).toBeNull();
    },
  );

  test('refuses coerced kill switches', () => {
    expect(
      parseChatAppKillSwitch({ ...killSwitch, disabled: 'true' }),
    ).toBeNull();
  });

  test('checks Discord snowflakes across every external identifier field', () => {
    for (const externalUserId of ['1'.repeat(17), '1'.repeat(20)])
      expect(parseChatIdentityLink({ ...link, externalUserId })).not.toBeNull();
    for (const invalid of [
      '1'.repeat(16),
      '1'.repeat(21),
      'not a snowflake',
      '１２３４５６７８９０１２３４５６７８',
      ` ${snowflake}`,
      `${snowflake} `,
      `${snowflake}\u007f`,
      `1\u202e${snowflake}`,
    ]) {
      expect(
        parseChatIdentityLink({ ...link, externalUserId: invalid }),
      ).toBeNull();
      for (const key of [
        'externalWorkspaceId',
        'externalChannelId',
        'externalThreadId',
        'externalUserId',
      ])
        expect(
          parseChatDeliveryLogEntry({ ...delivery, [key]: invalid }),
        ).toBeNull();
      expect(
        parseChatDeliveryLogEntry({
          ...delivery,
          outcome: { state: 'delivered', externalMessageId: invalid },
        }),
      ).toBeNull();
      for (const key of [
        'externalWorkspaceId',
        'externalChannelId',
        'externalThreadId',
      ])
        expect(
          parseChatChannelBinding({
            ...binding,
            app: 'discord',
            externalWorkspaceId: snowflake,
            externalChannelId: snowflake,
            [key]: invalid,
          }),
        ).toBeNull();
    }
    const value = {
      ...delivery,
      externalThreadId: snowflake,
      externalUserId: snowflake,
    };
    expect(parseChatDeliveryLogEntry(value)).toEqual(value);
  });

  test('checks Slack user/team/channel prefixes and uppercase base36 suffixes', () => {
    for (const externalUserId of ['UABC123', 'WABC123']) {
      const value = {
        app: 'slack',
        externalUserId,
        principalId: 'person',
        linkedAt: time,
      };
      expect(parseChatIdentityLink(value)).toEqual(value);
      expect(parseChatLinkCode({ ...linkCode, externalUserId })).not.toBeNull();
    }
    for (const externalChannelId of ['CABC123', 'GABC123', 'DABC123'])
      expect(
        parseChatChannelBinding({ ...binding, externalChannelId }),
      ).not.toBeNull();
    for (const externalUserId of [
      'TABC123',
      'CABC123',
      'uABC123',
      'Uabc123',
      'U',
      'UABC-123',
    ]) {
      expect(
        parseChatIdentityLink({ ...link, app: 'slack', externalUserId }),
      ).toBeNull();
      expect(parseChatLinkCode({ ...linkCode, externalUserId })).toBeNull();
    }
    for (const externalWorkspaceId of ['UABC123', 'T', 'Tabc123'])
      expect(
        parseChatChannelBinding({ ...binding, externalWorkspaceId }),
      ).toBeNull();
    for (const externalChannelId of ['UABC123', 'C', 'Cabc123'])
      expect(
        parseChatChannelBinding({ ...binding, externalChannelId }),
      ).toBeNull();
    const slackDelivery = {
      ...delivery,
      app: 'slack',
      externalWorkspaceId: 'TABC123',
      externalChannelId: 'CABC123',
      externalUserId: 'WABC123',
      externalThreadId: '1234567890.123456',
      outcome: { state: 'delivered', externalMessageId: '1234567890.654321' },
    };
    expect(parseChatDeliveryLogEntry(slackDelivery)).toEqual(slackDelivery);
    for (const [key, invalid] of [
      ['externalWorkspaceId', 'CABC123'],
      ['externalChannelId', 'UABC123'],
      ['externalUserId', 'TABC123'],
      ['externalThreadId', 'not-a-timestamp'],
    ])
      expect(
        parseChatDeliveryLogEntry({ ...slackDelivery, [key]: invalid }),
      ).toBeNull();
    for (const externalThreadId of [
      '123',
      '.123',
      '123.',
      '123.a',
      '123.456.789',
      '123.456 ',
      '123.\u200b456',
    ]) {
      expect(
        parseChatChannelBinding({ ...binding, externalThreadId }),
      ).toBeNull();
      expect(
        parseChatDeliveryLogEntry({ ...slackDelivery, externalThreadId }),
      ).toBeNull();
    }
    expect(
      parseChatChannelBinding({ ...binding, externalThreadId: '123.456' }),
    ).not.toBeNull();
    expect(
      parseChatChannelBinding({
        ...binding,
        externalChannelId: `C${'A'.repeat(255)}`,
      }),
    ).not.toBeNull();
    expect(
      parseChatChannelBinding({
        ...binding,
        externalChannelId: `C${'A'.repeat(256)}`,
      }),
    ).toBeNull();
  });

  test('issues only a hash and attempt budget before the authenticated principal is known', () => {
    expect(parseChatLinkCode(linkCode)).toEqual(linkCode);
    const { challengeId: _challengeId, ...withoutChallenge } = confirm;
    const { challengeId: _storedChallengeId, ...withoutStoredChallenge } =
      linkCode;
    expect(parseChatLinkConfirmRequest(withoutChallenge)).toBeNull();
    expect(parseChatLinkCode(withoutStoredChallenge)).toBeNull();
    for (const challengeId of [
      undefined,
      '',
      ' '.repeat(2),
      'a'.repeat(257),
      'bad\u0000id',
    ]) {
      expect(parseChatLinkCode({ ...linkCode, challengeId })).toBeNull();
      expect(
        parseChatLinkConfirmRequest({ ...confirm, challengeId }),
      ).toBeNull();
    }
    expect(parseChatLinkCode({ ...linkCode, code: confirm.code })).toBeNull();
    expect(
      parseChatLinkCode({ ...linkCode, principalId: 'person-1' }),
    ).toBeNull();
    for (const codeHash of [
      confirm.code,
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
    ])
      expect(parseChatLinkCode({ ...linkCode, codeHash })).toBeNull();
    for (const failedAttempts of [-1, 1.5, 6, '0', undefined])
      expect(parseChatLinkCode({ ...linkCode, failedAttempts })).toBeNull();
    expect(parseChatLinkCode({ ...linkCode, failedAttempts: 5 })).toEqual({
      ...linkCode,
      failedAttempts: 5,
    });
    expect(
      parseChatLinkConfirmRequest({ ...confirm, principalId: 'untrusted' }),
    ).toBeNull();
  });

  test('bounds raw confirmation format and consumption, without granting redemption', () => {
    expect(parseChatLinkConfirmRequest(confirm)).toEqual(confirm);
    for (const code of [
      'A'.repeat(9),
      'A'.repeat(129),
      'ABCD23456I',
      'ABCD23456O',
      'ABCD234560',
      'ABCD234561',
      'abcd234567',
      'ABCD_23456',
      'ABCD-23456',
      'ABCD 23456',
    ])
      expect(parseChatLinkConfirmRequest({ ...confirm, code })).toBeNull();
    expect(
      parseChatLinkCode({ ...linkCode, expiresAt: '2026-10-26T12:10:00.000Z' }),
    ).not.toBeNull();
    for (const expiresAt of [
      time,
      '2026-10-26T11:59:59.999Z',
      '2026-10-26T12:10:00.001Z',
    ])
      expect(parseChatLinkCode({ ...linkCode, expiresAt })).toBeNull();
    const consumed = {
      ...linkCode,
      consumedAt: '2026-10-26T12:00:30.000Z',
      principalId: 'person-1',
      failedAttempts: 4,
    };
    expect(parseChatLinkCode(consumed)).toEqual(consumed);
    expect(
      parseChatLinkCode({ ...consumed, principalId: undefined }),
    ).toBeNull();
    expect(parseChatLinkCode({ ...consumed, failedAttempts: 5 })).toBeNull();
    for (const consumedAt of ['2026-10-26T11:59:59.999Z', later, 'invalid'])
      expect(parseChatLinkCode({ ...consumed, consumedAt })).toBeNull();
  });
});
