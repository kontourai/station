import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const headerStyles = readFileSync(
  path.resolve(import.meta.dirname, '../components/header/HeaderMenu.css'),
  'utf8',
);
const breadcrumbStyles = readFileSync(
  path.resolve(import.meta.dirname, '../components/header/PageBreadcrumb.css'),
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

  test('preserves breadcrumb text affordance without inherited button fill or rounded border', () => {
    const reset = /\.page-breadcrumb__link\s*\{([^}]*)\}/.exec(
      breadcrumbStyles,
    )?.[1];
    expect(reset, 'the .page-breadcrumb__link reset rule').toBeDefined();
    expect(reset).toContain('border: 0;');
    expect(reset).toContain('border-radius: 0;');
    expect(reset).toContain('background: transparent;');
    const interactive =
      /\.page-breadcrumb__link:hover,[^}]*\.page-breadcrumb__link:focus,[^}]*\.page-breadcrumb__link:focus-visible\s*\{([^}]*)\}/.exec(
        breadcrumbStyles,
      )?.[1];
    expect(
      interactive,
      'the breadcrumb hover/focus/focus-visible rule',
    ).toBeDefined();
    expect(interactive).toContain('border-color: transparent;');
    expect(interactive).toContain('background: transparent;');
    // The visible-focus ring belongs to the focus-visible rule itself, not to
    // "somewhere in this sheet".
    // Anchored on a rule boundary: the multi-selector rule above ends its
    // selector list with this same string, and an unanchored match picks that
    // body (which carries no outline) instead of this rule's. The boundary is
    // a preceding `}` OR the start of the file, and an intervening CSS comment
    // is tolerated -- `^` deliberately without the `m` flag, because a
    // line-start anchor would match the selector-list line and reintroduce the
    // wrong body.
    const focusVisible =
      /(?:^|\})\s*(?:\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/\s*)*\.page-breadcrumb__link:focus-visible\s*\{([^}]*)\}/.exec(
        breadcrumbStyles,
      )?.[1];
    expect(
      focusVisible,
      'the .page-breadcrumb__link:focus-visible rule',
    ).toBeDefined();
    expect(focusVisible).toContain('outline: 1px solid var(--accent-primary)');
  });
});
