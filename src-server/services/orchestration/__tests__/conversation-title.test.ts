import { describe, expect, test } from 'vitest';
import {
  derivedConversationTitle,
  TITLE_SOURCE_MAX_CODE_POINTS,
} from '../conversation-title.js';

describe('derivedConversationTitle', () => {
  test.each([
    // Identifiers and maths keep every character: a title is written once.
    [
      'rename user_id to account_id in db_schema.ts',
      'rename user_id to account_id in db_schema.ts',
    ],
    ['fix __init__.py import', 'fix __init__.py import'],
    ['compute 2*3*4 please', 'compute 2*3*4 please'],
    // Paired markdown markers become their content.
    ['Run `ls -la` now', 'Run ls -la now'],
    ['a **bold** b', 'a bold b'],
    ['a __strong__ b', 'a strong b'],
    ['a *em* b', 'a em b'],
    ['a _em_ b', 'a em b'],
    ['a ~~old~~ b', 'a old b'],
    ['see [the docs](https://example.com)', 'see the docs'],
    // A destination may hold balanced parentheses: the link ends at the `)`
    // that balances its `(`, not at the first one (which left a stray `)`).
    ['[docs (v2)](https://x.com/a_(b))', 'docs (v2)'],
    [
      'read [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) first',
      'read Foo first',
    ],
    ['![shot (1)](a_(b).png) here', 'shot (1) here'],
    ['[a](u_(b_(c))) tail', 'a tail'],
    // Two links keep each its own label; parentheses outside a link are text.
    ['[a](x_(1)) and [b](y) (note)', 'a and b (note)'],
    // An unbalanced destination ends at its first `)`, as it always did.
    ['[x](http://a.com/foo(bar) tail', 'x tail'],
    // A destination with a title keeps ending at its first `)`, and a later
    // `)` after a space is text, never swallowed by an unbalanced scan.
    ['[x](u(b) and (later) text)', 'x and (later) text)'],
    ['[x](https://a.com/p "A title") tail', 'x tail'],
    // Not a link: no destination, or no closing parenthesis at all.
    ['[x] (y)', '[x] (y)'],
    ['[x](never closes', '[x](never closes'],
    ['# Heading here', 'Heading here'],
    ['* list item', 'list item'],
    ['- list item', 'list item'],
  ])('%s', (input, expected) => {
    expect(derivedConversationTitle(input)).toBe(expected);
  });

  test('no words means no derived title', () => {
    expect(derivedConversationTitle('   ')).toBeUndefined();
    expect(derivedConversationTitle(undefined)).toBeUndefined();
  });

  // Structural bound, checked on small inputs so a removed bound FAILS fast
  // instead of hanging in the quadratic scans: bold that opens inside the first
  // TITLE_SOURCE_MAX_CODE_POINTS and closes beyond them is read as unpaired.
  // Without the cut the pair would be stripped and the title would not start
  // with the markers.
  test('markup that closes beyond the bound does not influence the title', () => {
    expect(TITLE_SOURCE_MAX_CODE_POINTS).toBe(1000);
    const title = derivedConversationTitle(`**${'a'.repeat(1100)}**`);
    expect(title?.startsWith('**aaa')).toBe(true);
  });

  test('content after the bound is never read', () => {
    const head = 'word '.repeat(200); // exactly 1000 code points
    expect(Array.from(head)).toHaveLength(1000);
    expect(derivedConversationTitle(`${head}[x](`)).toBe(
      derivedConversationTitle(`${head}anything else entirely`),
    );
  });

  // The title is derived from prompts of any size, server-side. Repeated
  // unbalanced `[a](` used to make the link scan quadratic (10,000 repeats took
  // half a second, 400,000 never finished). Timing-free: this only checks the
  // result matches the head's, at a size where a missing bound is slow rather
  // than endless.
  test.each([
    ['unbalanced links', '[a]('],
    ['unclosed labels', '['],
    ['bold openers', '**a '],
    ['parenthesised runs', '(((a '],
  ])('a 20,000-repeat prompt of %s derives from its head only', (_n, unit) => {
    const prompt = unit.repeat(20_000);
    const head = Array.from(prompt)
      .slice(0, TITLE_SOURCE_MAX_CODE_POINTS)
      .join('');
    expect(derivedConversationTitle(prompt)).toBe(
      derivedConversationTitle(head),
    );
  });

  test('leading whitespace does not spend the budget', () => {
    expect(derivedConversationTitle(`${'\n'.repeat(1500)}fix the bug`)).toBe(
      'fix the bug',
    );
    expect(derivedConversationTitle(`${' '.repeat(1001)}fix`)).toBe('fix');
    expect(derivedConversationTitle(`${' '.repeat(5000)}late`)).toBe('late');
  });

  test('a long prompt whose words start after 1000 non-whitespace code points derives from the head', () => {
    // 1000 code points of punctuation-free filler, then words: only the filler
    // is read, so the title is cut from it, not from the late words.
    const title = derivedConversationTitle(`${'x'.repeat(1000)} late`);
    expect(title?.includes('late')).toBe(false);
  });

  test('the bound counts code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}'.repeat(TITLE_SOURCE_MAX_CODE_POINTS + 50);
    const title = derivedConversationTitle(emoji);
    expect(title?.endsWith('\u2026')).toBe(true);
    expect(Array.from(title ?? '')).toHaveLength(80);
  });
});
