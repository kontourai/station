import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const headerStyles = readFileSync(
  path.resolve(import.meta.dirname, '../components/header/HeaderMenu.css'),
  'utf8',
);
describe('header button visual resets', () => {
  test('keeps full-viewport menu dismissal buttons free of global button chrome', () => {
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop\s*\{[\s\S]*appearance:\s*none;[\s\S]*border:\s*0;[\s\S]*border-radius:\s*0;[\s\S]*padding:\s*0;[\s\S]*background:\s*transparent;/,
    );
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop:hover,[\s\S]*\.header-menu__dismiss-backdrop:focus,[\s\S]*\.header-menu__dismiss-backdrop:focus-visible\s*\{[\s\S]*background:\s*transparent;[\s\S]*border-color:\s*transparent;/,
    );
  });
});
