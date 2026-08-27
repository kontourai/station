import { describe, expect, test } from 'vitest';
import { apiErrorMessage } from '../api-core';

/**
 * station#3737: the shared zod middleware answers a rejected body with
 * `{ error: 'Validation failed', details: { fieldErrors } }`. A caller reading
 * `result.error` alone can only show "Validation failed", so a skill save
 * refused for an untypable command word reached the editor with nothing to
 * say — the sentence naming the broken rule was in `details` the whole time.
 */
describe('apiErrorMessage', () => {
  test('says what the server said, not that something failed', () => {
    expect(
      apiErrorMessage(
        {
          error: 'Validation failed',
          details: {
            formErrors: [],
            fieldErrors: {
              command: [
                'A command word is lowercase letters, digits and dashes — the text typed after "/".',
              ],
            },
          },
        },
        'Update failed',
      ),
    ).toBe(
      'A command word is lowercase letters, digits and dashes — the text typed after "/".',
    );
  });

  test('carries every broken rule, form-level ones included', () => {
    expect(
      apiErrorMessage(
        {
          error: 'Validation failed',
          details: {
            formErrors: ['Body is required'],
            fieldErrors: { name: ['Too long'], command: ['Bad word'] },
          },
        },
        'Update failed',
      ),
    ).toBe('Body is required Too long Bad word');
  });

  test('falls back to the envelope, then to the caller, and never to noise', () => {
    expect(apiErrorMessage({ error: 'Read-only skill' }, 'Update failed')).toBe(
      'Read-only skill',
    );
    expect(apiErrorMessage({ message: 'Nope' }, 'Update failed')).toBe('Nope');
    expect(apiErrorMessage({}, 'Update failed')).toBe('Update failed');
    expect(
      apiErrorMessage(
        { error: '   ', details: { fieldErrors: { a: ['  '] } } },
        'Update failed',
      ),
    ).toBe('Update failed');
  });
});
