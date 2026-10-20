/**
 * Writes the color-theme artifacts from the catalog
 * (`src-ui/src/lib/color-theme-catalog.ts`): the two generated stylesheets
 * and the index block inside `src-ui/public/startup-theme.js`. The renderer
 * is `src-ui/src/lib/color-theme-css.ts`; this script only writes what it
 * returns. `src-ui/src/__tests__/color-theme-artifacts.test.ts` regenerates
 * the same output and fails when a checked-in artifact differs.
 *
 * The renderer is loaded through a computed specifier for the reason
 * `gen-settings-registry.ts` gives: a static import would pull the UI module
 * graph into the scripts typecheck program. Its shape is checked at run time.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RENDERER = 'src-ui/src/lib/color-theme-css.ts';

interface Renderer {
  COLOR_THEME_STYLESHEET_PATH: string;
  COLOR_THEME_STARTUP_STYLESHEET_PATH: string;
  COLOR_THEME_STARTUP_SCRIPT_PATH: string;
  renderColorThemeStylesheet(): string;
  renderColorThemeStartupStylesheet(): string;
  renderColorThemeStartupIndex(): string;
  spliceStartupIndex(script: string, index: string): string;
}

async function loadRenderer(): Promise<Renderer> {
  const module = (await import(pathToFileURL(join(ROOT, RENDERER)).href)) as
    | Partial<Renderer>
    | undefined;
  for (const name of [
    'renderColorThemeStylesheet',
    'renderColorThemeStartupStylesheet',
    'renderColorThemeStartupIndex',
    'spliceStartupIndex',
  ] as const) {
    if (typeof module?.[name] !== 'function')
      throw new Error(`${RENDERER} does not export ${name}`);
  }
  return module as Renderer;
}

export async function generateColorThemes(): Promise<string[]> {
  const renderer = await loadRenderer();
  const script = join(ROOT, renderer.COLOR_THEME_STARTUP_SCRIPT_PATH);
  const outputs: [string, string][] = [
    [
      renderer.COLOR_THEME_STYLESHEET_PATH,
      renderer.renderColorThemeStylesheet(),
    ],
    [
      renderer.COLOR_THEME_STARTUP_STYLESHEET_PATH,
      renderer.renderColorThemeStartupStylesheet(),
    ],
    [
      renderer.COLOR_THEME_STARTUP_SCRIPT_PATH,
      renderer.spliceStartupIndex(
        readFileSync(script, 'utf8'),
        renderer.renderColorThemeStartupIndex(),
      ),
    ],
  ];
  for (const [relative, content] of outputs)
    writeFileSync(join(ROOT, relative), content, 'utf8');
  return outputs.map(([relative]) => relative);
}

if (invokedDirectly(import.meta.url)) {
  try {
    for (const written of await generateColorThemes())
      console.log(`Generated ${written}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
