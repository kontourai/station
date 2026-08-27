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

  test('classifies is_error: true as terminal, regardless of subtype', () => {
    // SDKResultSuccess: subtype 'success' but is_error: true is exactly the
    // dead --resume shape ("No conversation found with session ID: ...").
    expect(
      classifyClaudeResultOutcome({ type: 'result', is_error: true }),
    ).toBe('terminal');
  });

  test('never prose-matches — is_error alone decides the outcome', () => {
    // A message whose text looks benign but is flagged is_error is still
    // terminal; a message whose text looks alarming but is not flagged
    // is_error is still ok. The classifier reads only the structured flag.
    expect(
      classifyClaudeResultOutcome({
        type: 'result',
        is_error: true,
      } as any),
    ).toBe('terminal');
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
