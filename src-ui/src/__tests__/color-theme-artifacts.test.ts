import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';
import {
  COLOR_THEME_INDEX_PATH,
  COLOR_THEME_STARTUP_SCRIPT_PATH,
  COLOR_THEME_STARTUP_STYLESHEET_PATH,
  COLOR_THEME_STYLESHEET_DIR,
  renderColorThemeFamilyStylesheets,
  renderColorThemeIndex,
  renderColorThemeStartupIndex,
  renderColorThemeStartupStylesheet,
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
  test('each family sheet matches the catalog, and no other sheet is served', () => {
    const rendered = renderColorThemeFamilyStylesheets();
    expect(
      readdirSync(resolve(REPO_ROOT, COLOR_THEME_STYLESHEET_DIR))
        .map((name) => `${COLOR_THEME_STYLESHEET_DIR}/${name}`)
        .sort(),
    ).toEqual(Object.keys(rendered).sort());
    for (const [path, content] of Object.entries(rendered))
      expect(read(path), `${path} ${STALE}`).toBe(content);
  });

  test('the splash stylesheet matches the catalog', () => {
    expect(
      read(COLOR_THEME_STARTUP_STYLESHEET_PATH),
      `${COLOR_THEME_STARTUP_STYLESHEET_PATH} ${STALE}`,
    ).toBe(renderColorThemeStartupStylesheet());
  });

  test('the runtime index matches the catalog', () => {
    expect(
      read(COLOR_THEME_INDEX_PATH),
      `${COLOR_THEME_INDEX_PATH} ${STALE}`,
    ).toBe(renderColorThemeIndex());
  });

  test('the startup path (applier and selection) never bundles the full catalog', async () => {
    // main.tsx imports the applier eagerly; the catalog belongs to Settings.
    const result = await build({
      entryPoints: [resolve(REPO_ROOT, 'src-ui/src/lib/color-theme-apply.ts')],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toContain('src-ui/src/lib/color-theme-selection.ts');
    expect(
      inputs.filter((path) => path.includes('color-theme-catalog')),
    ).toEqual([]);
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
