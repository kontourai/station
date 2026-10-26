import {
  type ChatAppCapabilityChip,
  type ChatChannelBinding,
  type ChatDeliveryLogEntry,
  type ChatIdentityLink,
  type ChatLinkCode,
  parseChatAppCapabilityChip,
  parseChatAppId,
  parseChatAppKillSwitch,
  parseChatChannelBinding,
  parseChatDeliveryLogEntry,
  parseChatIdentityLink,
  parseChatLinkCode,
  parseChatLinkConfirmRequest,
} from '@kontourai/station-contracts/chat-app';
import { describe, expect, test } from 'vitest';

const time = '2026-10-26T12:00:00.000Z';
const later = '2026-10-26T12:01:00.000Z';
const link: ChatIdentityLink = {
  app: 'discord',
  externalUserId: 'user-1',
  principalId: 'person-1',
  linkedAt: time,
};
const binding: ChatChannelBinding = {
  id: 'binding-1',
  app: 'slack',
  externalWorkspaceId: 'workspace-1',
  externalChannelId: 'channel-1',
  target: { kind: 'project', projectId: 'project-1' },
  boundByPrincipalId: 'operator',
  boundAt: time,
};
const delivery: ChatDeliveryLogEntry = {
  id: 'delivery-1',
  app: 'discord',
  externalWorkspaceId: 'guild-1',
  externalChannelId: 'channel-1',
  direction: 'inbound',
  action: 'start',
  outcome: { state: 'refused', reason: 'unlinked-sender' },
  createdAt: time,
};
const linkCode: ChatLinkCode = {
  app: 'slack',
  code: 'ABCD_1234',
  externalUserId: 'user-1',
  principalId: 'person-1',
  issuedAt: time,
  expiresAt: later,
};
const confirm = { app: 'slack', code: 'ABCD_1234', principalId: 'person-1' };
const killSwitch = {
  app: 'slack',
  disabled: true,
  updatedAt: time,
  updatedByPrincipalId: 'operator',
};
const chip: ChatAppCapabilityChip = {
  capability: 'notify',
  probe: 'discord.gateway',
  state: 'works',
};

describe('chat app boundary contracts', () => {
  test('admits only Discord and Slack app ids', () => {
    expect(parseChatAppId('discord')).toBe('discord');
    expect(parseChatAppId('slack')).toBe('slack');
    expect(parseChatAppId('teams')).toBeNull();
    expect(parseChatAppId(null)).toBeNull();
  });

  test.each(['notify', 'start', 'continue', 'approve'])(
    'requires a probe for the %s capability chip',
    (capability) => {
      expect(parseChatAppCapabilityChip({ ...chip, capability })).toEqual({
        ...chip,
        capability,
      });
      expect(
        parseChatAppCapabilityChip({ capability, state: 'works' }),
      ).toBeNull();
      expect(
        parseChatAppCapabilityChip({ ...chip, capability, probe: '' }),
      ).toBeNull();
    },
  );

  test('refuses unknown capabilities and unsupported chip states', () => {
    expect(
      parseChatAppCapabilityChip({ ...chip, capability: 'admin' }),
    ).toBeNull();
    expect(parseChatAppCapabilityChip({ ...chip, state: true })).toBeNull();
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
      ])
        expect(parse(invalid)).toBeNull();
    },
  );

  test('retains revocation and refuses reversed or invalid timestamps', () => {
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
  });

  test('binds only a Project or a conversation with a closed target', () => {
    const target = {
      kind: 'conversation',
      conversationId: 'conversation-1',
    };
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
      { state: 'delivered', externalMessageId: 'message-1' },
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

  const boundedFields = [
    [parseChatIdentityLink, link, 'externalUserId', 256],
    [parseChatIdentityLink, link, 'principalId', 256],
    [parseChatLinkCode, linkCode, 'externalUserId', 256],
    [parseChatLinkCode, linkCode, 'principalId', 256],
    [parseChatLinkCode, linkCode, 'code', 128],
    [parseChatLinkConfirmRequest, confirm, 'principalId', 256],
    [parseChatLinkConfirmRequest, confirm, 'code', 128],
    [parseChatAppCapabilityChip, chip, 'probe', 256],
    [parseChatChannelBinding, binding, 'id', 256],
    [parseChatChannelBinding, binding, 'externalWorkspaceId', 256],
    [parseChatChannelBinding, binding, 'externalChannelId', 256],
    [parseChatChannelBinding, binding, 'externalThreadId', 256],
    [parseChatChannelBinding, binding, 'boundByPrincipalId', 256],
    [parseChatDeliveryLogEntry, delivery, 'id', 256],
    [parseChatDeliveryLogEntry, delivery, 'externalWorkspaceId', 256],
    [parseChatDeliveryLogEntry, delivery, 'externalChannelId', 256],
    ...(
      [
        'externalThreadId',
        'externalUserId',
        'principalId',
        'projectId',
        'conversationId',
        'taskId',
        'retryOf',
      ] as const
    ).map((key) => [parseChatDeliveryLogEntry, delivery, key, 256] as const),
    [parseChatAppKillSwitch, killSwitch, 'updatedByPrincipalId', 256],
    [parseChatAppKillSwitch, killSwitch, 'reason', 1000],
  ] as const;

  test.each(boundedFields)(
    'refuses max+1 for %s / %s / %s',
    (parse, valid, key, max) => {
      const atMax = { ...valid, [key]: 'x'.repeat(max) };
      expect(parse(atMax)).toEqual(atMax);
      expect(parse({ ...valid, [key]: 'x'.repeat(max + 1) })).toBeNull();
      expect(parse({ ...valid, [key]: '' })).toBeNull();
    },
  );

  test('bounds nested target ids and failure diagnostics', () => {
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
    expect(
      parseChatDeliveryLogEntry({
        ...delivery,
        outcome: { state: 'delivered', externalMessageId: 'x'.repeat(257) },
      }),
    ).toBeNull();
  });

  test('refuses invalid ids, coerced kill switches and malformed Unicode', () => {
    for (const principalId of [
      ' person',
      'person\n',
      '\ud800',
      'a\u0000b',
      123,
    ])
      expect(parseChatIdentityLink({ ...link, principalId })).toBeNull();
    expect(
      parseChatAppKillSwitch({ ...killSwitch, disabled: 'true' }),
    ).toBeNull();
  });

  test('bounds code length, alphabet, lifetime and consumption window without granting redemption', () => {
    expect(
      parseChatLinkCode({ ...linkCode, code: 'x'.repeat(8) }),
    ).not.toBeNull();
    for (const code of ['x'.repeat(7), 'abcd 1234', 'abcd/1234']) {
      expect(parseChatLinkCode({ ...linkCode, code })).toBeNull();
      expect(parseChatLinkConfirmRequest({ ...confirm, code })).toBeNull();
    }
    expect(
      parseChatLinkCode({ ...linkCode, expiresAt: '2026-10-26T12:10:00.000Z' }),
    ).not.toBeNull();
    for (const expiresAt of [
      time,
      '2026-10-26T11:59:59.999Z',
      '2026-10-26T12:10:00.001Z',
    ])
      expect(parseChatLinkCode({ ...linkCode, expiresAt })).toBeNull();
    const consumed = { ...linkCode, consumedAt: '2026-10-26T12:00:30.000Z' };
    expect(parseChatLinkCode(consumed)).toEqual(consumed);
    for (const consumedAt of ['2026-10-26T11:59:59.999Z', later, 'invalid'])
      expect(parseChatLinkCode({ ...linkCode, consumedAt })).toBeNull();
  });
});
