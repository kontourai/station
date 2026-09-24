// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  agentInputAge,
  RECENT_AGENT_DRIVE_MS,
  type RecentAgentInput,
  recentDriver,
  useRecentDriver,
} from '../recentDriver';

const agent = (agentInputAgeMs: number | undefined) => ({
  holder: null,
  lastDriverIsAgent: true,
  agentInputAgeMs,
});

describe('recentDriver (#90 D9)', () => {
  test('a held lease names its holder, whatever the agent did', () => {
    expect(recentDriver({ ...agent(10), holder: 'you' })).toBe('you');
    expect(recentDriver({ ...agent(10), holder: 'other' })).toBe('other');
    expect(recentDriver({ ...agent(undefined), holder: 'agent' })).toBe(
      'agent',
    );
  });

  test('with no holder, an agent input younger than the window is driving; at the window edge it is not', () => {
    for (const holder of [null, 'none'] as const) {
      expect(recentDriver({ ...agent(1), holder })).toBe('agent');
      expect(
        recentDriver({ ...agent(RECENT_AGENT_DRIVE_MS - 1), holder }),
      ).toBe('agent');
      expect(recentDriver({ ...agent(RECENT_AGENT_DRIVE_MS), holder })).toBe(
        'none',
      );
    }
  });

  test('the window is ten seconds', () => {
    expect(RECENT_AGENT_DRIVE_MS).toBe(10_000);
    expect(recentDriver(agent(9_999))).toBe('agent');
    expect(recentDriver(agent(10_000))).toBe('none');
  });

  test('a person driving since (last driver not an agent) is not an agent driving, however recent the input (L1)', () => {
    expect(recentDriver({ ...agent(1), lastDriverIsAgent: false })).toBe(
      'none',
    );
  });

  test('no known input, or an unreadable age, is no one', () => {
    expect(recentDriver(agent(undefined))).toBe('none');
    expect(recentDriver(agent(Number.NaN))).toBe('none');
  });
});

describe('agentInputAge (#90 D9, L2)', () => {
  const input = (overrides: Partial<RecentAgentInput>): RecentAgentInput => ({
    lastAgentInputAt: '2026-09-23T12:00:00.000Z',
    serverNow: '2026-09-23T12:00:03.000Z',
    receivedAt: 1_000,
    lastDriverIsAgent: true,
    ...overrides,
  });

  test('age at send from the server clock, plus time since receipt on the local monotonic clock', () => {
    expect(agentInputAge(input({}), 1_500)).toBe(3_500);
  });

  test('a server clock stepped back (negative age) is clamped to zero: never more than one window from receipt', () => {
    const stepped = input({ serverNow: '2026-09-23T11:59:00.000Z' });
    expect(agentInputAge(stepped, 1_000)).toBe(0);
    expect(agentInputAge(stepped, 1_000 + RECENT_AGENT_DRIVE_MS)).toBe(
      RECENT_AGENT_DRIVE_MS,
    );
  });

  test('a missing serverNow, input time or receipt is no known input', () => {
    expect(agentInputAge(input({ serverNow: undefined }), 1_500)).toBe(
      undefined,
    );
    expect(agentInputAge(input({ lastAgentInputAt: undefined }), 1_500)).toBe(
      undefined,
    );
    expect(agentInputAge(input({ receivedAt: undefined }), 1_500)).toBe(
      undefined,
    );
  });
});

describe('useRecentDriver (#90 D9, L2)', () => {
  const fresh = (
    receivedAgoMs: number,
    sentAgoMs: number,
  ): RecentAgentInput => {
    const serverNow = Date.parse('2026-09-23T12:00:10.000Z');
    return {
      lastAgentInputAt: new Date(serverNow - sentAgoMs).toISOString(),
      serverNow: new Date(serverNow).toISOString(),
      receivedAt: performance.now() - receivedAgoMs,
      lastDriverIsAgent: true,
    };
  };

  test('data received long enough ago (a remount reading the cache) is past the window, whatever its age when sent', () => {
    // Sent 2 s after the input; received 9 s ago: 11 s old now.
    const { result } = renderHook(() =>
      useRecentDriver(null, fresh(9_000, 2_000)),
    );
    expect(result.current).toBe('none');
  });

  test('the same payload just received is an agent driving', () => {
    const { result } = renderHook(() => useRecentDriver(null, fresh(0, 2_000)));
    expect(result.current).toBe('agent');
  });

  test('without serverNow the hook shows no agent driving', () => {
    const { result } = renderHook(() =>
      useRecentDriver(null, { ...fresh(0, 1_000), serverNow: undefined }),
    );
    expect(result.current).toBe('none');
  });
});
