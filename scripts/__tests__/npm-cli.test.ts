import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmInvocation, resolveNpmCli } from '../lib/npm-cli.mjs';

function fixtureNode() {
  const root = mkdtempSync(resolve(tmpdir(), 'station-npm-invocation-'));
  const node = resolve(root, 'node.exe');
  const npmCli = resolve(root, 'node_modules/npm/bin/npm-cli.js');
  mkdirSync(resolve(npmCli, '..'), { recursive: true });
  writeFileSync(node, 'node');
  writeFileSync(npmCli, 'console.log("npm")');
  return { root, node, npmCli };
}

describe('npmInvocation (#1093)', () => {
  it('runs npm through the current node binary rather than a bare `npm`', () => {
    // The regression: `spawnSync('npm', ...)` throws ENOENT on Windows,
    // because npm is `npm.cmd` and CreateProcess cannot execute it. That took
    // the whole pre-push hook down, so no Windows contributor could push.
    const { root, node, npmCli } = fixtureNode();
    try {
      const invocation = npmInvocation(['run', '--silent', 'build:ui'], {
        env: {},
        node,
      });
      expect(invocation).toEqual({
        command: node,
        args: [npmCli, 'run', '--silent', 'build:ui'],
      });
      // The two shapes that reintroduce the bug: a bare `npm` the platform
      // must resolve, or a `.cmd`/`.bat` shim that needs a shell to run.
      expect(invocation.command).not.toBe('npm');
      expect(invocation.command).not.toMatch(/\.(cmd|bat)$/i);
      expect(invocation.args.some((arg) => /\.(cmd|bat)$/i.test(arg))).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the npm that invoked us over the one beside node', () => {
    // Under `npm run`, npm_execpath names the exact npm in play; preferring it
    // keeps a script from silently using a different npm than its caller.
    const { root, node } = fixtureNode();
    const other = mkdtempSync(resolve(tmpdir(), 'station-npm-execpath-'));
    try {
      const execpathCli = resolve(other, 'npm-cli.js');
      writeFileSync(execpathCli, 'console.log("npm")');
      expect(
        npmInvocation(['--version'], {
          env: { npm_execpath: execpathCli },
          node,
        }),
      ).toEqual({ command: node, args: [execpathCli, '--version'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('passes an empty argument list through unchanged', () => {
    const { root, node, npmCli } = fixtureNode();
    try {
      expect(npmInvocation([], { env: {}, node })).toEqual({
        command: node,
        args: [npmCli],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveNpmCli shared entry point (#1093)', () => {
  it('is the same implementation dependency-lifecycle exports', async () => {
    // The resolution logic used to live only in dependency-lifecycle.mjs
    // while four other call sites spawned a bare `npm`. Pin the re-export so
    // a future edit cannot fork them apart again.
    const lifecycle = await import('../dependency-lifecycle.mjs');
    expect(lifecycle.resolveNpmCli).toBe(resolveNpmCli);
  });

  it('still refuses a Windows command shim', () => {
    expect(() => resolveNpmCli({ npm_execpath: 'C:\\npm.cmd' })).toThrow(
      /npm_execpath/,
    );
  });
});
