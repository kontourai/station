import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertGalleryScreenSourcesCover,
  GALLERY_SCREEN_ENTRIES,
  GALLERY_SHELL_ENTRIES,
} from '../../tests/gallery-screen-sources.mjs';
import {
  galleryCoverage,
  isGalleryUiPath,
} from '../lib/gallery-screen-coverage.mjs';
import { createUiModuleGraph } from '../lib/ui-module-graph.mjs';

const fixtureRoots: string[] = [];
afterAll(() => {
  for (const root of fixtureRoots)
    rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'ui-module-graph-'));
  fixtureRoots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('ui module graph', () => {
  const root = fixtureRoot({
    'src-ui/tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        allowImportingTsExtensions: true,
        noEmit: true,
        paths: { '@/*': ['./src/*'] },
      },
    }),
    'src-ui/index.html':
      '<link rel="stylesheet" href="/src/splash.css" /><script type="module" src="/src/boot.ts"></script>',
    'src-ui/src/splash.css': '@import url("./theme.css");',
    'src-ui/src/theme.css': ':root {}',
    'src-ui/src/boot.ts': "void import('./main');",
    'src-ui/src/main.tsx': [
      "import type { Shape } from './types';",
      "import { Button } from '@/Button';",
      "import './main.css';",
      "export { helper } from './helper';",
      "export type { Other } from './other';",
      "const View = () => import('./View');",
    ].join('\n'),
    'src-ui/src/types.ts': 'export type Shape = 1;',
    'src-ui/src/other.ts': 'export type Other = 1;',
    'src-ui/src/Button.tsx': 'export const Button = 1;',
    'src-ui/src/main.css': '',
    'src-ui/src/helper.ts': 'export const helper = 1;',
    'src-ui/src/View.tsx': "import './View.css';",
    'src-ui/src/View.css': '',
  });
  const graph = createUiModuleGraph(root);

  it('follows value, side-effect, re-export, alias, CSS and HTML edges, not type-only ones', () => {
    expect(graph.edges('src-ui/src/main.tsx')).toEqual({
      static: [
        'src-ui/src/Button.tsx',
        'src-ui/src/main.css',
        'src-ui/src/helper.ts',
      ],
      dynamic: ['src-ui/src/View.tsx'],
    });
    expect(graph.edges('src-ui/index.html').static.sort()).toEqual([
      'src-ui/src/boot.ts',
      'src-ui/src/splash.css',
    ]);
    expect(graph.edges('src-ui/src/splash.css').static).toEqual([
      'src-ui/src/theme.css',
    ]);
  });

  it('separates the eager closure from what lazy boundaries load', () => {
    const eager = graph.closure(['src-ui/src/main.tsx'], {
      followDynamic: false,
    });
    expect(eager.has('src-ui/src/Button.tsx')).toBe(true);
    expect(eager.has('src-ui/src/View.css')).toBe(false);
    const all = graph.closure(['src-ui/index.html'], { followDynamic: true });
    expect(all.has('src-ui/src/View.css')).toBe(true);
    expect(all.has('src-ui/src/types.ts')).toBe(false);
  });

  it('refuses an entry that does not exist', () => {
    expect(() =>
      graph.closure(['src-ui/src/Gone.tsx'], { followDynamic: false }),
    ).toThrow(/Gone\.tsx does not exist/);
  });
});

describe('gallery screen sources', () => {
  it('names entries the app actually loads from its HTML entry', () => {
    const graph = createUiModuleGraph(process.cwd());
    const reachable = graph.closure(['src-ui/index.html'], {
      followDynamic: true,
    });
    const entries = [
      ...GALLERY_SHELL_ENTRIES.filter((path) => path !== 'src-ui/index.html'),
      ...Object.values(GALLERY_SCREEN_ENTRIES).flat(),
    ];
    expect(entries.filter((path) => !reachable.has(path))).toEqual([]);
  });

  it('refuses a screen list it does not describe exactly', () => {
    const names = Object.keys(GALLERY_SCREEN_ENTRIES);
    expect(() => assertGalleryScreenSourcesCover(names)).not.toThrow();
    expect(() =>
      assertGalleryScreenSourcesCover([...names, 'new-screen']),
    ).toThrow(/Missing: new-screen/);
    expect(() => assertGalleryScreenSourcesCover(names.slice(1))).toThrow(
      new RegExp(`Unknown: ${names[0]}`),
    );
  });

  it('routes UI source by import closure', () => {
    expect(isGalleryUiPath('src-ui/src/views/ScheduleView.css')).toBe(true);
    expect(
      isGalleryUiPath('packages/basis-pane/src/SessionInventory.tsx'),
    ).toBe(true);
    expect(isGalleryUiPath('src-ui/src/__tests__/App.test.tsx')).toBe(false);
    expect(isGalleryUiPath('src-ui/src/lib/queryPersistence.ts')).toBe(false);
    const coverage = galleryCoverage({
      changedPaths: [
        'src-ui/src/views/ScheduleView.css',
        'docs/guides/testing.md',
      ],
    });
    expect(coverage?.paths).toEqual([
      {
        path: 'src-ui/src/views/ScheduleView.css',
        scope: 'screens',
        screens: expect.arrayContaining(['schedule', 'overlay-add-job-modal']),
      },
    ]);
    expect(coverage?.screens).not.toContain('home');
    expect(
      galleryCoverage({ changedPaths: ['docs/guides/testing.md'] }),
    ).toBeNull();
  });
});

function gateFor(paths: string[]) {
  const run = spawnSync('node', ['scripts/gate-for.mjs', ...paths], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Each child runs the Veritas plan and builds the UI module graph: seconds,
// not milliseconds, on a loaded host.
describe('gate:for gallery routing (child process)', {
  timeout: 150_000,
}, () => {
  it('prints covering screens, the subset command and the PNG reminder for a UI path', () => {
    const run = gateFor(['src-ui/src/views/ScheduleView.tsx']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('Gallery screens covering changed UI source:');
    expect(run.stdout).toMatch(
      /src-ui\/src\/views\/ScheduleView\.tsx\n {4}[^\n]*\bschedule\b/,
    );
    expect(run.stdout).toMatch(
      /npm run test:e2e:screenshot -- --screens=[^\n]*\bschedule\b/,
    );
    expect(run.stdout).toContain(
      'UI PRs attach the before/after PNGs they inspected',
    );
  });

  it('says a path no screen loads needs a screen', () => {
    const run = gateFor([
      'src-ui/src/views/project-page/ProjectConversationsSection.tsx',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('no gallery screen covers this path, add one');
  });

  it('prints no gallery section for a non-UI path', () => {
    const run = gateFor(['docs/guides/testing.md']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).not.toContain('Gallery screens');
    expect(run.stdout).not.toContain('before/after PNGs');
  });
});
