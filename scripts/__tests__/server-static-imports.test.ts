import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  assertNoBootDeniedStaticImports,
  BOOT_DENIED_STATIC_IMPORTS,
  staticImportSpecifiers,
} from '../lib/server-static-imports.mjs';

const makeTempDir = trackTempDirs();
function bundle(text: string) {
  const file = join(
    makeTempDir('server-static-imports-'),
    'command-station.js',
  );
  writeFileSync(file, text);
  return file;
}

const denied = ['@anthropic-ai/claude-agent-sdk', '@kontourai/veritas'];

describe('assertNoBootDeniedStaticImports', () => {
  it('denies exactly the packages whose callers load them on first use', () => {
    expect(BOOT_DENIED_STATIC_IMPORTS).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@kontourai/console-server',
      '@kontourai/veritas',
    ]);
  });

  it('reads the static import forms of minified esbuild output', async () => {
    const file = bundle(
      'import{a as b}from"named";import*as c from"namespace";import"bare";' +
        'import d from"default";export*from"reexport";' +
        'const e=await import("dynamic"),f=require("required");' +
        'const g=`import h from "templated"`,i="import j from \'quoted\'";' +
        'console.log(b,c,d,e,f,g,i);',
    );
    expect([...(await staticImportSpecifiers(file))].sort()).toEqual([
      'bare',
      'default',
      'named',
      'namespace',
      'reexport',
    ]);
  });

  it('accepts dynamic imports, requires and packages that only share a prefix', async () => {
    const file = bundle(
      'import{x}from"@kontourai/veritas-lite";' +
        'const s=()=>import("@anthropic-ai/claude-agent-sdk/core");' +
        'const t=require("@kontourai/veritas/engine");' +
        'const u="import{q}from\\"@anthropic-ai/claude-agent-sdk\\"";' +
        'console.log(x,s,t,u);',
    );
    await expect(
      assertNoBootDeniedStaticImports(file, { denied }),
    ).resolves.toBeUndefined();
  });

  it('names each denied package or subpath the bundle imports statically', async () => {
    const file = bundle(
      'import{query as q}from"@anthropic-ai/claude-agent-sdk";' +
        'import*as f from"@kontourai/veritas";import"node:fs";' +
        'import{c}from"@anthropic-ai/claude-agent-sdk/core";' +
        'console.log(q,f,c);',
    );
    await expect(
      assertNoBootDeniedStaticImports(file, { denied }),
    ).rejects.toThrow(
      `${file} statically imports @anthropic-ai/claude-agent-sdk, @anthropic-ai/claude-agent-sdk/core, @kontourai/veritas, which the server must not load at boot.`,
    );
  });

  it('checks the default deny list when none is given', async () => {
    const file = bundle(
      'import"@kontourai/veritas/engine";import"@kontourai/flow-agents";',
    );
    await expect(assertNoBootDeniedStaticImports(file)).rejects.toThrow(
      /statically imports @kontourai\/veritas\/engine, which/,
    );
  });

  it('fails closed on a bundle esbuild cannot parse', async () => {
    const file = bundle('import{from"broken";');
    await expect(assertNoBootDeniedStaticImports(file)).rejects.toThrow();
  });
});
