import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_PIN,
  corpusDecisionsNpmArgs,
  runCorpusDecisions,
} from '../corpus-decisions.mjs';
import { FAST_BASE_ENV } from '../run-ci-fast.mjs';

const CORPUS_PACKAGE = `--package=https://codeload.github.com/kontourai/corpus/tar.gz/${CORPUS_PIN}`;

describe('Corpus decisions wrapper', () => {
  it('pins the one Corpus commit the workflows use', () => {
    expect(CORPUS_PIN).toBe('08c62ccd72880ff4bd4c378ae252ad437b4b4fb5');
    const workflows = '.github/workflows';
    const pins = readdirSync(workflows)
      .filter((name) => name.endsWith('.yml'))
      .flatMap((name) =>
        [
          ...readFileSync(join(workflows, name), 'utf8').matchAll(
            /(?:kontourai\/corpus(?:#|\/tar\.gz\/)|corpus-ref:\s*)([0-9a-f]{40})/g,
          ),
        ].map((match) => `${name}:${match[1]}`),
      );
    // docs-kit.yml's corpus-ref and pages.yml's bundle build, at least.
    expect(pins.length).toBeGreaterThanOrEqual(2);
    for (const pin of pins) expect(pin.split(':')[1]).toBe(CORPUS_PIN);
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
