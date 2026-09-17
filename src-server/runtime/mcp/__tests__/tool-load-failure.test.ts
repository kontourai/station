import assert from 'node:assert';
import { describe, expect, test } from 'vitest';
import {
  StationOwnedToolServerError,
  ToolServerOperationError,
} from '../../../services/plugins/tool-server-oauth.js';
import {
  describeLoaderFailure,
  isLoaderMessageDataDerived,
  isLoaderProgrammingFailure,
  LOADER_FAILURE_CLASS_LIMIT,
  LOADER_FAILURE_DETAIL_LIMIT,
  LOADER_WITHHELD_STATUS_REASON,
  loaderErrorClass,
  loaderErrorName,
  loaderFailureLabel,
  loaderStackFrames,
} from '../tool-load-failure.js';

/**
 * These cover the pure classification only. The decision that matters in
 * production is TWO-part — phase AND class — and the phase half lives in the
 * loaders, so the seam that actually reports a failure is exercised through
 * `loadAgentTools` in mcp-manager.test.ts. This file pins the vocabulary
 * (#1486), including the arms an integration test can only reach one at a time.
 */
describe('shared tool-load failure classification', () => {
  test('separates the raw name used for matching from the bounded display class', () => {
    expect(loaderErrorName(new TypeError('x'))).toBe('TypeError');
    expect(loaderErrorClass(new TypeError('x'))).toBe('TypeError');
    // A non-Error has no name to match on; only the display form describes it.
    expect(loaderErrorName('boom')).toBe('');
    expect(loaderErrorClass('boom')).toBe('non-error:string');
    expect(loaderFailureLabel('boom')).toBe('Non-Error thrown (string)');

    // `name` is a writable own property, so the DISPLAY form is flattened and
    // bounded like any other surfaced text — while the RAW form, which the
    // decision sets look up, is left exactly as thrown. Bounding the matching
    // form would silently stop it matching a set entry.
    const hostile = Object.assign(new Error('m'), {
      name: `Evil\nName ${'x'.repeat(200)}`,
    });
    expect(loaderErrorName(hostile)).toBe(hostile.name);
    const displayed = loaderErrorClass(hostile);
    expect(displayed).toHaveLength(LOADER_FAILURE_CLASS_LIMIT);
    expect(displayed.endsWith('… (truncated)')).toBe(true);
    expect(displayed.startsWith('Evil Name ')).toBe(true);
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(displayed)).toBe(false);
  });

  test('escapes redaction only for runtime program-defect classes, Node validation codes, and non-Errors', () => {
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
      // Node's own argument validation rides on plain TypeError/RangeError and
      // is invisible to the NAME set — these must escape by CODE.
      Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' }),
      Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_VALUE' }),
      Object.assign(new RangeError('x'), { code: 'ERR_OUT_OF_RANGE' }),
      // A code-only carrier whose class says nothing still escapes.
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
      // A non-string code is not a code.
      Object.assign(new Error('x'), { code: 42 }),
    ]) {
      expect({
        error: loaderErrorClass(error),
        escapes: isLoaderProgrammingFailure(error),
      }).toEqual({ error: loaderErrorClass(error), escapes: false });
    }
  });

  test('withholds the message of classes AND codes whose text is composed from the data examined', () => {
    expect(isLoaderMessageDataDerived(new SyntaxError('x'))).toBe(true);
    expect(
      isLoaderMessageDataDerived(
        Object.assign(new Error('x'), { name: 'AssertionError' }),
      ),
    ).toBe(true);
    for (const code of [
      'ERR_ASSERTION',
      'ERR_INVALID_ARG_TYPE',
      'ERR_INVALID_ARG_VALUE',
      'ERR_OUT_OF_RANGE',
    ]) {
      expect(
        isLoaderMessageDataDerived(Object.assign(new TypeError('x'), { code })),
      ).toBe(true);
    }
    expect(isLoaderMessageDataDerived('thrown string')).toBe(true);

    expect(isLoaderMessageDataDerived(new TypeError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new ReferenceError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new RangeError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new EvalError('x'))).toBe(false);
    expect(isLoaderMessageDataDerived(new URIError('x'))).toBe(false);
  });

  test("withholds a real Node argument-validation TypeError's inspected value", () => {
    // The live shape the CODE set exists for, produced by Node rather than
    // hand-built: argument validation embeds util.inspect of the value it
    // rejected into the message of an ORDINARY TypeError. `name` is
    // 'TypeError', which the name set waves straight through — only the code
    // distinguishes it, and without that the value would be surfaced.
    const canary = 987654321;
    let thrown: unknown;
    try {
      Buffer.from(canary as unknown as string);
    } catch (error) {
      thrown = error;
    }
    expect(loaderErrorName(thrown)).toBe('TypeError');
    expect((thrown as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    expect((thrown as Error).message).toContain(String(canary));

    const report = describeLoaderFailure(thrown);
    expect(report).toEqual({
      detail: `${LOADER_WITHHELD_STATUS_REASON} (TypeError)`,
      messageWithheld: true,
    });
    expect(report.detail).not.toContain(String(canary));
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

  test('surfaces the withheld reason and class alone for a data-derived message', () => {
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
    expect(report).toEqual({
      detail: `${LOADER_WITHHELD_STATUS_REASON} (SyntaxError)`,
      messageWithheld: true,
    });
    expect(report.detail).not.toContain(secret);

    expect(describeLoaderFailure('raw-thrown-value')).toEqual({
      detail: `${LOADER_WITHHELD_STATUS_REASON} (Non-Error thrown (string))`,
      messageWithheld: true,
    });
  });

  test('flattens controls, format and separator characters, and bounds the detail to the total limit', () => {
    // U+200B is a format character (Cf) and U+2028 a LINE separator (Zl):
    // invisible or layout-breaking in a status field, separators once
    // flattened. Zl/Zp are not Cc/Cf and need their own classes in the regex.
    const flattened = describeLoaderFailure(
      new TypeError('head\nline\ttwo​three four five'),
    );
    expect(flattened.detail).toBe('TypeError: head line two three four five');
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(flattened.detail)).toBe(false);

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

  test('keeps only frame-shaped stack lines the multi-line message does not itself contain', () => {
    const canary = 'assertion-actual-canary';
    let thrown: Error | undefined;
    try {
      assert.strictEqual(canary, 'expected-value');
    } catch (error) {
      thrown = error as Error;
    }
    // A real AssertionError message spans several lines, so `slice(1)` on the
    // stack would leak the rest of it.
    expect(thrown?.message.split('\n').length).toBeGreaterThan(1);
    expect(thrown?.message).toContain(canary);

    const frames = loaderStackFrames(thrown);
    expect(frames?.length).toBeGreaterThan(0);
    expect(frames?.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(frames?.join('\n')).not.toContain(canary);

    // A message that embeds a frame-shaped line cannot smuggle it through.
    const smuggler = new SyntaxError('leaked\n    at SECRET (file.js:1:1)');
    smuggler.stack = `SyntaxError: ${smuggler.message}\n    at real (real.js:2:2)`;
    expect(loaderStackFrames(smuggler)).toEqual(['at real (real.js:2:2)']);

    expect(loaderStackFrames('not an error')).toBeUndefined();
    const stackless = new TypeError('x');
    stackless.stack = undefined;
    expect(loaderStackFrames(stackless)).toBeUndefined();
  });
});
