import { describe, expect, test } from 'vitest';
import { jsStringLiteral } from '../browser-js-literal.js';

describe('jsStringLiteral', () => {
  const hostile = [
    '</script><script>alert(1)</script>',
    'line\u2028separator\u2029paragraph',
    '"; alert(1); "',
    "' + alert(1) + '",
    '\\u003C already escaped',
    'plain text',
  ];

  test.for(hostile)('evaluates back to exactly the input: %s', (value) => {
    const literal = jsStringLiteral(value);
    expect(new Function(`return ${literal};`)()).toBe(value);
  });

  test('leaves no character that can end the literal outside JavaScript', () => {
    const literal = jsStringLiteral(hostile.join(''));
    expect(literal).not.toMatch(/[<>/\u2028\u2029]/);
  });
});
