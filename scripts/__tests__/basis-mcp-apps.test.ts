import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
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

describe('Basis MCP app freshness routing', () => {
  test('keeps the mandatory check in both pre-push and ci-fast PR routing', () => {
    expect(readFileSync('.githooks/pre-push', 'utf8')).toContain(
      'node scripts/check-basis-mcp-apps.mjs',
    );
    expect(readFileSync('scripts/run-ci-fast.mjs', 'utf8')).toContain(
      "['scripts/check-basis-mcp-apps.mjs']",
    );
  });
});
