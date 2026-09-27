import { describe, expect, test } from 'vitest';
import { apiErrorMessage } from '../api-core';
import {
  envelopeDetailsMessage,
  envelopeError,
  envelopeMessage,
  envelopeReasons,
  readEnvelopeFailure,
} from '../client/api-error-message';
import {
  envelopeErrorCode,
  envelopeErrorMessage,
  StationHttpError,
} from '../client/http';

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

  test('names each field in the THROWN message, as the CLI does (#2708 M1)', () => {
    // The CLI's station#2871 shape: a thrown StationHttpError and the CLI
    // print one sentence, so an agent never reads two bare "Required"s.
    expect(
      envelopeMessage(
        {
          error: 'Validation failed',
          details: {
            formErrors: [],
            fieldErrors: { command: ['Required'], name: ['Required'] },
          },
        },
        'Update failed',
      ),
    ).toBe('Validation failed: command Required, name Required');
    expect(
      envelopeDetailsMessage({
        fieldErrors: { id: ['Too short', 'Bad characters'] },
      }),
    ).toBe('id Too short; Bad characters');
    expect(envelopeDetailsMessage({ fieldErrors: { id: [] } })).toBe(undefined);
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

  test("the SHOWN form carries no field keys and says each reason once (#2708 M1')", () => {
    const body = {
      error: 'Validation failed',
      details: {
        formErrors: [],
        fieldErrors: { command: ['Required'], secretEnvKey: ['Required'] },
      },
    };
    expect(apiErrorMessage(body, 'Update failed')).toBe('Required');
    expect(envelopeErrorMessage(body, 'Update failed')).toBe('Required');
    expect(envelopeReasons(body.details)).toEqual(['Required']);
    expect(envelopeMessage(body, 'Update failed')).toBe(
      'Validation failed: command Required, secretEnvKey Required',
    );
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

/**
 * #2708: one helper turns a failure envelope into the error a fetcher throws,
 * keeping everything the body said — status, the merged message rule, `code`,
 * `details` and `Retry-After`. These pin each field and each step of the
 * message order, because a helper that silently drops one is the defect it
 * replaces.
 */
describe('readEnvelopeFailure / envelopeError', () => {
  function response(status: number, headers: Record<string, string> = {}) {
    return new Response(null, { status, headers });
  }

  test('keeps the observed status, including a 2xx carrying success:false', () => {
    expect(readEnvelopeFailure(response(409), {}, 'fallback').status).toBe(409);
    const refused = envelopeError(
      response(200),
      { success: false, error: 'Not prepared', code: 'project-not-prepared' },
      'fallback',
    );
    expect(refused).toBeInstanceOf(StationHttpError);
    expect(refused.status).toBe(200);
    expect(refused.message).toBe('Not prepared');
    expect(refused.code).toBe('project-not-prepared');
  });

  test('reads the top-level code first, then the object error’s own code', () => {
    expect(
      readEnvelopeFailure(
        response(403),
        { error: { code: 'nested' }, code: 'top-level' },
        'fallback',
      ).code,
    ).toBe('top-level');
    expect(
      readEnvelopeFailure(
        response(401),
        { error: { code: 'authentication_required' } },
        'fallback',
      ).code,
    ).toBe('authentication_required');
    expect(
      envelopeError(
        response(401),
        { error: { code: 'authentication_required' } },
        'fallback',
      ).code,
    ).toBe('authentication_required');
  });

  test('a blank or non-string code is absent, never a default', () => {
    const failure = readEnvelopeFailure(
      response(500),
      { error: { code: 7 }, code: '   ' },
      'fallback',
    );
    expect(failure).not.toHaveProperty('code');
    expect(envelopeError(response(500), undefined, 'fallback').code).toBe(
      undefined,
    );
  });

  test('carries details exactly as sent', () => {
    const details = {
      formErrors: [],
      fieldErrors: { command: ['A command word is lowercase.'] },
    };
    const error = envelopeError(
      response(400),
      { success: false, error: 'Validation failed', details },
      'fallback',
    );
    expect(error.details).toEqual(details);
    expect(error.message).toBe(
      'Validation failed: command A command word is lowercase.',
    );
    // Non-validation details survive too: the structure is the caller's.
    expect(
      envelopeError(response(409), { error: 'x', details: ['a', 1] }, 'f')
        .details,
    ).toEqual(['a', 1]);
    expect(
      envelopeError(response(409), { error: 'x' }, 'f'),
    ).not.toHaveProperty('details');
  });

  test('reads Retry-After in delta-seconds, and nothing else', () => {
    expect(
      envelopeError(response(429, { 'Retry-After': '7' }), {}, 'f')
        .retryAfterMs,
    ).toBe(7000);
    expect(
      readEnvelopeFailure(response(429, { 'Retry-After': '1e3' }), {}, 'f'),
    ).not.toHaveProperty('retryAfterMs');
    // A bare object with no headers (test doubles, some native transports)
    // is "no Retry-After", not a crash that loses the failure.
    expect(readEnvelopeFailure({ status: 503 }, {}, 'f')).toEqual({
      status: 503,
      message: 'f',
    });
  });

  test('a fixed message withholds the server text but keeps status, code and Retry-After', () => {
    const error = envelopeError(
      new Response(null, { status: 404, headers: { 'Retry-After': '3' } }),
      {
        error: 'peer-supplied text',
        code: 'input_request_missing',
        details: { fieldErrors: { id: ['peer text'] } },
      },
      'fallback',
      { message: 'Input request unavailable' },
    );
    expect(error).toBeInstanceOf(StationHttpError);
    expect(error.message).toBe('Input request unavailable');
    expect(error).toMatchObject({
      status: 404,
      code: 'input_request_missing',
      retryAfterMs: 3000,
    });
    expect(error).not.toHaveProperty('details');
  });

  describe('message order', () => {
    const cases: Array<[string, unknown, string]> = [
      [
        'field-qualified details follow the summary',
        {
          error: 'Validation failed',
          message: 'top',
          details: {
            formErrors: ['Body is required'],
            fieldErrors: { a: ['Too long'] },
          },
        },
        'Validation failed: a Too long, Body is required',
      ],
      [
        'details with no summary follow the fallback',
        { details: { fieldErrors: { a: ['Too long'] } } },
        'fallback: a Too long',
      ],
      [
        'then a string error',
        { error: 'Read-only skill', message: 'top' },
        'Read-only skill',
      ],
      [
        'then the object error’s message',
        {
          error: { message: 'Sign in again', code: 'authentication_required' },
          message: 'top',
        },
        'Sign in again',
      ],
      [
        'then the object error’s code',
        { error: { code: 'authentication_required' }, message: 'top' },
        'authentication_required',
      ],
      ['then the top-level message', { error: '  ', message: 'Nope' }, 'Nope'],
      ['then the fallback', { error: { code: '' }, message: '' }, 'fallback'],
      ['a body that is not an object', 'plain text', 'fallback'],
      ['no body at all', undefined, 'fallback'],
      ['a JSON null body', null, 'fallback'],
    ];

    test.each(cases)('%s', (_label, body, expected) => {
      expect(envelopeMessage(body, 'fallback')).toBe(expected);
      expect(readEnvelopeFailure(response(500), body, 'fallback').message).toBe(
        expected,
      );
      // Without details the shown form is the same summary; with details it
      // is the reasons alone (pinned in the apiErrorMessage block above).
      const hasReasons =
        envelopeReasons((body as { details?: unknown } | null)?.details)
          .length > 0;
      if (!hasReasons) {
        expect(envelopeErrorMessage(body, 'fallback')).toBe(expected);
        expect(
          apiErrorMessage(
            body as Parameters<typeof apiErrorMessage>[0],
            'fallback',
          ),
        ).toBe(expected);
      }
    });
  });

  test('envelopeErrorCode is the same code rule', () => {
    expect(envelopeErrorCode({ error: { code: 'nested' } })).toBe('nested');
    expect(envelopeErrorCode({ code: 'top', error: { code: 'nested' } })).toBe(
      'top',
    );
    expect(envelopeErrorCode(undefined)).toBe(undefined);
  });
});

/**
 * #2708 moved `StationHttpError` into `client/api-error-message.ts` (to keep
 * the envelope rule and the error it builds out of an import cycle). Every
 * `instanceof StationHttpError` in the product depends on each public path
 * handing out the SAME constructor, so pin it.
 */
describe('StationHttpError identity', () => {
  test('http.ts, the client barrel and the package root export one constructor', async () => {
    const defining = await import('../client/api-error-message');
    const http = await import('../client/http');
    const clientBarrel = await import('../client/index');
    const root = await import('../index');
    expect(http.StationHttpError).toBe(defining.StationHttpError);
    expect(clientBarrel.StationHttpError).toBe(defining.StationHttpError);
    expect(root.StationHttpError).toBe(defining.StationHttpError);
    expect(
      envelopeError(new Response(null, { status: 403 }), {}, 'f'),
    ).toBeInstanceOf(root.StationHttpError);
  });
});
