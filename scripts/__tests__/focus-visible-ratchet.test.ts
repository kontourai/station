import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findOutlineSuppressions,
  validateFocusOutlineInventory,
} from '../focus-visible-ratchet.mjs';

describe('focus-visible outline ratchet', () => {
  it('keeps every existing outline suppression explicitly inventoried', () => {
    expect(validateFocusOutlineInventory().total).toBeGreaterThan(30);
  });

  it('detects a newly introduced outline suppression', () => {
    expect(
      findOutlineSuppressions(
        '.new-control:focus { color: red; outline: none; }',
        'new.css',
      ),
    ).toEqual([{ path: 'new.css', selector: '.new-control:focus' }]);
  });

  it('keeps a global keyboard-focus floor over legacy component rules', () => {
    const css = readFileSync('src-ui/src/index.css', 'utf8');
    expect(css).toContain(':focus-visible');
    // The floor follows the accent, so a device accent colours it. Still 2px,
    // still !important. @kontourai/ui 1.16 always defines --k-focus, so the
    // focus role takes the ring only where something chose a focus colour: a
    // white-label theme (data-brand-focus, set by applyBrandingTheme) or a
    // Dev, Beta or Nightly build. branding-role-cascade.test.ts measures the
    // painted colours; this pins that both rules survive.
    expect(css).toContain(
      'outline: 2px solid var(--accent-primary) !important',
    );
    const focusRole = css.match(
      /:is\(([^{]*?)\)\s*:where\([^{]*?\):focus-visible\s*\{\s*outline-color: var\(--k-focus\) !important;\s*\}/,
    );
    expect(focusRole).not.toBeNull();
    const scopes = (focusRole?.[1] ?? '').split(',').map((s) => s.trim());
    expect(scopes).toEqual([
      ':root[data-brand-focus]',
      ':root.is-dev-build',
      ':root[data-app-channel="beta"]',
      ':root[data-app-channel="nightly"]',
    ]);
  });
});
