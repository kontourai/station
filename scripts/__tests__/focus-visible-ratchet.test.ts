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
    expect(css).toContain(
      'outline: 2px solid var(--accent-primary) !important',
    );
  });
});
