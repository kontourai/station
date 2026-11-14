import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { npmInvocation } from '../lib/npm-cli.mjs';
import { selectChangedVerification } from '../run-changed-verification.mjs';
import { FAST_STATIC_COMMANDS, runCiFast } from '../run-ci-fast.mjs';
import { buildTestImpactManifest } from '../test-impact-manifest.mjs';

const makeTempDir = trackTempDirs();

/** Run the real fast lane, executing only `gate` and stubbing the rest green. */
function runOnlyFastGate(
  cwd: string,
  gate: readonly [string, readonly string[]],
): { status: number; output: string } {
  let output = '';
  const status = runCiFast({
    cwd,
    env: { STATION_CI_FAST_BASE: 'fixture-base' },
    execute(command, args, { cwd: childCwd, timeout }) {
      if (command !== gate[0] || args !== gate[1]) return 0;
      const invocation =
        command === 'npm' ? npmInvocation(args) : { command, args };
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: childCwd,
        timeout,
        encoding: 'utf8',
        windowsHide: true,
      });
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      return result.status ?? 1;
    },
  });
  return { status, output };
}

// Its own file so that only this suite, which really reads pnpm-lock.yaml,
// joins the lockfile-change selection.
describe('ci:fast generated conformance freshness', () => {
  // A stale generated Conduit conformance artifact kept main qualification red
  // for about six days because no pull-request lane ran its check. Drive the
  // real generator through the fast lane against a fixture root that shares
  // this checkout's lockfile, sources and installed packages but owns its
  // own docs/conformance copy, so the test never writes the real artifact.
  it.skipIf(process.platform === 'win32')(
    'fails the fast lane on a stale generated conformance artifact and passes a fresh one',
    () => {
      const gate = (
        FAST_STATIC_COMMANDS as readonly (readonly [
          string,
          readonly string[],
        ])[]
      ).find(
        ([command, args]) =>
          command === 'npm' &&
          args.join(' ') === 'run conduit:conformance:check',
      );
      if (!gate) throw new Error('conduit:conformance:check is not in ci:fast');
      const repo = process.cwd();
      const manifest = JSON.parse(
        readFileSync(join(repo, 'package.json'), 'utf8'),
      );
      // The generator is named by the package script, not spelled here: a
      // spelled script path makes the spawned-script scan follow its whole
      // import closure, including the adapter's type-only import of the
      // runtime types, and select this suite for most of src-server. Its
      // real inputs are explicit UNMODELLED_INPUT_EDGES instead.
      const generator = /\bscripts\/\S+\.mjs\b/.exec(
        manifest.scripts['conduit:conformance:check'],
      )?.[0];
      if (!generator) throw new Error('conformance generator not found');
      const dir = makeTempDir('station-ci-fast-conformance-');
      for (const file of [
        generator,
        'scripts/lib/pnpm-lockfile.mjs',
        // The adapter's only runtime import is the Conduit package; its
        // type-only import of the runtime types is erased by tsx.
        'src-server/runtime/frameworks/conduit-framework-adapter.ts',
        'docs/conformance/station-runtime-conformance.json',
        'docs/conformance/station-runtime-conformance.md',
      ]) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        copyFileSync(join(repo, file), join(dir, file));
      }
      for (const shared of ['node_modules', 'pnpm-lock.yaml', 'tsconfig.json'])
        symlinkSync(join(repo, shared), join(dir, shared));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          type: 'module',
          scripts: {
            'conduit:conformance:check':
              manifest.scripts['conduit:conformance:check'],
          },
        }),
      );

      const fresh = runOnlyFastGate(dir, gate);
      expect(fresh.status, fresh.output).toBe(0);

      const markdown = join(
        dir,
        'docs/conformance/station-runtime-conformance.md',
      );
      writeFileSync(markdown, `${readFileSync(markdown, 'utf8')}stale\n`);
      const stale = runOnlyFastGate(dir, gate);
      expect(stale.status).toBe(1);
      expect(stale.output).toMatch(
        /station-runtime-conformance\.md is stale; run npm run conduit:conformance:generate/,
      );
    },
  );

  // Selection follows the inputs the check really reads, and only those.
  it('is selected by its real inputs and not by unrelated server sources', () => {
    const suite = 'scripts/__tests__/ci-fast-conformance.test.ts';
    // The manifest the real selector uses, including the derived path-read
    // and spawned-script edges.
    const manifest = buildTestImpactManifest({ root: process.cwd() });
    const selected = (path: string) =>
      selectChangedVerification(
        [path],
        manifest as Parameters<typeof selectChangedVerification>[1],
      ).tests.some((entry: { path: string }) => entry.path === suite);
    // The generator is read from the package script here too: spelling its
    // path in this file is exactly what pulled in the spawned-script scan.
    const generator = /\bscripts\/\S+\.mjs\b/.exec(
      JSON.parse(readFileSync('package.json', 'utf8')).scripts[
        'conduit:conformance:check'
      ],
    )?.[0];
    expect(generator).toMatch(/^scripts\/[\w-]+\.mjs$/);
    for (const input of [
      generator ?? '',
      'scripts/lib/pnpm-lockfile.mjs',
      'src-server/runtime/frameworks/conduit-framework-adapter.ts',
      'docs/conformance/station-runtime-conformance.md',
      'pnpm-lock.yaml',
    ])
      expect(selected(input), input).toBe(true);
    for (const unrelated of [
      'src-server/security/pairing-route-scopes.ts',
      'src-server/runtime/types.ts',
    ])
      expect(selected(unrelated), unrelated).toBe(false);
  });

  // The explicit input edges must keep up with the generator. This follows
  // only STATIC RELATIVE runtime imports (type-only imports are erased by
  // tsx and skipped) from the generator outward, plus the repository paths
  // the generator spells as string literals. It cannot see a path built at
  // run time, a dynamic import, or a file a package reads; pnpm-lock.yaml,
  // read through scripts/lib/pnpm-lockfile.mjs's root argument, is one such
  // input and is listed by hand in the edges instead.
  it('covers every static relative import and literal path the generator reads', () => {
    const repo = process.cwd();
    const generator = /\bscripts\/\S+\.mjs\b/.exec(
      JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts[
        'conduit:conformance:check'
      ],
    )?.[0];
    if (!generator) throw new Error('conformance generator not found');
    const resolveImport = (from: string, specifier: string) => {
      const base = join(dirname(from), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.mjs`,
        base.replace(/\.js$/, '.ts'),
      ])
        if (existsSync(join(repo, candidate)) && candidate.includes('.'))
          return candidate;
      throw new Error(`cannot resolve ${specifier} from ${from}`);
    };
    const inputs = new Set<string>();
    const pending = [generator];
    while (pending.length) {
      const file = pending.pop() as string;
      if (inputs.has(file)) continue;
      inputs.add(file);
      const source = readFileSync(join(repo, file), 'utf8');
      for (const match of source.matchAll(
        /^import\s+(?!type\b)[^;]*?from\s+'(\.{1,2}\/[^']+)'/gms,
      ))
        pending.push(resolveImport(file, match[1]));
      if (file === generator)
        for (const match of source.matchAll(
          /'((?:docs|src-server|scripts|config)\/[^']+\.[a-z]+)'/g,
        ))
          inputs.add(match[1]);
    }
    // The walk must at least reach what the fixture copies.
    expect(inputs).toContain(
      'src-server/runtime/frameworks/conduit-framework-adapter.ts',
    );
    expect(inputs).toContain(
      'docs/conformance/station-runtime-conformance.json',
    );
    const manifest = buildTestImpactManifest({ root: repo });
    const suite = 'scripts/__tests__/ci-fast-conformance.test.ts';
    for (const input of inputs)
      expect(
        selectChangedVerification(
          [input],
          manifest as Parameters<typeof selectChangedVerification>[1],
        ).tests.some((entry: { path: string }) => entry.path === suite),
        `${input} has no impact edge to ${suite}`,
      ).toBe(true);
  });
});
