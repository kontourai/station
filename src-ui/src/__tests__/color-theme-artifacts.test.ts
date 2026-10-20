import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  COLOR_THEME_STARTUP_SCRIPT_PATH,
  COLOR_THEME_STARTUP_STYLESHEET_PATH,
  COLOR_THEME_STYLESHEET_PATH,
  renderColorThemeStartupIndex,
  renderColorThemeStartupStylesheet,
  renderColorThemeStylesheet,
  spliceStartupIndex,
} from '../lib/color-theme-css';

/**
 * The checked-in color-theme artifacts are exactly what the catalog renders
 * today. A hand edit, or a catalog change without `npm run gen:color-themes`,
 * fails here with the file to regenerate.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const read = (relative: string) =>
  readFileSync(resolve(REPO_ROOT, relative), 'utf8');
const STALE = 'is stale: run `npm run gen:color-themes` and commit the result';

describe('color theme artifacts', () => {
  test('the stylesheet matches the catalog', () => {
    expect(
      read(COLOR_THEME_STYLESHEET_PATH),
      `${COLOR_THEME_STYLESHEET_PATH} ${STALE}`,
    ).toBe(renderColorThemeStylesheet());
  });

  test('the splash stylesheet matches the catalog', () => {
    expect(
      read(COLOR_THEME_STARTUP_STYLESHEET_PATH),
      `${COLOR_THEME_STARTUP_STYLESHEET_PATH} ${STALE}`,
    ).toBe(renderColorThemeStartupStylesheet());
  });

  test('the startup script carries the current index', () => {
    const script = read(COLOR_THEME_STARTUP_SCRIPT_PATH);
    expect(
      spliceStartupIndex(script, renderColorThemeStartupIndex()),
      `${COLOR_THEME_STARTUP_SCRIPT_PATH} ${STALE}`,
    ).toBe(script);
  });

  test('a script without exactly one generated block is refused, not appended to', () => {
    const index = renderColorThemeStartupIndex();
    expect(() => spliceStartupIndex('(() => {})();', index)).toThrow(
      /exactly one generated color-theme block/,
    );
    expect(() => spliceStartupIndex(`${index}\n${index}`, index)).toThrow(
      /exactly one generated color-theme block/,
    );
  });
});
