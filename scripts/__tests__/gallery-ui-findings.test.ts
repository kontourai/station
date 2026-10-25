import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const JUDGE = resolve('scripts/gallery-ui-findings.mjs');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gallery-ui-findings-'));
  roots.push(root);
  return root;
}

// The entry shape tests/screenshots.spec.ts writes to capture.json.
function screen(
  name: string,
  uiAudit: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    file: `${name}.png`,
    ok: true,
    name,
    viewport: { width: 390, height: 844 },
    error: null,
    sha256: 'a'.repeat(64),
    controls: [],
    uiAudit,
    ...overrides,
  };
}
const audit = (...identities: string[]) => ({
  findings: identities.map((identity) => ({ identity, detail: 'measured' })),
  measured: { controls: 4, smallTargets: 0, viewport: 390 },
});

function gallery(
  root: string,
  screens: unknown[],
  selection: string[] | null = null,
) {
  const dir = join(root, 'gallery');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'capture.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId: null,
      capturedAt: '2026-10-25T00:00:00.000Z',
      expected: screens.length,
      selection,
      screens,
    }),
  );
  return dir;
}

function allowlist(root: string, screens: Record<string, string[]>) {
  const path = join(root, 'allowlist.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, screens }));
  return path;
}

function judge(args: string[], cwd = process.cwd()) {
  const run = spawnSync('node', [JUDGE, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

describe('gallery-ui-findings check', () => {
  it('fails an unlisted finding, naming the screen and the finding', () => {
    const root = scratch();
    const dir = gallery(root, [
      screen('home', audit('overflow:document', 'hit-target:small:Save')),
    ]);
    const list = allowlist(root, { home: ['overflow:document'] });
    const run = judge(['check', `--gallery=${dir}`, `--allowlist=${list}`]);
    expect(run.status).toBe(1);
    expect(run.out).toContain('FAIL home: hit-target:small:Save — measured');
    expect(run.out).not.toContain('FAIL home: overflow:document');
  });

  it('keys the allowlist by screen: the same finding elsewhere still fails', () => {
    const root = scratch();
    const dir = gallery(root, [
      screen('home', audit('overflow:document')),
      screen('agents', audit('overflow:document')),
    ]);
    const list = allowlist(root, { home: ['overflow:document'] });
    const run = judge([`--gallery=${dir}`, `--allowlist=${list}`]);
    expect(run.status).toBe(1);
    expect(run.out).toContain('FAIL agents: overflow:document');
  });

  it('passes when a listed finding is gone, and says it can be removed', () => {
    const root = scratch();
    const dir = gallery(root, [screen('home', audit())]);
    const list = allowlist(root, { home: ['overflow:document'] });
    const run = judge(['check', `--gallery=${dir}`, `--allowlist=${list}`]);
    expect(run.status).toBe(0);
    expect(run.out).toContain('RESOLVED home: overflow:document');
  });

  it('fails an audit that threw, is missing, or a screen that did not render', () => {
    const root = scratch();
    const dir = gallery(root, [
      screen('home', { error: 'axe exploded' }),
      screen('agents', undefined),
      screen('plugins', undefined, { ok: false, error: 'timeout' }),
    ]);
    const list = allowlist(root, {});
    const run = judge(['check', `--gallery=${dir}`, `--allowlist=${list}`]);
    expect(run.status).toBe(1);
    expect(run.out).toContain('FAIL home: audit-error — axe exploded');
    expect(run.out).toContain('FAIL agents: audit-missing');
    expect(run.out).toContain('FAIL plugins: capture-failed — timeout');
  });

  it('judges a requested subset and refuses names the capture lacks', () => {
    const root = scratch();
    const dir = gallery(
      root,
      [screen('home', audit()), screen('agents', audit('overflow:document'))],
      ['home', 'agents'],
    );
    const list = allowlist(root, {});
    expect(
      judge([`--gallery=${dir}`, `--allowlist=${list}`, '--screens=home'])
        .status,
    ).toBe(0);
    const unknown = judge([
      `--gallery=${dir}`,
      `--allowlist=${list}`,
      '--screens=registry',
    ]);
    expect(unknown.status).toBe(2);
    expect(unknown.out).toContain('registry');
  });

  it('is an input error, not a pass, without a capture or allowlist', () => {
    const root = scratch();
    expect(
      judge([
        `--gallery=${join(root, 'none')}`,
        `--allowlist=${join(root, 'x')}`,
      ]).status,
    ).toBe(2);
  });
});

describe('gallery-ui-findings seed and prune', () => {
  it('seeds once from a full clean capture, then refuses', () => {
    const root = scratch();
    const dir = gallery(root, [
      screen('home', audit('overflow:document', 'axe:label:input')),
      screen('agents', audit()),
    ]);
    const path = join(root, 'seeded.json');
    expect(
      judge(['seed', `--gallery=${dir}`, `--allowlist=${path}`]).status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      screens: { home: ['axe:label:input', 'overflow:document'] },
    });
    expect(
      judge(['seed', `--gallery=${dir}`, `--allowlist=${path}`]).status,
    ).toBe(2);
  });

  it('prunes only resolved entries and refuses a partial capture', () => {
    const root = scratch();
    const dir = gallery(root, [screen('home', audit('overflow:document'))]);
    const list = allowlist(root, {
      home: ['overflow:document', 'hit-target:small:Old'],
      removed: ['overflow:document'],
    });
    expect(
      judge(['prune', `--gallery=${dir}`, `--allowlist=${list}`]).status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(list, 'utf8')).screens).toEqual({
      home: ['overflow:document'],
    });
    const partial = gallery(scratch(), [screen('home', audit())], ['home']);
    expect(
      judge(['prune', `--gallery=${partial}`, `--allowlist=${list}`]).status,
    ).toBe(2);
  });
});

describe('gallery-ui-findings growth', () => {
  function repo() {
    const root = scratch();
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.invalid',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
      }).trim();
    git('init', '-q');
    mkdirSync(join(root, 'tests'));
    return { root, git };
  }
  const write = (root: string, screens: Record<string, string[]>) =>
    writeFileSync(
      join(root, 'tests/gallery-ui-findings.allowlist.json'),
      JSON.stringify({ schemaVersion: 1, screens }),
    );

  it('fails an added entry, passes a removal, and establishes the first ceiling', () => {
    const { root, git } = repo();
    writeFileSync(join(root, 'README'), 'x');
    git('add', '.');
    git('commit', '-qm', 'empty base');
    const empty = git('rev-parse', 'HEAD');
    write(root, { home: ['overflow:document', 'axe:label:input'] });
    const first = judge(['growth', `--base=${empty}`], root);
    expect(first.status).toBe(0);
    expect(first.out).toContain('establishes the ceiling');
    git('add', '.');
    git('commit', '-qm', 'ceiling');
    const base = git('rev-parse', 'HEAD');

    write(root, { home: ['overflow:document'] });
    expect(judge(['growth', `--base=${base}`], root).status).toBe(0);

    write(root, {
      home: ['overflow:document', 'axe:label:input'],
      agents: ['overflow:document'],
    });
    const grown = judge(['growth', `--base=${base}`], root);
    expect(grown.status).toBe(1);
    expect(grown.out).toContain('GROWTH agents: overflow:document');
    expect(grown.out).not.toContain('GROWTH home');
  });

  it('is an input error for an unknown base', () => {
    const { root, git } = repo();
    write(root, {});
    git('add', '.');
    git('commit', '-qm', 'base');
    expect(judge(['growth', '--base=no-such-ref'], root).status).toBe(2);
  });
});
