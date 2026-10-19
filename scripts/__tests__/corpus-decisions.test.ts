import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_PIN,
  corpusDecisionsNpmArgs,
  runCorpusDecisions,
} from '../corpus-decisions.mjs';
import { FAST_BASE_ENV } from '../run-ci-fast.mjs';

const CORPUS_PACKAGE = `--package=https://codeload.github.com/kontourai/corpus/tar.gz/${CORPUS_PIN}`;

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
    expect(CORPUS_PIN).toBe('b8ecf4cd4c6482bb804cdeea617ebe2d9b78ab05');
    const docsKit = readFileSync('.github/workflows/docs-kit.yml', 'utf8');
    expect(docsKit.match(/corpus-ref:\s*([0-9a-f]{40})/)?.[1]).toBe(CORPUS_PIN);
    const pages = readFileSync('.github/workflows/pages.yml', 'utf8');
    expect(pages.match(/kontourai\/corpus#([0-9a-f]{40})/)?.[1]).toBe(
      CORPUS_PIN,
    );
  });

  it('checks against the ci:fast base, which defaults to origin/main', () => {
    expect(
      corpusDecisionsNpmArgs('check', { [FAST_BASE_ENV]: 'abc1234' }),
    ).toEqual([
      'exec',
      '--yes',
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
    expect(corpusDecisionsNpmArgs('index', {})).toEqual([
      'exec',
      '--yes',
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
