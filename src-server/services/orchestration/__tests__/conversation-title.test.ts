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

  // The title is derived from prompts of any size, server-side. Repeated
  // unbalanced `[a](` used to make the link scan quadratic (10,000 repeats took
  // half a second, 400,000 never finished). The bound is structural: only the
  // first TITLE_SOURCE_MAX_CODE_POINTS are ever read, so a huge prompt derives
  // exactly what its head derives, in constant work.
  test.each([
    ['unbalanced links', '[a]('],
    ['unclosed labels', '['],
    ['bold openers', '**a '],
    ['parenthesised runs', '(((a '],
  ])(
    'a 400,000-repeat prompt of %s derives from its head only',
    (_name, unit) => {
      const prompt = unit.repeat(400_000);
      const head = Array.from(prompt)
        .slice(0, TITLE_SOURCE_MAX_CODE_POINTS)
        .join('');
      expect(derivedConversationTitle(prompt)).toBe(
        derivedConversationTitle(head),
      );
    },
  );

  test('a long prompt whose words start after the bound derives no title from them', () => {
    // The literal 1000, next to the constant it pins.
    expect(TITLE_SOURCE_MAX_CODE_POINTS).toBe(1000);
    expect(derivedConversationTitle(`${' '.repeat(1000)}late`)).toBeUndefined();
    expect(derivedConversationTitle(`${' '.repeat(999)}late`)).toBe('late');
  });

  test('the bound counts code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}'.repeat(TITLE_SOURCE_MAX_CODE_POINTS + 50);
    const title = derivedConversationTitle(emoji);
    expect(title?.endsWith('\u2026')).toBe(true);
    expect(Array.from(title ?? '')).toHaveLength(80);
  });
});
