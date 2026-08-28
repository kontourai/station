import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';

/**
 * Chrome stacking is one declared scale (tokens.css `--layer-*`), not a
 * per-surface arms race. When it was, the deferred-capability notice sat at a
 * literal 1200 over the chat dock's 100 (archive#2213), and 45 chrome-scale
 * raw values had accumulated across 20 files (archive#2558).
 *
 * Small values (< 100) are local stacking inside a component and stay free.
 * Chrome-scale values (>= 100) must be tokens — except the checked-in
 * baseline below, which lists surviving raw sites BY OCCURRENCE, not by
 * count: a count ratchet bills whoever gates next, an occurrence list names
 * exactly what changed. Shrink it; never grow it.
 */

const UI_SRC = join(__dirname, '..');

/**
 * Deliberately-ordered families whose internal offsets are not yet expressed
 * in the token scale. Each entry is here for a reason:
 * The dock launcher band and nested new-chat model picker use local values
 * below 100 inside their owning stacking contexts.
 * - attachment-menu opens above dialog-level overlays from inside them.
 * - image-preview-modal is a lightbox that must beat every dialog.
 * Migrating one means designing its slot, not just swapping the number.
 */
const BASELINE: ReadonlyArray<{ file: string; value: number }> = [
  { file: 'index.css', value: 10000 }, // .attachment-menu — opens above dialog-level overlays from inside them; needs a slot decision, not a renumber
  { file: 'index.css', value: 20000 }, // .image-preview-modal — global lightbox above every dialog; slot decision pending
];

function chromeScaleRawSites(): Array<{ file: string; value: number }> {
  const files = glob.sync('**/*.css', { cwd: UI_SRC, nodir: true });
  const sites: Array<{ file: string; value: number }> = [];
  for (const file of files) {
    const source = readFileSync(join(UI_SRC, file), 'utf8');
    // Declarations only — comments discussing z-index are prose, not layers.
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of stripped.matchAll(
      /z-index:\s*(\d+)\s*(?:!important)?\s*;/g,
    )) {
      const value = Number(match[1]);
      if (value >= 100) sites.push({ file, value });
    }
  }
  return sites.sort(
    (a, b) => a.file.localeCompare(b.file) || a.value - b.value,
  );
}

describe('chrome stacking uses the layer tokens', () => {
  it('permits no chrome-scale raw z-index beyond the baseline', () => {
    const expected = [...BASELINE].sort(
      (a, b) => a.file.localeCompare(b.file) || a.value - b.value,
    );
    // toEqual on the full occurrence list: a NEW raw site fails naming its
    // file and value, and a MIGRATED one fails until removed from the
    // baseline — the ratchet moves in one direction only.
    expect(chromeScaleRawSites()).toEqual(expected);
  });

  it('keeps the declared layer order true', () => {
    const tokens = readFileSync(join(UI_SRC, 'tokens.css'), 'utf8');
    const order = [
      'sticky',
      'popover',
      'notice',
      'dock',
      'floating-action',
      'navigation',
      'notification',
      'palette',
      'dialog',
      'system',
    ];
    const values = order.map((name) => {
      const match = new RegExp(`--layer-${name}:\\s*(\\d+);`).exec(tokens);
      expect(match, `--layer-${name} must be defined in tokens.css`).not.toBe(
        null,
      );
      return Number(match?.[1]);
    });
    // The scale IS the contract: passive notices below the dock, floating
    // actions below navigation, everything below dialogs, dialogs below the
    // system blocker. A reordering silently rewrites every surface at once.
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `--layer-${order[i]} must stack above --layer-${order[i - 1]}`,
      ).toBeGreaterThan(values[i - 1]);
    }
  });

  it('keeps dock overlays in their strict local order', () => {
    const source = readFileSync(join(UI_SRC, 'index.css'), 'utf8');
    const localLayer = (selector: string) => {
      const match = new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*z-index:\\s*(\\d+);`,
        's',
      ).exec(source);
      expect(match, `${selector} must declare a local z-index`).not.toBeNull();
      return Number(match?.[1]);
    };
    const activeWork = localLayer('.active-work-frame__overlay');
    const command = localLayer('.command-launcher__overlay');
    const delegation = localLayer('.delegation-launcher__overlay');
    expect(command).toBeGreaterThan(activeWork);
    expect(delegation).toBeGreaterThan(command);
    expect(delegation).toBeLessThan(100);
  });
});
