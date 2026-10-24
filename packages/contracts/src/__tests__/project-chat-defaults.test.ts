import { describe, expect, test } from 'vitest';
import {
  isProjectChatApprovalPosture,
  isProjectChatDefaultSelection,
  PROJECT_CHAT_APPROVAL_POSTURES,
  PROJECT_CHAT_DEFAULT_RECORD_FIELDS,
  PROJECT_CHAT_DEFAULT_SELECTIONS,
  type ProjectChatDefaultsView,
  projectLastUsedModelFor,
  resolveProjectChatApprovalDefault,
} from '../project-chat-defaults.js';

const LAST_AUTO = {
  approvalMode: 'auto' as const,
  startedAt: '2026-10-01T00:00:00.000Z',
};
const LAST_NEVER = {
  approvalMode: 'never' as const,
  startedAt: '2026-10-01T00:00:00.000Z',
};

describe('project chat default contract values', () => {
  test('the selections and postures are exactly these', () => {
    expect([...PROJECT_CHAT_DEFAULT_SELECTIONS]).toEqual([
      'fixed',
      'last-used',
    ]);
    expect([...PROJECT_CHAT_APPROVAL_POSTURES]).toEqual([
      'ask',
      'auto',
      'never',
    ]);
    expect([...PROJECT_CHAT_DEFAULT_RECORD_FIELDS]).toEqual([
      'defaultModelSelection',
      'defaultApprovalMode',
      'defaultApprovalModeSelection',
    ]);
    expect(isProjectChatDefaultSelection('last-used')).toBe(true);
    expect(isProjectChatDefaultSelection('latest')).toBe(false);
    // "Leave it to the engine" is the absence of a Project mode, not a value.
    expect(isProjectChatApprovalPosture('connection-default')).toBe(false);
  });
});

describe('resolveProjectChatApprovalDefault', () => {
  const base = { lastUsedApplies: true, mayGrantFullAccess: false };

  test('an absent selection is fixed: existing Projects keep their behavior', () => {
    expect(
      resolveProjectChatApprovalDefault({ ...base, lastUsed: LAST_AUTO }),
    ).toEqual({ source: 'none' });
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        fixed: 'ask',
        lastUsed: LAST_AUTO,
      }),
    ).toEqual({ approvalMode: 'ask', source: 'fixed' });
  });

  test('last-used applies the recorded mode over the fixed one', () => {
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        selection: 'last-used',
        fixed: 'ask',
        lastUsed: LAST_AUTO,
      }),
    ).toEqual({ approvalMode: 'auto', source: 'last-used' });
  });

  test('last-used with nothing recorded falls back to the fixed mode and says so', () => {
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        selection: 'last-used',
        fixed: 'ask',
      }),
    ).toEqual({ approvalMode: 'ask', source: 'fixed', fallback: 'no-history' });
    expect(
      resolveProjectChatApprovalDefault({ ...base, selection: 'last-used' }),
    ).toEqual({ source: 'none', fallback: 'no-history' });
  });

  test('a recorded full access needs this start’s own grant', () => {
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        selection: 'last-used',
        fixed: 'auto',
        lastUsed: LAST_NEVER,
      }),
    ).toEqual({
      approvalMode: 'auto',
      source: 'fixed',
      fallback: 'full-access-not-granted',
    });
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        mayGrantFullAccess: true,
        selection: 'last-used',
        lastUsed: LAST_NEVER,
      }),
    ).toEqual({ approvalMode: 'never', source: 'last-used' });
  });

  test('a start that is not a person’s chat never inherits last-used', () => {
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        lastUsedApplies: false,
        selection: 'last-used',
        fixed: 'ask',
        lastUsed: LAST_AUTO,
      }),
    ).toEqual({ approvalMode: 'ask', source: 'fixed' });
  });

  test('values outside the contract are ignored, not applied', () => {
    expect(
      resolveProjectChatApprovalDefault({
        ...base,
        selection: 'last-used',
        fixed: 'connection-default',
        lastUsed: { approvalMode: 'yolo', startedAt: 'x' } as never,
      }),
    ).toEqual({ source: 'none', fallback: 'no-history' });
  });
});

describe('projectLastUsedModelFor', () => {
  const view = (
    selection: 'fixed' | 'last-used',
  ): Pick<ProjectChatDefaultsView, 'model'> => ({
    model: {
      selection,
      lastUsed: [
        { agentSlug: 'codex', modelId: 'gpt-x', startedAt: '2026-10-02' },
        { agentSlug: 'claude', modelId: 'sonnet', startedAt: '2026-10-01' },
      ],
    },
  });

  test('picks the Agent’s own entry only under last-used', () => {
    expect(projectLastUsedModelFor(view('last-used'), 'claude')?.modelId).toBe(
      'sonnet',
    );
    expect(projectLastUsedModelFor(view('fixed'), 'claude')).toBeUndefined();
    expect(projectLastUsedModelFor(view('last-used'), 'muse')).toBeUndefined();
    expect(projectLastUsedModelFor(undefined, 'claude')).toBeUndefined();
  });
});
