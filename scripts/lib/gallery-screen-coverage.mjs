// Routes changed UI source to the gallery screens that load it, for
// `gate:for`. A screen covers a path when the path is in the import closure of
// the screen's entry modules (tests/gallery-screen-sources.json); a path in the
// shell's eager closure is loaded by every screen. "Loads" is what this can
// compute: a loaded module may still render nothing on that screen, so the
// list is where to look, not proof the change is visible there.
import {
  GALLERY_SCREEN_ENTRIES,
  GALLERY_SHELL_ENTRIES,
} from '../../tests/gallery-screen-sources.mjs';
import { createUiModuleGraph } from './ui-module-graph.mjs';

const UI_SOURCE =
  /^(?:src-ui\/src|packages\/[^/]+-pane\/src)\/.+\.(?:tsx|css)$/;
const TEST_SOURCE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx$/;

/** Rendered UI source: `.tsx`/`.css` under src-ui/src or a pane package's src. */
export function isGalleryUiPath(path) {
  return UI_SOURCE.test(path) && !TEST_SOURCE.test(path);
}

const GALLERY_EVIDENCE_REMINDER =
  'UI PRs attach the before/after PNGs they inspected (gallery/<screen>.png from a capture on the base and on the change).';

function captureCommands(screens) {
  const flag = screens ? ` -- --screens=${screens.join(',')}` : '';
  return [
    `npm run test:e2e:screenshot${flag}`,
    `npm run screenshot:diff${flag}`,
    `node scripts/gallery-ui-findings.mjs${screens ? ` --screens=${screens.join(',')}` : ''}`,
  ];
}

/**
 * @returns {null | {
 *   paths: { path: string, scope: 'shell' | 'screens' | 'none', screens: string[] }[],
 *   screens: string[] | 'all',
 *   commands: string[],
 * }}
 */
export function galleryCoverage({ changedPaths, rootDir = process.cwd() }) {
  const uiPaths = [...new Set(changedPaths)].filter(isGalleryUiPath).sort();
  if (uiPaths.length === 0) return null;
  const graph = createUiModuleGraph(rootDir);
  const shell = graph.closure(GALLERY_SHELL_ENTRIES, { followDynamic: false });
  const closures = Object.entries(GALLERY_SCREEN_ENTRIES).map(
    ([screen, entries]) => [
      screen,
      graph.closure(entries, { followDynamic: true }),
    ],
  );
  const paths = uiPaths.map((path) => {
    if (shell.has(path)) return { path, scope: 'shell', screens: [] };
    const screens = closures
      .filter(([, closure]) => closure.has(path))
      .map(([screen]) => screen);
    return { path, scope: screens.length > 0 ? 'screens' : 'none', screens };
  });
  const coveredByAll = paths.some(({ scope }) => scope === 'shell');
  const screens = coveredByAll
    ? 'all'
    : [...new Set(paths.flatMap(({ screens: names }) => names))].sort();
  const commands =
    screens === 'all'
      ? captureCommands(null)
      : screens.length > 0
        ? captureCommands(screens)
        : [];
  return { paths, screens, commands };
}

export function formatGalleryCoverage(coverage) {
  if (!coverage) return [];
  const total = Object.keys(GALLERY_SCREEN_ENTRIES).length;
  const lines = ['Gallery screens covering changed UI source:'];
  for (const { path, scope, screens } of coverage.paths) {
    if (scope === 'shell')
      lines.push(`  ${path}`, `    every screen (${total}): app shell module`);
    else if (scope === 'screens')
      lines.push(`  ${path}`, `    ${screens.join(', ')}`);
    else
      lines.push(
        `  ${path}`,
        '    no gallery screen covers this path, add one (tests/screenshots.spec.ts SCREENS + tests/gallery-screen-sources.json)',
      );
  }
  if (coverage.commands.length > 0)
    lines.push(
      coverage.screens === 'all'
        ? 'Render, diff, and check the full gallery:'
        : 'Render, diff, and check just those screens:',
      ...coverage.commands.map((command) => `  ${command}`),
    );
  lines.push(GALLERY_EVIDENCE_REMINDER);
  return lines;
}
