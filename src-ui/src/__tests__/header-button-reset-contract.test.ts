import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const headerStyles = readFileSync(
  path.resolve(import.meta.dirname, '../components/header/HeaderMenu.css'),
  'utf8',
);
// Every pattern below is bounded to ONE rule body (`[^}]*` cannot cross a
// closing brace). The `[\s\S]*` these replaced spanned the whole sheet, so a
// declaration that had drifted OUT of the reset rule into any later rule still
// satisfied them -- which is the only thing the assertions are here to notice.

describe('header button visual resets', () => {
  test('keeps full-viewport menu dismissal buttons free of global button chrome', () => {
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop\s*\{[^}]*appearance:\s*none;[^}]*\}/,
    );
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop\s*\{[^}]*border:\s*0;[^}]*\}/,
    );
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop\s*\{[^}]*border-radius:\s*0;[^}]*\}/,
    );
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop\s*\{[^}]*padding:\s*0;[^}]*\}/,
    );
    expect(headerStyles).toMatch(
      /\.header-menu__dismiss-backdrop\s*\{[^}]*background:\s*transparent;[^}]*\}/,
    );
    const interactive =
      /\.header-menu__dismiss-backdrop:hover,[^}]*\.header-menu__dismiss-backdrop:focus,[^}]*\.header-menu__dismiss-backdrop:focus-visible\s*\{([^}]*)\}/.exec(
        headerStyles,
      )?.[1];
    expect(
      interactive,
      'the backdrop hover/focus/focus-visible rule',
    ).toBeDefined();
    expect(interactive).toContain('background: transparent;');
    expect(interactive).toContain('border-color: transparent;');
  });
});
