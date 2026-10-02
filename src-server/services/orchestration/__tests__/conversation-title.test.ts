import { describe, expect, test } from 'vitest';
import { derivedConversationTitle } from '../conversation-title.js';

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
});
