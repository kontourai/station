import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_PIN,
  corpusDecisionsNpmArgs,
  RELEASE_AGE_MINUTES,
  runCorpusDecisions,
} from '../corpus-decisions.mjs';
import { FAST_BASE_ENV } from '../run-ci-fast.mjs';

const CORPUS_PACKAGE = `--package=https://codeload.github.com/kontourai/corpus/tar.gz/${CORPUS_PIN}`;
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
// One day before NOW: pnpm-workspace.yaml's 1,440-minute release age.
const BEFORE = '--before=2026-10-13T12:00:00.000Z';

describe('Corpus decisions wrapper', () => {
  it('declares the registry with the numbered-ADR freeze in corpus.json', () => {
    // Without `adr`, Corpus never runs the freeze, and regenerating the index
    // hides the removal, so nothing else fails when this declaration goes.
    const manifest = JSON.parse(readFileSync('corpus.json', 'utf8'));
    expect(manifest.decisions).toEqual({ adr: { dir: 'docs/adr' } });
    expect(readFileSync('docs/decisions/index.md', 'utf8')).toContain(
      'Numbered ADRs under `docs/adr/` are frozen history',
    );
  });

  it('pins the Corpus commit docs-kit.yml and pages.yml use', () => {
    expect(CORPUS_PIN).toBe('08c62ccd72880ff4bd4c378ae252ad437b4b4fb5');
    const docsKit = readFileSync('.github/workflows/docs-kit.yml', 'utf8');
    expect(docsKit.match(/corpus-ref:\s*([0-9a-f]{40})/)?.[1]).toBe(CORPUS_PIN);
    const pages = readFileSync('.github/workflows/pages.yml', 'utf8');
    expect(pages.match(/kontourai\/corpus#([0-9a-f]{40})/)?.[1]).toBe(
      CORPUS_PIN,
    );
  });

  // The tarball has no lockfile, so without --before npm would resolve
  // Corpus's caret ranges to a dependency release published minutes ago.
  it("resolves Corpus's dependencies under the workspace release-age floor", () => {
    const workspace = load(readFileSync('pnpm-workspace.yaml', 'utf8')) as {
      minimumReleaseAge?: unknown;
    };
    expect(RELEASE_AGE_MINUTES).toBe(1440);
    expect(workspace.minimumReleaseAge).toBe(RELEASE_AGE_MINUTES);
    for (const subcommand of ['check', 'index']) {
      const args = corpusDecisionsNpmArgs(subcommand, {}, NOW);
      expect(args.slice(0, 5)).toEqual([
        'exec',
        '--yes',
        BEFORE,
        CORPUS_PACKAGE,
        '--',
      ]);
    }
    const calls: string[][] = [];
    runCorpusDecisions('check', {
      env: {},
      now: NOW,
      spawn: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(BEFORE);
    expect(calls[0].indexOf(BEFORE)).toBeLessThan(calls[0].indexOf('--'));
  });

  it('checks against the ci:fast base, which defaults to origin/main', () => {
    expect(
      corpusDecisionsNpmArgs('check', { [FAST_BASE_ENV]: 'abc1234' }, NOW),
    ).toEqual([
      'exec',
      '--yes',
      BEFORE,
      CORPUS_PACKAGE,
      '--',
      'corpus',
      'decisions',
      'check',
      '--base',
      'abc1234',
    ]);
    expect(corpusDecisionsNpmArgs('check', {}).slice(-2)).toEqual([
      '--base',
      'origin/main',
    ]);
    expect(corpusDecisionsNpmArgs('index', {}, NOW)).toEqual([
      'exec',
      '--yes',
      BEFORE,
      CORPUS_PACKAGE,
      '--',
      'corpus',
      'decisions',
      'index',
    ]);
  });

  it('refuses an option-shaped base and an unknown subcommand', () => {
    expect(() =>
      corpusDecisionsNpmArgs('check', { [FAST_BASE_ENV]: '--root=/' }),
    ).toThrow(/must be a Git ref/);
    expect(() => corpusDecisionsNpmArgs('freeze', {})).toThrow(/usage/);
    expect(() => corpusDecisionsNpmArgs(undefined, {})).toThrow(/usage/);
  });

  it('spawns without a shell and treats a signal or spawn error as failure', () => {
    const calls: { command: string; args: string[]; options: object }[] = [];
    const spawn = (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return { status: 0 };
    };
    expect(runCorpusDecisions('index', { env: {}, spawn })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({
      stdio: 'inherit',
      windowsHide: true,
    });
    expect(calls[0].options).not.toHaveProperty('shell');
    expect(calls[0].args.slice(-3)).toEqual(['corpus', 'decisions', 'index']);

    expect(
      runCorpusDecisions('index', {
        env: {},
        spawn: () => ({ status: null, signal: 'SIGTERM' }),
      }),
    ).toBe(1);
    expect(() =>
      runCorpusDecisions('index', {
        env: {},
        spawn: () => ({ status: null, error: new Error('spawn npm ENOENT') }),
      }),
    ).toThrow(/ENOENT/);
  });
});
