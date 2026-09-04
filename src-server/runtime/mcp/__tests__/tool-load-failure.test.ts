import { describe, expect, test } from 'vitest';
import {
  StationOwnedToolServerError,
  ToolServerOperationError,
} from '../../../services/plugins/tool-server-oauth.js';
import {
  describeLoaderFailure,
  isLoaderMessageDataDerived,
  isLoaderProgrammingFailure,
  LOADER_FAILURE_DETAIL_LIMIT,
  loaderErrorClass,
  loaderFailureLabel,
} from '../tool-load-failure.js';

/**
 * These cover the pure classification only. The decision that matters in
 * production is TWO-part — phase AND class — and the phase half lives in the
 * loaders, so the seam that actually reports a failure is exercised through
 * `loadAgentTools` in mcp-manager.test.ts. This file pins the vocabulary those
 * loaders share (#1486), including the arms an integration test can only reach
 * one at a time.
 */
describe('shared tool-load failure classification', () => {
  test('names the class of an Error and the type of a thrown non-Error', () => {
    expect(loaderErrorClass(new TypeError('x'))).toBe('TypeError');
    expect(
      loaderErrorClass(
        Object.assign(new Error('x'), { name: 'AssertionError' }),
      ),
    ).toBe('AssertionError');
    expect(loaderErrorClass('boom')).toBe('non-error:string');
    expect(loaderFailureLabel('boom')).toBe('Non-Error thrown (string)');
    expect(loaderFailureLabel(new RangeError('x'))).toBe('RangeError');
  });

  test('escapes redaction only for runtime program-defect classes and non-Errors', () => {
    for (const error of [
      new TypeError('x'),
      new ReferenceError('x'),
      new RangeError('x'),
      new EvalError('x'),
      new URIError('x'),
      new SyntaxError('x'),
      Object.assign(new Error('x'), {
        name: 'AssertionError',
        code: 'ERR_ASSERTION',
      }),
      // Node's assert throws with the code but tests sometimes see only one of
      // the two markers; either alone is enough.
      Object.assign(new Error('x'), { code: 'ERR_ASSERTION' }),
      'thrown string',
      undefined,
      { reason: 'thrown object' },
    ]) {
      expect({
        error: loaderErrorClass(error),
        escapes: isLoaderProgrammingFailure(error),
      }).toEqual({ error: loaderErrorClass(error), escapes: true });
    }

    for (const error of [
      new Error('load failed'),
      new ToolServerOperationError('connect'),
      new StationOwnedToolServerError('policy refused'),
      // A DOMException-style custom class is not a runtime program defect.
      Object.assign(new Error('x'), { name: 'AbortError' }),
    ]) {
      expect({
        error: loaderErrorClass(error),
        escapes: isLoaderProgrammingFailure(error),
      }).toEqual({ error: loaderErrorClass(error), escapes: false });
    }
  });

  test('withholds the message of classes whose text is composed from the data examined', () => {
    expect(isLoaderMessageDataDerived(new SyntaxError('x'))).toBe(true);
    expect(
      isLoaderMessageDataDerived(
        Object.assign(new Error('x'), { name: 'AssertionError' }),
      ),
    ).toBe(true);
    expect(
      isLoaderMessageDataDerived(
        Object.assign(new Error('x'), { code: 'ERR_ASSERTION' }),
      ),
    ).toBe(true);
    expect(isLoaderMessageDataDerived('thrown string')).toBe(true);

    expect(isLoaderMessageDataDerived(new TypeError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new ReferenceError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new RangeError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new EvalError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new URIError('x'))).toBe(false);
  });

  test('surfaces class and message for a program-text class', () => {
    expect(
      describeLoaderFailure(new TypeError('opts.acquire is not a function')),
    ).toEqual({
      detail: 'TypeError: opts.acquire is not a function',
      messageWithheld: false,
    });
    // An Error with no message still names its class rather than trailing a
    // bare colon.
    expect(describeLoaderFailure(new RangeError(''))).toEqual({
      detail: 'RangeError',
      messageWithheld: false,
    });
  });

  test('surfaces class alone for a data-derived message, dropping the text', () => {
    const secret = 'sekr';
    let parsed: SyntaxError | undefined;
    try {
      JSON.parse(`{"pad":"${'a'.repeat(30)}","TOKEN":"${secret}","b":x}`);
    } catch (error) {
      parsed = error as SyntaxError;
    }
    // Not hypothetical: V8 composes the message from a window of the parsed
    // source, so it quotes the stored value verbatim.
    expect(parsed?.message).toContain(`"${secret}"`);

    const report = describeLoaderFailure(parsed);
    expect(report).toEqual({ detail: 'SyntaxError', messageWithheld: true });
    expect(report.detail).not.toContain(secret);

    expect(describeLoaderFailure('raw-thrown-value')).toEqual({
      detail: 'Non-Error thrown (string)',
      messageWithheld: true,
    });
  });

  test('flattens control and format characters and bounds the detail to the total limit', () => {
    // U+200B is a format character (Cf): invisible in a status field, but a
    // separator once flattened.
    const flattened = describeLoaderFailure(
      new TypeError('head\nline\ttwo\u200Bthree'),
    );
    expect(flattened.detail).toBe('TypeError: head line two three');
    expect(/[\p{Cc}\p{Cf}]/u.test(flattened.detail)).toBe(false);

    const bounded = describeLoaderFailure(new RangeError('x'.repeat(500)));
    expect(bounded.detail).toHaveLength(LOADER_FAILURE_DETAIL_LIMIT);
    expect(bounded.detail.startsWith('RangeError: xxx')).toBe(true);
    expect(bounded.detail.endsWith('… (truncated)')).toBe(true);

    // A detail exactly at the limit is not marked truncated.
    const exact = describeLoaderFailure(
      new RangeError(
        'x'.repeat(LOADER_FAILURE_DETAIL_LIMIT - 'RangeError: '.length),
      ),
    );
    expect(exact.detail).toHaveLength(LOADER_FAILURE_DETAIL_LIMIT);
    expect(exact.detail).not.toContain('truncated');
  });
});
