import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const makeTempDir = trackTempDirs();
const entry = resolve('scripts/component-style-hygiene.mjs');

test('the CLI accepts canonical untracked source and refuses new recipe debt and malformed baselines', () => {
  const cwd = makeTempDir('station-component-style-cli-');
  const env = sanitizedGitEnvironment();
  const git = spawnSyncBounded('git', ['init', '--quiet'], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  expect(git.error).toBeUndefined();
  expect(git.status, git.stderr).toBe(0);
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, 'src-ui/src'), { recursive: true });
  const baseline = join(cwd, 'scripts/component-style-hygiene-baseline.json');
  writeFileSync(baseline, JSON.stringify({ version: 1, files: {} }));
  const source = join(cwd, 'src-ui/src/Action.tsx');
  const css = join(cwd, 'src-ui/src/Action.css');
  const run = () =>
    spawnSyncBounded(process.execPath, [entry], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  writeFileSync(
    source,
    '<><Button>Save</Button><Dialog title="Edit" /><button role="switch" /></>',
  );
  writeFileSync(
    css,
    '.action { padding: var(--k-space-2); content: "var(--space-4)"; }',
  );
  const accepted = run();
  expect(accepted.error).toBeUndefined();
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain('0 new');

  writeFileSync(
    source,
    '<><button className="item__action">Save</button><dialog open /><aside role={"alertdialog"} /></>',
  );
  writeFileSync(css, '.action { padding: var(--space-4); }');
  const refused = run();
  expect(refused.error).toBeUndefined();
  expect(refused.status, refused.stderr).toBe(1);
  for (const finding of [
    'bespoke-action',
    'bespoke-dialog:dialog',
    'bespoke-dialog:aside',
    'legacy-token:--space-4',
  ]) {
    expect(refused.stderr).toContain(finding);
  }
  writeFileSync(baseline, JSON.stringify({ version: 1, files: null }));
  const malformed = run();
  expect(malformed.error).toBeUndefined();
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain(
    'Component/style inventory must be an object',
  );
}, 60_000);

test('the CLI advises on new literal styles across the UI while preserving the ratchet exit code', () => {
  const cwd = makeTempDir('station-literal-style-cli-');
  const env = {
    ...sanitizedGitEnvironment(),
    STATION_CI_FAST_BASE: 'origin/main',
  };
  function git(...args: string[]) {
    const result = spawnSyncBounded(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { cwd, env, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }
  function write(path: string, content: string) {
    const file = join(cwd, path);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  git('init', '--quiet');
  write(
    'scripts/component-style-hygiene-baseline.json',
    '{"version":1,"files":{}}',
  );
  const row = 'src-ui/src/SettingsRow.css';
  write(row, '.previous { padding: 4px; gap: 6px; color: currentColor; }\n');
  const discovery = 'packages/connect/src/react/Discovery.tsx';
  const action = '  <ActionControl style={{ padding: "8px 14px" }} />';
  write(discovery, ['<div>', action, '</div>', ''].join('\n'));
  git('add', '.');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'Base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write(
    row,
    [
      '.new { padding: 4px; }',
      '.previous { padding: 4px; gap: 6px; color: inherit; } .left { gap: 6px; } .right { gap: 6px; }',
      '/* comment with font-size: 20px; */',
      '[data-density="compact"] .label {',
      '  font-size: 12.5px;',
      '  padding-inline: 0 0px;',
      '  min-block-size: 44px;',
      '  gap: var(--k-space-1, 4px);',
      '}',
      '',
    ].join('\n'),
  );
  git('add', row);
  git(
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'Style a density-sensitive row',
  );

  const sdk = 'packages/sdk/src/components/Card.css';
  write(sdk, '.sdk-card { padding-inline: 6px; }\n');
  git('add', sdk);
  write(sdk, '.sdk-card { padding-inline: 8px; }\n');
  const pane = 'packages/basis-pane/src/Pane.css';
  write(pane, '.pane { column-gap: 0.5rem; }\n');
  git('add', pane);
  const board = 'packages/board-pane/src/Board.tsx';
  write(
    board,
    [
      '<div style={{ gap: width / 3, width: 360, padding: 0, minHeight: 44 }}>',
      '  <span style={{ fontSize: 13 }} />',
      '</div>',
      '',
    ].join('\n'),
  );
  write(
    discovery,
    [
      '<div>',
      action.replace(' style=', ' title="Discover" style='),
      action.replace(' style=', ' title="Pair" style='),
      '</div>',
      '',
    ].join('\n'),
  );
  const theme = 'src-ui/public/device-theme.css';
  write(theme, '.device { row-gap: 10px!important; }\n');
  write(
    'packages/connect/src/__tests__/Fixture.tsx',
    '<div style={{ gap: 40 }} />\n',
  );

  const result = spawnSyncBounded(process.execPath, [entry], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const findings = result.stderr.trim().split('\n');
  expect(findings).toHaveLength(8);
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        `${row}:5: literal style advisory: font-size uses 12.5px.`,
      ),
      expect.stringContaining(
        `${row}: literal style advisory: 1 new padding declaration using 4px among changed lines 1, 2.`,
      ),
      expect.stringContaining(
        `${row}:2: literal style advisory: 2 new gap declarations using 6px.`,
      ),
      expect.stringContaining(
        `${sdk}:1: literal style advisory: padding-inline uses 8px.`,
      ),
      expect.stringContaining(
        `${pane}:1: literal style advisory: column-gap uses 0.5rem.`,
      ),
      expect.stringContaining(
        `${board}:2: literal style advisory: font-size uses 13px.`,
      ),
      expect.stringContaining(
        `${discovery}: literal style advisory: 1 new padding declaration using 8px 14px among changed lines 2, 3.`,
      ),
      expect.stringContaining(
        `${theme}:1: literal style advisory: row-gap uses 10px.`,
      ),
    ]),
  );
  expect(result.stderr).toContain('--k-text-*');
  expect(result.stderr).toContain('--k-space-*');
}, 60_000);
