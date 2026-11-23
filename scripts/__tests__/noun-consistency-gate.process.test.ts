/**
 * The noun-consistency gate's rejection path, run the way CI runs it: as a
 * child process whose exit status is the verdict. Each case puts one retired
 * place phrase in one copy position of an otherwise clean repository and
 * expects exit 1; the clean repository exits 0.
 *
 * The gate and its helpers are copied beside an empty allowlist, because the
 * repository's own allowlist names findings in files this temp tree lacks.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();

const SCRIPTS = [
  'scripts/noun-consistency-gate.mjs',
  'scripts/lib/gate-scope.mjs',
  'scripts/lib/module-entry.mjs',
  'scripts/lib/ratchet-utils.mjs',
  'scripts/lib/bounded-capture.mjs',
];

/** The smallest tree the gate's scope assertion accepts. */
const CLEAN_TREE: Record<string, string> = {
  'src-ui/src/App.tsx': 'export const App = () => <p>Open Apps</p>;\n',
  'src-ui/src/main.tsx': 'export {};\n',
  'packages/sdk/src/components/LayoutHeader.tsx':
    'export const H = () => <h1>Layout</h1>;\n',
  'packages/contracts/src/settings-registry.ts':
    "defineSetting({ label: 'Theme', help: 'Pick one.', description: 'Colors.' });\n",
  'packages/contracts/src/device-settings.ts':
    "defineDeviceSetting({ label: 'Sound', help: 'On or off.', description: 'Alerts.' });\n",
  'src-ui/src/components/registry/registryCatalogModel.ts':
    "export const title = 'Browse skills';\n",
  'src-ui/src/views/skills/skill-view-utils.ts':
    "export const label = 'From a source';\n",
  'src-ui/src/views/plugin-management/view-utils.ts': 'export {};\n',
  'src-ui/src/views/plugin-management/usePluginManagementViewModel.ts':
    'export {};\n',
  'src-ui/src/workspace-panes/workspacePaneAvailabilityPresentation.ts':
    'export {};\n',
};

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function runGate(overrides: Record<string, string>) {
  const dir = makeTempDir('noun-gate-');
  for (const script of SCRIPTS) {
    mkdirSync(dirname(join(dir, script)), { recursive: true });
    copyFileSync(join(root, script), join(dir, script));
  }
  writeFileSync(join(dir, 'scripts/noun-consistency-allowlist.json'), '[]\n');
  for (const [file, content] of Object.entries({
    ...CLEAN_TREE,
    ...overrides,
  })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  return spawnSync(process.execPath, ['scripts/noun-consistency-gate.mjs'], {
    cwd: dir,
    encoding: 'utf8',
  });
}

describe('noun-consistency gate as a child process', () => {
  test('a clean tree exits 0', () => {
    const result = runGate({});
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test.each([
    [
      'JSX text',
      'src-ui/src/App.tsx',
      'export const A = () => <p>Open in Plugins</p>;\n',
    ],
    [
      'a ternary branch in JSX',
      'src-ui/src/App.tsx',
      "export const A = ({ on }: { on: boolean }) => <p>{on ? 'Browse the Registry' : 'Done'}</p>;\n",
    ],
    [
      'a function argument',
      'src-ui/src/App.tsx',
      "export const A = () => { toast('Check its status in Plugins.'); return null; };\n",
    ],
    [
      'a .ts copy module',
      'src-ui/src/components/registry/registryCatalogModel.ts',
      "export const title = 'Install one from the Registry › Integrations tab';\n",
    ],
    [
      'another .ts copy module',
      'src-ui/src/views/skills/skill-view-utils.ts',
      "export const note = 'Configure it in Connections.';\n",
    ],
  ])('a retired place phrase in %s exits 1', (_position, file, content) => {
    const result = runGate({ [file]: content });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(file);
    expect(result.stderr).toMatch(/as a place" is retired/);
  });
});
