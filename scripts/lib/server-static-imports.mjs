import * as esbuild from 'esbuild';

// Every static `import ... from '<package>'` in the server bundle is evaluated
// when the server boots, whether or not the code that uses it ever runs.
// These packages cost several MiB to tens of MiB of memory each and an idle
// server needs none of them, so their callers load them on first use. A
// static value import of one anywhere in the server source silently restores
// the boot cost; this check fails the build instead.
//
// Specifiers are compared exactly: a denied package root does not deny its
// subpaths. `@kontourai/flow-agents` (the root barrel) is not listed yet:
// synchronous Station callers still need values that only the root exports.
export const BOOT_DENIED_STATIC_IMPORTS = Object.freeze([
  '@anthropic-ai/claude-agent-sdk',
  '@kontourai/console-server',
  '@kontourai/veritas/engine',
]);

/**
 * The specifiers `file` imports with a static `import`/`export ... from`
 * statement, as esbuild's own parser reads them. Dynamic `import()` and
 * `require()` calls are not static imports and are not returned; text that
 * only looks like an import (inside a string or template) is not either.
 */
export async function staticImportSpecifiers(file) {
  const result = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    external: ['*'],
    format: 'esm',
    platform: 'node',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.values(result.metafile.inputs);
  if (inputs.length !== 1) {
    throw new Error(
      `Expected esbuild to read only ${file}, but it read ${inputs.length} inputs.`,
    );
  }
  return new Set(
    inputs[0].imports
      .filter((entry) => entry.kind === 'import-statement')
      .map((entry) => entry.path),
  );
}

/**
 * Throws when the bundle at `file` statically imports any specifier in
 * `denied`, naming each one.
 */
export async function assertNoBootDeniedStaticImports(
  file,
  { denied = BOOT_DENIED_STATIC_IMPORTS } = {},
) {
  const imported = await staticImportSpecifiers(file);
  const found = denied.filter((specifier) => imported.has(specifier));
  if (found.length === 0) return;
  throw new Error(
    `${file} statically imports ${found.join(', ')}, which the server must ` +
      'not load at boot. Import types with `import type` and load values on ' +
      'first use, with a dynamic import() or a CommonJS require() ' +
      '(scripts/lib/server-static-imports.mjs).',
  );
}
