import { describe, expect, test } from 'vitest';
import { ACPCommandNotFoundError } from '../acp-process.js';
import { engineFacingProbeMessage } from '../probe-messages.js';

/**
 * The reason a check failed is shown to people (setup dialog, engine card,
 * Retry check). It names the engine, says what happened in plain words, and
 * never says "ACP".
 */
const engine = { name: 'Kiro CLI', command: 'kiro-cli' };

function deadline(budgetMs: number) {
  return Object.assign(
    new Error(
      `ACP probe initialize did not settle within its ${budgetMs}ms share of the ${budgetMs}ms probe budget.`,
    ),
    { name: 'ACPProbeDeadlineError', budgetMs },
  );
}

describe('engineFacingProbeMessage', () => {
  test.each([
    [60_000, "Kiro CLI didn't answer within a minute."],
    [10_000, "Kiro CLI didn't answer within 10 seconds."],
    [120_000, "Kiro CLI didn't answer within 2 minutes."],
    [1_000, "Kiro CLI didn't answer within 1 second."],
  ])('a %ims time-out names the engine and the wait', (budgetMs, message) => {
    expect(engineFacingProbeMessage(deadline(budgetMs), engine)).toBe(message);
  });

  test('a closed connection is said plainly', () => {
    expect(
      engineFacingProbeMessage(new Error('ACP connection closed'), engine),
    ).toBe('Kiro CLI closed the connection before it finished starting.');
  });

  test('a command that cannot be run is said plainly', () => {
    expect(
      engineFacingProbeMessage(
        Object.assign(new Error('spawn /usr/bin/kiro-cli EACCES'), {
          code: 'EACCES',
          syscall: 'spawn /usr/bin/kiro-cli',
        }),
        engine,
      ),
    ).toBe(
      'Station could not run kiro-cli: it is not executable on the computer Station runs on. Make it executable, then check the engine again.',
    );
  });

  test('a missing command keeps its own sentence', () => {
    const error = new ACPCommandNotFoundError('kiro-cli');
    expect(engineFacingProbeMessage(error, engine)).toBe(error.message);
  });

  test('any other message loses the protocol name', () => {
    expect(
      engineFacingProbeMessage(
        new Error('ACP process exited with code 1'),
        engine,
      ),
    ).toBe('Kiro CLI: process exited with code 1');
  });

  // `node /tmp/x.mjs` in the command field is a program plus an argument,
  // not a missing program called that.
  test('a command with arguments in it says where arguments go', () => {
    const error = new ACPCommandNotFoundError('node /tmp/x.mjs');
    expect(error.message).toBe(
      'Station could not find a program named "node /tmp/x.mjs". If that includes arguments, put them in Advanced → Arguments and keep only the program in Command.',
    );
  });
});
