import { describe, expect, test } from 'vitest';
import {
  clearSessionInventorySelection,
  clearSessionInventorySelectionsForAuthority,
  commitSessionInventorySelection,
  readSessionInventoryKnownScopes,
  readSessionInventorySelection,
} from '../sessionInventorySelection';

describe('session inventory selection', () => {
  test('is in-memory, authority-keyed, and clears when authority is lost', () => {
    const key = {
      apiBase: 'http://station.test',
      authorityKey: 'epoch-a',
      sessionId: 'session',
    };
    commitSessionInventorySelection(key, {
      scope: { kind: 'whole-session', sessionId: 'session' },
      groupId: 'outputs',
      itemKey: 'output',
    });
    expect(readSessionInventorySelection(key)?.itemKey).toBe('output');
    expect(
      readSessionInventorySelection({ ...key, authorityKey: 'epoch-b' }),
    ).toBeUndefined();
    clearSessionInventorySelectionsForAuthority(key.apiBase, key.authorityKey);
    expect(readSessionInventorySelection(key)).toBeUndefined();
  });
});

test('retains only explicitly committed exact scopes across selection repair', () => {
  const key = {
    apiBase: 'http://station.test',
    authorityKey: 'epoch-exact',
    sessionId: 'session',
  };
  const current = {
    kind: 'current-answer' as const,
    sessionId: 'session',
    turnId: 'answer-a',
  };
  const kept = {
    kind: 'kept-in-task' as const,
    sessionId: 'session',
    taskId: 'task-b',
  };
  commitSessionInventorySelection(key, { scope: current, groupId: 'inputs' });
  commitSessionInventorySelection(key, { scope: kept, groupId: 'kept' });
  clearSessionInventorySelection(key);
  expect(readSessionInventoryKnownScopes(key)).toEqual([current, kept]);
  expect(readSessionInventorySelection(key)).toBeUndefined();
});

test('clears a repaired current-answer scope from its authority history', () => {
  const key = {
    apiBase: 'http://station.test',
    authorityKey: 'epoch-secret',
    sessionId: 'session',
  };
  commitSessionInventorySelection(key, {
    scope: {
      kind: 'current-answer',
      sessionId: 'session',
      turnId: 'secret-answer',
    },
    groupId: 'inputs',
  });
  // Selection repair removes the active value but must not leave its exact
  // scope in the authority-bound history after authority loss.
  clearSessionInventorySelection(key);
  expect(readSessionInventoryKnownScopes(key)).toHaveLength(1);
  clearSessionInventorySelectionsForAuthority(key.apiBase, key.authorityKey);
  expect(readSessionInventoryKnownScopes(key)).toEqual([]);
});
