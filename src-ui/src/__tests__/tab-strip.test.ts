import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('the shared tab strip remains one scrollable row on mobile', () => {
  const css = readFileSync(resolve('src-ui/src/views/page-layout.css'), 'utf8');
  expect(css).toContain('@media (max-width: 768px), (pointer: coarse)');
  expect(css).toContain('.page__tabs.tab-strip--scroll');
  expect(css).toContain('flex-wrap: nowrap');
  expect(css).toContain('overflow-x: auto');
});
