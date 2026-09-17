import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { BASIS_MCP_APP_MANIFEST } from '../basis-mcp-app-manifest.mjs';
import { inspectGeneratedBuildInputs } from '../check-dist-freshness.mjs';
import { generateBuildInputs } from '../dependency-lifecycle.mjs';
import {
  biomeFormatterInvocation,
  generateBasisMcpApps,
} from '../generate-basis-mcp-apps.mjs';

describe('Basis MCP app generator', () => {
  test('runs the package Biome entrypoint through Node on every host', () => {
    expect(
      biomeFormatterInvocation(
        '/repo',
        'packages/basis-pane/generated.ts',
        '/node',
      ),
    ).toEqual({
      command: '/node',
      args: [
        expect.stringMatching(
          /node_modules[/\\]@biomejs[/\\]biome[/\\]bin[/\\]biome$/,
        ),
        'format',
        expect.stringMatching(
          /--stdin-file-path=.*packages[/\\]basis-pane[/\\]generated\.ts$/,
        ),
      ],
    });
  });

  test('builds every manifest entry twice and writes only after equality', async () => {
    const calls: string[] = [];
    const writes: Array<[string, string]> = [];
    await generateBasisMcpApps({
      manifest: [{ id: 'fixture', entry: 'entry.ts', output: 'output.ts' }],
      buildApp: async () => {
        calls.push('build');
        return 'generated';
      },
      write: async (path, text) => writes.push([path, text]),
    });
    expect(calls).toEqual(['build', 'build']);
    expect(writes).toEqual([
      [expect.stringContaining('output.ts'), 'generated'],
    ]);
  });

  test('refuses non-deterministic builds before writing', async () => {
    let call = 0;
    const write = vi.fn();
    await expect(
      generateBasisMcpApps({
        manifest: [{ id: 'fixture', entry: 'entry.ts', output: 'output.ts' }],
        buildApp: async () => `generated-${call++}`,
        write,
      }),
    ).rejects.toThrow('Non-deterministic Basis MCP app build for fixture');
    expect(write).not.toHaveBeenCalled();
  });

  test('check mode never writes and reports bounded stale bytes, hashes, and repair', async () => {
    const write = vi.fn();
    const expected = `${'unchanged\n'.repeat(100_000)}expected`;
    const actual = `${'unchanged\n'.repeat(100_000)}actual`;
    let diagnostic = '';
    try {
      await generateBasisMcpApps({
        manifest: [{ id: 'fixture', entry: 'entry.ts', output: 'output.ts' }],
        check: true,
        buildApp: async () => expected,
        read: async () => actual,
        write,
      });
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).not.toBe('');
    expect(diagnostic).toContain('Generated Basis MCP app is stale: output.ts');
    expect(diagnostic).toMatch(/actual: \d+ bytes sha256 [a-f0-9]{64}/);
    expect(diagnostic).toMatch(/expected: \d+ bytes sha256 [a-f0-9]{64}/);
    expect(diagnostic).toContain('first differing byte: 1000000');
    expect(diagnostic).toContain('actual context');
    expect(diagnostic).toContain('expected context');
    expect(diagnostic).toContain('Repair with:\n  npm run basis:mcp:generate');
    expect(diagnostic.length).toBeLessThan(2_000);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('Basis MCP app output routing', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const outputs = BASIS_MCP_APP_MANIFEST.map((app) => app.output);
  const git = (args: string[], input?: string) =>
    spawnSync('git', args, {
      cwd: root,
      input,
      encoding: 'utf8',
      windowsHide: true,
    });

  test('every manifest output is git-ignored build output, not a tracked file', () => {
    // Asked of git, not of .gitignore's text: a rule that no longer matches
    // and a file re-added with `git add -f` are both invisible to a grep.
    const ignored = git(['check-ignore', '--stdin'], `${outputs.join('\n')}\n`);
    expect(ignored.status).toBe(0);
    expect(ignored.stdout.trim().split('\n').sort()).toEqual(
      [...outputs].sort(),
    );
    const tracked = git(['ls-files', '--', ...outputs]);
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.trim()).toBe('');
  });

  test('dependency install generates the bundles inside a checkout', () => {
    // Fresh checkouts get the bundles from `dependencies:ci`; outside a
    // checkout (the container's manifest-only dependencies stage) there is
    // nothing to build and the install must not fail.
    const dotGit = resolve(root, '.git');
    const run = vi.fn();
    const log = vi.fn();
    generateBuildInputs({ run, exists: (path) => path === dotGit, log });
    expect(run).toHaveBeenCalledWith(process.execPath, [
      'scripts/generate-basis-mcp-apps.mjs',
    ]);
    expect(log).not.toHaveBeenCalled();

    const absent = vi.fn();
    const absentLog = vi.fn();
    generateBuildInputs({ run: absent, exists: () => false, log: absentLog });
    expect(absent).not.toHaveBeenCalled();
    expect(absentLog).toHaveBeenCalledWith(
      expect.stringContaining('NOT_APPLICABLE Basis MCP app generation'),
    );
  });

  test('dist:freshness names a missing bundle and its remedy instead of a bare TS2307', () => {
    const manifest = [
      {
        id: 'fixture',
        entry: 'src/app.browser.ts',
        output: 'src/app.generated.ts',
      },
    ];
    const has = (...present: string[]) => ({
      repoRoot: '/repo',
      manifest,
      exists: (path: string) => present.some((p) => path.endsWith(p)),
    });
    const missing = inspectGeneratedBuildInputs(has('src/app.browser.ts'));
    expect(missing.failures).toHaveLength(1);
    expect(missing.failures[0]).toContain('src/app.generated.ts is MISSING');
    expect(missing.failures[0]).toContain('Fix: npm run basis:mcp:generate');
    const present = inspectGeneratedBuildInputs(
      has('src/app.browser.ts', 'src/app.generated.ts'),
    );
    expect(present.failures).toEqual([]);
    expect(present.lines[0]).toContain('src/app.generated.ts is present');
    // No entry in the tree: nothing to generate, and not a failure.
    const absent = inspectGeneratedBuildInputs(has());
    expect(absent.failures).toEqual([]);
    expect(absent.lines[0]).toContain('nothing to generate');
    // The real manifest, this real tree: the gate `npm run typecheck` chains.
    expect(inspectGeneratedBuildInputs({ repoRoot: root }).failures).toEqual(
      [],
    );
  });

  test('generation runs where the readers of the output run', () => {
    // Builds: build:basis-pane, and `station build` (its step order is pinned
    // by packages/cli/src/__tests__/lifecycle.test.ts, which is what the
    // container's build stage and `station upgrade` run). ci:fast: as the
    // typecheck aggregate's precondition, like build:connect.
    expect(
      JSON.parse(readFileSync('package.json', 'utf8')).scripts[
        'build:basis-pane'
      ],
    ).toMatch(/^npm run basis:mcp:generate && /);
    expect(readFileSync('scripts/run-ci-fast.mjs', 'utf8')).toContain(
      "['scripts/generate-basis-mcp-apps.mjs']",
    );
  });
});
