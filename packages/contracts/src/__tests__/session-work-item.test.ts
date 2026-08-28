import { describe, expect, test } from 'vitest';
import {
  parseSessionWorkItemAssociation,
  SESSION_WORK_ITEM_ASSOCIATION_V1,
} from '../session-work-item.js';

function association(): Record<string, unknown> {
  return {
    version: SESSION_WORK_ITEM_ASSOCIATION_V1,
    associationId: 'association-1',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    eventId: 'event-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    relation: 'created',
    provider: { id: 'github', host: 'github.com' },
    workItemRef: 'github:kontourai/station#235',
    repository: { owner: 'kontourai', name: 'station' },
    nativeId: '1234567890',
    observedAt: '2026-08-28T12:00:00.000Z',
  };
}

describe('Session work-item association v1', () => {
  test('accepts and copies only its exact immutable identity fields', () => {
    const input = association();
    expect(parseSessionWorkItemAssociation(input)).toEqual(input);
    expect(parseSessionWorkItemAssociation(input)).not.toBe(input);
  });

  test.each([
    ['raw URL', { url: 'https://github.com/kontourai/station/issues/235' }],
    ['raw href', { href: 'https://github.com/kontourai/station/issues/235' }],
    ['issue body', { body: 'untrusted provider body' }],
    ['tool result', { toolResult: { content: [] } }],
    ['title', { title: 'mutable provider title' }],
    ['noncanonical ref', { workItemRef: 'github:kontourai/station#0235' }],
    ['dot repository', { repository: { owner: 'kontourai', name: '.' } }],
    ['dot-dot repository', { repository: { owner: 'kontourai', name: '..' } }],
    ['non-decimal native id', { nativeId: 'I_kwDOExample' }],
    ['zero native id', { nativeId: '0' }],
  ])('rejects %s', (_label, mutation) => {
    expect(
      parseSessionWorkItemAssociation({ ...association(), ...mutation }),
    ).toBeNull();
  });

  test('fails closed for getters and Proxies that throw during inspection', () => {
    const getter = association();
    Object.defineProperty(getter, 'nativeId', {
      enumerable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    const proxy = new Proxy(association(), {
      getPrototypeOf() {
        throw new Error('hostile proxy');
      },
    });
    expect(() => parseSessionWorkItemAssociation(getter)).not.toThrow();
    expect(parseSessionWorkItemAssociation(getter)).toBeNull();
    expect(() => parseSessionWorkItemAssociation(proxy)).not.toThrow();
    expect(parseSessionWorkItemAssociation(proxy)).toBeNull();
  });
});
