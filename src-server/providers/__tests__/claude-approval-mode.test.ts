import { describe, expect, test } from 'vitest';
import {
  mapPermissionModeToApprovalMode,
  resolveClaudePermissionMode,
} from '../adapters/claude-approval-mode.js';

describe('resolveClaudePermissionMode', () => {
  test.each([
    ['ask', 'default'],
    ['auto', 'acceptEdits'],
    ['never', 'bypassPermissions'],
    ['connection-default', undefined],
  ] as const)(
    'approvalMode %s resolves to permission mode %s',
    (approvalMode, expected) => {
      expect(resolveClaudePermissionMode({ approvalMode })).toBe(expected);
    },
  );

  test('an absent or unrecognized approvalMode resolves to undefined (inherit engine config)', () => {
    expect(resolveClaudePermissionMode(undefined)).toBeUndefined();
    expect(resolveClaudePermissionMode({})).toBeUndefined();
    expect(
      resolveClaudePermissionMode({ approvalMode: 'not-a-real-mode' }),
    ).toBeUndefined();
  });
});

describe('mapPermissionModeToApprovalMode', () => {
  test('reverses the forward mapping for every ApprovalMode Claude supports', () => {
    expect(mapPermissionModeToApprovalMode('default')).toBe('ask');
    expect(mapPermissionModeToApprovalMode('acceptEdits')).toBe('auto');
    expect(mapPermissionModeToApprovalMode('bypassPermissions')).toBe('never');
  });

  test('plan has no ApprovalMode analog and is left unmapped', () => {
    expect(mapPermissionModeToApprovalMode('plan')).toBeUndefined();
  });

  test('Claude classifier auto reports as Station auto for the applied-default chip', () => {
    expect(mapPermissionModeToApprovalMode('auto')).toBe('auto');
  });
});
