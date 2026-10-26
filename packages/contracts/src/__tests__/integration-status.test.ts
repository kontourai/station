import {
  parseIntegrationActionStatus,
  parseIntegrationConnectionStatus,
  parseIntegrationStatus,
} from '@kontourai/station-contracts/integration-status';
import { describe, expect, test } from 'vitest';

const action = {
  action: 'approve',
  computedBy: 'discord.gateway',
  state: 'works',
  reason: 'Gateway connected',
};
const connection = {
  connectionId: 'discord-1',
  provider: 'discord',
  actions: [action],
};

describe('integration status boundary', () => {
  test.each(['works', 'waiting-on-provider', 'unsupported', 'failed'])(
    'retains the %s action state and its probe reason',
    (state) => {
      const value = {
        ...action,
        state,
        reason:
          state === 'waiting-on-provider'
            ? 'flow-agents #1508 is open'
            : 'Probe diagnostic',
      };
      expect(parseIntegrationActionStatus(value)).toEqual(value);
    },
  );

  test('refuses actions without a computation or upstream reason', () => {
    expect(
      parseIntegrationActionStatus({
        action: 'read',
        state: 'works',
        reason: 'Connected',
      }),
    ).toBeNull();
    expect(
      parseIntegrationActionStatus({
        action: 'read',
        state: 'works',
        computedBy: 'gh.auth',
      }),
    ).toBeNull();
    expect(
      parseIntegrationActionStatus({ ...action, computedBy: '' }),
    ).toBeNull();
    expect(
      parseIntegrationActionStatus({ ...action, state: 'ready' }),
    ).toBeNull();
  });

  test.each(['github', 'discord', 'slack', 'webhook', 'linear', 'jira'])(
    'lists actions per %s connection',
    (provider) => {
      const value = { connections: [{ ...connection, provider }] };
      expect(parseIntegrationStatus(value)).toEqual(value);
    },
  );

  test('rejects extra keys at every level, malformed records and duplicate identities', () => {
    expect(parseIntegrationActionStatus({ ...action, extra: true })).toBeNull();
    expect(
      parseIntegrationConnectionStatus({ ...connection, extra: true }),
    ).toBeNull();
    expect(
      parseIntegrationStatus({ connections: [connection], extra: true }),
    ).toBeNull();
    expect(
      parseIntegrationStatus({
        connections: [{ ...connection, actions: [{ ...action, extra: true }] }],
      }),
    ).toBeNull();
    expect(
      parseIntegrationStatus({ connections: [connection, connection] }),
    ).toBeNull();
    expect(
      parseIntegrationConnectionStatus({
        ...connection,
        actions: [action, action],
      }),
    ).toBeNull();
    expect(
      parseIntegrationConnectionStatus({ ...connection, provider: 'unknown' }),
    ).toBeNull();
    for (const parse of [
      parseIntegrationActionStatus,
      parseIntegrationConnectionStatus,
      parseIntegrationStatus,
    ])
      for (const value of [null, [], 'value', {}])
        expect(parse(value)).toBeNull();
  });

  test.each([
    ['action', 64],
    ['computedBy', 256],
    ['reason', 1000],
  ] as const)('accepts max and refuses max+1 or empty %s', (key, max) => {
    const value = { ...action, [key]: 'x'.repeat(max) };
    expect(parseIntegrationActionStatus(value)).toEqual(value);
    expect(
      parseIntegrationActionStatus({ ...action, [key]: 'x'.repeat(max + 1) }),
    ).toBeNull();
    expect(parseIntegrationActionStatus({ ...action, [key]: '' })).toBeNull();
  });

  test('bounds connection ids, action counts and connection counts without truncating', () => {
    const actions = Array.from({ length: 32 }, (_, i) => ({
      ...action,
      action: `action-${i}`,
    }));
    const atMax = { ...connection, connectionId: 'x'.repeat(256), actions };
    expect(parseIntegrationConnectionStatus(atMax)).toEqual(atMax);
    expect(
      parseIntegrationConnectionStatus({
        ...atMax,
        connectionId: 'x'.repeat(257),
      }),
    ).toBeNull();
    expect(
      parseIntegrationConnectionStatus({
        ...connection,
        actions: [...actions, { ...action, action: 'extra' }],
      }),
    ).toBeNull();
    const connections = Array.from({ length: 100 }, (_, i) => ({
      ...connection,
      connectionId: `connection-${i}`,
    }));
    expect(parseIntegrationStatus({ connections })).toEqual({ connections });
    expect(
      parseIntegrationStatus({
        connections: [...connections, { ...connection, connectionId: 'extra' }],
      }),
    ).toBeNull();
  });
});
