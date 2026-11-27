import { describe, expect, test } from 'vitest';
import { interruptedWorkRecoveryNote } from '../interrupted-work-recovery.js';

const completed = (toolCallId: string, status: string, toolName = 'Task') => ({
  payload: { method: 'tool.completed', toolCallId, toolName, status },
});
const started = (toolCallId: string, args: Record<string, unknown>) => ({
  method: 'tool.started',
  toolCallId,
  toolName: 'Task (general-purpose)',
  arguments: args,
});

describe('interruptedWorkRecoveryNote', () => {
  test('names each call the ended engine left unresolved, by its newest start', () => {
    const note = interruptedWorkRecoveryNote(
      [
        completed('toolu-done', 'success'),
        completed('toolu-lane', 'unresolved'),
        completed('toolu-bash', 'unresolved', 'Bash'),
      ],
      [
        started('toolu-lane', { description: 'Lane 1' }),
        // The same call started again (a woken subagent): its newest start.
        started('toolu-lane', { description: 'Lane 2: palette entry #4694' }),
        started('toolu-bash', { command: 'npm run test:e2e' }),
        started('toolu-done', { description: 'Finished work' }),
      ],
    );
    expect(note).toContain('## Station recovery note');
    expect(note).toContain('no completion notice for it will arrive');
    expect(note).toContain('Do not report this work as still running');
    expect(note).toContain('- `Lane 2: palette entry #4694`');
    expect(note).toContain('- `npm run test:e2e`');
    expect(note).not.toContain('Lane 1');
    expect(note).not.toContain('Finished work');
  });

  test('a call whose unresolved terminal was corrected by a later real one is left out', () => {
    expect(
      interruptedWorkRecoveryNote(
        [
          completed('toolu-late', 'unresolved'),
          completed('toolu-late', 'success'),
        ],
        [started('toolu-late', { description: 'Drained after the stop' })],
      ),
    ).toBeUndefined();
  });

  test('without a recorded start the call is named by its tool', () => {
    expect(
      interruptedWorkRecoveryNote(
        [completed('toolu-orphan', 'unresolved')],
        [],
      ),
    ).toContain('- `Task`');
  });

  test('nothing unresolved composes no note', () => {
    expect(
      interruptedWorkRecoveryNote([completed('toolu-ok', 'success')], []),
    ).toBeUndefined();
  });
});
