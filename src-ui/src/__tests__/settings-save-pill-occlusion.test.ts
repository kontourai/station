/**
 * station#1831: with pending changes, the Settings "Unsaved changes /
 * Discard / Save" pill rendered BEHIND the chat dock (both were fixed,
 * bottom-anchored, z-index 100, and the dock's later stacking-context won),
 * so the primary action for committing edits was occluded. The dock is
 * resizable, so the fix anchors the pill above the live `--dock-slot-size`
 * footprint (maintained by useChatDockState at every dock state, including
 * per-frame during a drag) and stacks it one layer above the dock.
 *
 * jsdom does not apply stylesheets, so this pins the two load-bearing facts
 * in the CSS source itself — comparing derived values across the two files,
 * not hardcoded numbers, so a legitimate dock z-index change keeps passing as
 * long as the pill stays above it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ruleBodiesFor } from './helpers/css-rules';

function cssBlock(source: string, selector: string): string {
  // Every top-level block that TARGETS `selector`, not only one spelled
  // exactly that way: station#3929 moved the dock's shared geometry into
  // `:is(.chat-dock, .dock-slot)`, and an exact-match reader reported a
  // missing z-index on a dock that has one.
  const bodies = ruleBodiesFor(source, selector);
  if (bodies.length === 0)
    throw new Error(`No block for selector "${selector}"`);
  return bodies.join('\n');
}

function zIndexOf(block: string, selector: string, tokens: string): number {
  const match = block.match(/z-index:\s*(?:var\(--([\w-]+)\)|(\d+))/);
  if (!match) throw new Error(`No z-index in block for "${selector}"`);
  if (match[2]) return Number(match[2]);

  const token = match[1];
  const value = new RegExp(`--${token}:\\s*(\\d+)`).exec(tokens)?.[1];
  if (!value) throw new Error(`No numeric value for "--${token}"`);
  return Number(value);
}

const uiRoot = path.resolve(__dirname, '..');
const settingsCss = readFileSync(
  path.join(uiRoot, 'views/SettingsView.css'),
  'utf-8',
);
const indexCss = readFileSync(path.join(uiRoot, 'index.css'), 'utf-8');
const tokensCss = readFileSync(path.join(uiRoot, 'tokens.css'), 'utf-8');

describe('settings save pill vs chat dock (station#1831)', () => {
  const pill = cssBlock(settingsCss, '.settings__save-pill');
  const dock = cssBlock(indexCss, '.chat-dock');

  test('pill bottom is anchored above the live dock height, not a fixed offset', () => {
    const bottom = pill.match(/bottom:\s*([^;]+);/)?.[1] ?? '';
    expect(bottom).toContain('var(--dock-slot-size');
  });

  test('pill stacks above the chat dock', () => {
    expect(zIndexOf(pill, '.settings__save-pill', tokensCss)).toBeGreaterThan(
      zIndexOf(dock, '.chat-dock', tokensCss),
    );
  });

  test('the mobile full-width override does not reintroduce a fixed bottom', () => {
    // The base rule carries the dock-aware bottom; any later
    // .settings__save-pill rule that sets `bottom` must stay dock-aware.
    const rules = settingsCss.match(
      /\.settings__save-pill\s*\{[^}]*\}/g,
    ) as string[];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const bottom = rule.match(/bottom:\s*([^;]+);/)?.[1];
      if (bottom !== undefined) {
        expect(bottom).toContain('var(--dock-slot-size');
      }
    }
  });
});
