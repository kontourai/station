import { describe, expect, it } from 'vitest';
import {
  compareComponentStyle,
  inspectComponentStyle,
} from '../component-style-hygiene.mjs';

describe('component and style policy', () => {
  it('finds standard-action and dialog bypasses while allowing composite controls and canonical components', () => {
    expect(
      inspectComponentStyle(
        'panel.tsx',
        '<button className="item__action item--primary">Save</button>',
      ),
    ).toEqual([
      { kind: 'bespoke-action', key: '"item__action item--primary"' },
    ]);
    expect(inspectComponentStyle('panel.tsx', '<div role="dialog" />')).toEqual(
      [{ kind: 'bespoke-dialog', key: 'div' }],
    );
    for (const source of [
      '<dialog open />',
      '<div role={"dialog"} />',
      '<aside role={`alertdialog`} />',
    ]) {
      expect(inspectComponentStyle('panel.tsx', source)).toHaveLength(1);
    }
    expect(
      inspectComponentStyle(
        'panel.tsx',
        '<><button role="switch" className="toggle" /><Button variant="primary">Save</Button><Dialog title="Edit" /></>',
      ),
    ).toEqual([]);
    expect(
      inspectComponentStyle(
        'panel.tsx',
        'const example = \'<div role="dialog">\';',
      ),
    ).toEqual([]);
  });
  it('reports legacy token references, permits geometry and canonical tokens, and attributes growth per file and signature', () => {
    expect(
      inspectComponentStyle(
        'panel.css',
        '.item { padding: var(--space-4); color: var(--k-text); min-height: 44px; }',
      ),
    ).toEqual([{ kind: 'legacy-token', key: '--space-4' }]);
    expect(
      inspectComponentStyle(
        'panel.css',
        '/* var(--space-4) */ .item { content: "var(--space-4)"; padding: var(--k-space-4); }',
      ),
    ).toEqual([]);
    expect(
      compareComponentStyle(
        { 'old.css': { 'legacy-token:--space-4': 1 } },
        { 'old.css': { 'legacy-token:--space-4': 2 } },
      ),
    ).toEqual([]);
    expect(
      compareComponentStyle(
        { 'new.css': { 'legacy-token:--space-4': 1 } },
        { 'old.css': { 'legacy-token:--space-4': 1 } },
      ),
    ).toEqual([{ file: 'new.css', key: 'legacy-token:--space-4', added: 1 }]);
  });
  it('refuses malformed inventories instead of accepting missing debt limits', () => {
    for (const baseline of [
      null,
      [],
      { 'a.css': null },
      { 'a.css': { token: -1 } },
      { 'a.css': { token: '1' } },
    ]) {
      expect(() => compareComponentStyle({}, baseline)).toThrow();
    }
  });
});
