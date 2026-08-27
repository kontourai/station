import { describe, expect, test } from 'vitest';
import {
  mapApprovalModeToPermissionMode,
  mapPermissionModeToApprovalMode,
  resolveClaudePermissionMode,
} from '../adapters/claude-approval-mode.js';

describe('mapApprovalModeToPermissionMode', () => {
  test('maps ask to the SDK default permission mode', () => {
    expect(mapApprovalModeToPermissionMode('ask')).toBe('default');
  });

  test('maps auto to acceptEdits', () => {
    expect(mapApprovalModeToPermissionMode('auto')).toBe('acceptEdits');
  });

  test('maps never to bypassPermissions', () => {
    expect(mapApprovalModeToPermissionMode('never')).toBe('bypassPermissions');
  });

  test('connection-default and undefined both defer to the caller default', () => {
    expect(
      mapApprovalModeToPermissionMode('connection-default'),
    ).toBeUndefined();
    expect(mapApprovalModeToPermissionMode(undefined)).toBeUndefined();
  });
});

describe('resolveClaudePermissionMode', () => {
  test('reads approvalMode out of a modelOptions bag', () => {
    expect(resolveClaudePermissionMode({ approvalMode: 'never' })).toBe(
      'bypassPermissions',
    );
  });

  test('an absent or unrecognized approvalMode resolves to undefined (adapter keeps its own default)', () => {
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
});
