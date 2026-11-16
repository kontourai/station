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

const denied = ['@anthropic-ai/claude-agent-sdk', '@kontourai/flow-agents'];

describe('assertNoBootDeniedStaticImports', () => {
  it('denies exactly the packages whose callers load them on first use', () => {
    expect(BOOT_DENIED_STATIC_IMPORTS).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@kontourai/console-server',
      '@kontourai/veritas/engine',
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

  it('accepts dynamic imports, requires and subpaths of a denied package', async () => {
    const file = bundle(
      'import{x}from"@kontourai/flow-agents/console-contract";' +
        'const s=()=>import("@anthropic-ai/claude-agent-sdk");' +
        'const t=require("@kontourai/flow-agents");' +
        'const u="import{q}from\\"@anthropic-ai/claude-agent-sdk\\"";' +
        'console.log(x,s,t,u);',
    );
    await expect(
      assertNoBootDeniedStaticImports(file, { denied }),
    ).resolves.toBeUndefined();
  });

  it('names each denied package the bundle imports statically', async () => {
    const file = bundle(
      'import{query as q}from"@anthropic-ai/claude-agent-sdk";' +
        'import*as f from"@kontourai/flow-agents";import"node:fs";' +
        'console.log(q,f);',
    );
    await expect(
      assertNoBootDeniedStaticImports(file, { denied }),
    ).rejects.toThrow(
      `${file} statically imports @anthropic-ai/claude-agent-sdk, @kontourai/flow-agents, which the server must not load at boot.`,
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
