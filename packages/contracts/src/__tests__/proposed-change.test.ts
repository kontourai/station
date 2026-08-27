import {
  canTransitionProposedChangeStatus,
  type ProposedChange,
  validateProposedChange,
} from '../proposed-change';

describe('ProposedChange contract', () => {
  test('validates a canonical pending change', () => {
    const now = new Date().toISOString();
    const change: ProposedChange = {
      id: 'change-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      path: 'src/index.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'export const value = 1;' },
      proposedSnapshot: { content: 'export const value = 2;' },
      createdAt: now,
      updatedAt: now,
      sourceRuntime: 'codex',
      status: 'pending',
      decisions: [],
    };

    expect(validateProposedChange(change)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test('rejects malformed proposals', () => {
    const result = validateProposedChange({
      id: '',
      sessionId: '',
      projectId: 'project-1',
      path: '',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: null },
      proposedSnapshot: { content: 'next' },
      createdAt: 'not-a-date',
      updatedAt: new Date().toISOString(),
      sourceRuntime: '',
      status: 'pending',
      decisions: [],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'id is required',
        'sessionId is required',
        'path is required',
        'sourceRuntime is required',
        'createdAt must be a valid ISO date',
      ]),
    );
  });

  test('only pending proposals can move into terminal review statuses', () => {
    expect(canTransitionProposedChangeStatus('pending', 'approved')).toBe(true);
    expect(canTransitionProposedChangeStatus('pending', 'rejected')).toBe(true);
    expect(canTransitionProposedChangeStatus('pending', 'superseded')).toBe(
      true,
    );
    expect(canTransitionProposedChangeStatus('approved', 'rejected')).toBe(
      false,
    );
    expect(canTransitionProposedChangeStatus('rejected', 'pending')).toBe(
      false,
    );
  });
});
