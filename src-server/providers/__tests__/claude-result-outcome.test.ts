import { describe, expect, test } from 'vitest';
import {
  classifyClaudeResultOutcome,
  claudeResultFailureText,
} from '../adapters/claude-result-outcome.js';

describe('station#1827 — classifyClaudeResultOutcome', () => {
  test('classifies a normal completed result as ok', () => {
    expect(
      classifyClaudeResultOutcome({ type: 'result', is_error: false }),
    ).toBe('ok');
  });

  test('classifies an error flag without binding evidence as a failed turn', () => {
    // The success-shaped SDK result can also carry a refusal or other failure.
    expect(
      classifyClaudeResultOutcome({ type: 'result', is_error: true }),
    ).toBe('failed');
  });

  test('does not infer a dead binding from an error flag alone', () => {
    // A message whose text looks benign but is flagged is_error is still
    // failed; a message whose text looks alarming but is not flagged
    // is_error is still ok. The classifier reads only the structured flag.
    expect(
      classifyClaudeResultOutcome({
        type: 'result',
        is_error: true,
      } as any),
    ).toBe('failed');
  });
});

describe('station#1827 — claudeResultFailureText', () => {
  test('prefers the SDKResultSuccess result field', () => {
    expect(
      claudeResultFailureText({
        result: 'No conversation found with session ID: dead-id',
      }),
    ).toBe('No conversation found with session ID: dead-id');
  });

  test('falls back to joined SDKResultError errors when result is absent', () => {
    expect(
      claudeResultFailureText({
        errors: ['first problem', 'second problem'],
      }),
    ).toBe('first problem; second problem');
  });

  test('falls back to a bounded honest message when neither field is usable', () => {
    expect(claudeResultFailureText({})).toBe(
      'The engine ended this turn with an error.',
    );
    expect(claudeResultFailureText({ result: '   ', errors: [] })).toBe(
      'The engine ended this turn with an error.',
    );
  });
});

test('only an exact missing-session diagnostic for the attempted cursor disproves that binding', () => {
  const cursor = 'native-session-known';
  const result = {
    type: 'result' as const,
    is_error: true,
    result: `No conversation found with session ID: ${cursor}`,
  };
  expect(classifyClaudeResultOutcome(result, cursor)).toBe('binding-dead');
  expect(
    classifyClaudeResultOutcome(
      { ...result, result: undefined, errors: [result.result] },
      cursor,
    ),
  ).toBe('binding-dead');
  expect(classifyClaudeResultOutcome(result)).toBe('failed');
  expect(classifyClaudeResultOutcome(result, 'different-cursor')).toBe(
    'failed',
  );
  expect(
    classifyClaudeResultOutcome(
      { ...result, result: `Quoted diagnostic: ${result.result}` },
      cursor,
    ),
  ).toBe('failed');
  expect(
    classifyClaudeResultOutcome({ ...result, is_error: false }, cursor),
  ).toBe('ok');
});

test('a real provider-safeguard error does not imply a lost native binding', () => {
  expect(
    classifyClaudeResultOutcome(
      {
        type: 'result',
        is_error: true,
        result:
          "API Error: Opus 5 (1M context)'s safeguards flagged this message. Details: [reasoning_extraction]",
      },
      'existing-session',
    ),
  ).toBe('failed');
});
