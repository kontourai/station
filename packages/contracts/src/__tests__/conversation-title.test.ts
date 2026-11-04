import { describe, expect, test } from 'vitest';
import { isLowContentPrompt } from '../conversation-title.js';

describe('isLowContentPrompt', () => {
  test.each([
    'Continue',
    'continue.',
    '  CONTINUE!!  ',
    'go on',
    'Ok',
    'okay',
    'OK, go ahead!',
    'yes',
    'yes please',
    'proceed',
    'retry',
    'try again',
    'keep going',
    'next',
    'do it',
    'sure',
    'thanks',
    "let's continue",
    '👍',
    '...',
    '',
    'Continue the task from where it stopped.',
  ])('%j says nothing a title could name', (prompt) => {
    expect(isLowContentPrompt(prompt)).toBe(true);
  });

  test.each([
    'Fix dock header',
    'Fix the dock header',
    'Deploy staging',
    'Fix login',
    'hi, why does the build fail?',
    'continue the migration to pnpm',
    'Continue the task from where it stopped and add tests',
  ])('%j is content, however short', (prompt) => {
    expect(isLowContentPrompt(prompt)).toBe(false);
  });

  test('an absent prompt is low-content', () => {
    expect(isLowContentPrompt(undefined)).toBe(true);
  });
});
