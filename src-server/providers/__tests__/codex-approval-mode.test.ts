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
    expect(mapApprovalModeToCodex('ask', 'workspace')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
  });

  test('maps auto to on-request approval with a workspace-write sandbox', () => {
    expect(mapApprovalModeToCodex('auto', 'workspace')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  test('maps never to the never/danger-full-access pairing for a host session', () => {
    expect(mapApprovalModeToCodex('never', 'host')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  test('#2493: never outside a host session keeps no prompts but confines writes to the workspace', () => {
    for (const confinement of ['workspace', undefined] as const) {
      expect(mapApprovalModeToCodex('never', confinement)).toEqual({
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      });
    }
  });

  test('#2493: ask and auto are the same pair whatever the confinement', () => {
    for (const mode of ['ask', 'auto'] as const) {
      expect(mapApprovalModeToCodex(mode, 'host')).toEqual(
        mapApprovalModeToCodex(mode, 'workspace'),
      );
    }
  });

  test('connection-default and undefined omit knobs so Codex inherits its own config (station#1950)', () => {
    expect(
      mapApprovalModeToCodex('connection-default', 'host'),
    ).toBeUndefined();
    expect(mapApprovalModeToCodex(undefined, 'host')).toBeUndefined();
    expect(CODEX_DEFAULT_APPROVAL_KNOBS).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });
});

describe('resolveCodexApprovalKnobs', () => {
  test('reads approvalMode out of a modelOptions bag', () => {
    expect(
      resolveCodexApprovalKnobs({ approvalMode: 'ask' }, 'workspace'),
    ).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
  });

  test('ignores an unrecognized approvalMode value rather than inventing knobs', () => {
    expect(
      resolveCodexApprovalKnobs({ approvalMode: 'not-a-real-mode' }, 'host'),
    ).toBeUndefined();
  });

  test('an absent approvalMode omits knobs so Codex applies its own config (station#1950)', () => {
    expect(resolveCodexApprovalKnobs(undefined, 'host')).toBeUndefined();
    expect(resolveCodexApprovalKnobs({}, 'host')).toBeUndefined();
    expect(
      resolveCodexApprovalKnobs(
        { reasoningEffort: 'high', fastMode: true },
        'host',
      ),
    ).toBeUndefined();
  });
});

describe('resolveCodexExecutionKnobs', () => {
  test('server review isolation overrides every user approval preference with native read-only/no-escalation', () => {
    for (const approvalMode of ['ask', 'auto', 'never'] as const) {
      for (const confinement of ['host', 'workspace'] as const) {
        expect(
          resolveCodexExecutionKnobs(
            { approvalMode },
            { workspaceAccess: 'read-only' },
            confinement,
          ),
        ).toEqual({ approvalPolicy: 'never', sandbox: 'read-only' });
      }
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
    // #2493: a confined session's never is still reported as never; its
    // confinement is reported beside it, not recovered from the pair.
    expect(
      mapCodexKnobsToApprovalMode({
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      }),
    ).toBe('never');
  });

  test('reports the mode mapApprovalModeToCodex was given, for every concrete mode and confinement', () => {
    for (const mode of ['ask', 'auto', 'never'] as const) {
      for (const confinement of ['host', 'workspace'] as const) {
        expect(
          mapCodexKnobsToApprovalMode(
            mapApprovalModeToCodex(mode, confinement)!,
          ),
        ).toBe(mode);
      }
    }
  });

  test('the review-isolation pair is not an approval mode', () => {
    expect(
      mapCodexKnobsToApprovalMode({
        approvalPolicy: 'never',
        sandbox: 'read-only',
      }),
    ).toBe('connection-default');
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
