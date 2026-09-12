import { describe, expect, test } from 'vitest';
import {
  CODEX_DEFAULT_APPROVAL_KNOBS,
  mapApprovalModeToCodex,
  mapCodexKnobsToApprovalMode,
  resolveCodexApprovalKnobs,
  resolveCodexExecutionKnobs,
} from '../adapters/codex-approval-mode.js';

describe('mapApprovalModeToCodex', () => {
  test('maps ask to untrusted approval with a workspace-write sandbox', () => {
    expect(mapApprovalModeToCodex('ask')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
  });

  test('maps auto to on-request approval with a workspace-write sandbox', () => {
    expect(mapApprovalModeToCodex('auto')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  test('maps never to the never/danger-full-access pairing', () => {
    expect(mapApprovalModeToCodex('never')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  test('connection-default and undefined omit knobs so Codex inherits its own config (station#1950)', () => {
    expect(mapApprovalModeToCodex('connection-default')).toBeUndefined();
    expect(mapApprovalModeToCodex(undefined)).toBeUndefined();
    expect(CODEX_DEFAULT_APPROVAL_KNOBS).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });
});

describe('resolveCodexApprovalKnobs', () => {
  test('reads approvalMode out of a modelOptions bag', () => {
    expect(resolveCodexApprovalKnobs({ approvalMode: 'ask' })).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
  });

  test('ignores an unrecognized approvalMode value rather than inventing knobs', () => {
    expect(
      resolveCodexApprovalKnobs({ approvalMode: 'not-a-real-mode' }),
    ).toBeUndefined();
  });

  test('an absent approvalMode omits knobs so Codex applies its own config (station#1950)', () => {
    expect(resolveCodexApprovalKnobs(undefined)).toBeUndefined();
    expect(resolveCodexApprovalKnobs({})).toBeUndefined();
    expect(
      resolveCodexApprovalKnobs({ reasoningEffort: 'high', fastMode: true }),
    ).toBeUndefined();
  });
});

describe('resolveCodexExecutionKnobs', () => {
  test('server review isolation overrides every user approval preference with native read-only/no-escalation', () => {
    for (const approvalMode of ['ask', 'auto', 'never'] as const) {
      expect(
        resolveCodexExecutionKnobs(
          { approvalMode },
          { workspaceAccess: 'read-only' },
        ),
      ).toEqual({ approvalPolicy: 'never', sandbox: 'read-only' });
    }
  });
});

describe('mapCodexKnobsToApprovalMode', () => {
  test('reverses the forward mapping for every ApprovalMode Codex supports', () => {
    expect(
      mapCodexKnobsToApprovalMode({
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
      }),
    ).toBe('ask');
    expect(
      mapCodexKnobsToApprovalMode({
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      }),
    ).toBe('auto');
    expect(
      mapCodexKnobsToApprovalMode({
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      }),
    ).toBe('never');
  });

  test('round-trips through mapApprovalModeToCodex for every concrete mode', () => {
    for (const mode of ['ask', 'auto', 'never'] as const) {
      expect(mapCodexKnobsToApprovalMode(mapApprovalModeToCodex(mode)!)).toBe(
        mode,
      );
    }
  });

  test('an unrecognized knob pair reports the connection-default sentinel rather than guessing', () => {
    expect(
      mapCodexKnobsToApprovalMode({
        approvalPolicy: 'untrusted',
        sandbox: 'danger-full-access',
      }),
    ).toBe('connection-default');
  });
});
