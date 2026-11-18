import * as esbuild from 'esbuild';

// Every static `import ... from '<package>'` in the server bundle is evaluated
// when the server boots, whether or not the code that uses it ever runs.
// These packages cost several MiB to tens of MiB of memory each and an idle
// server needs none of them, so their callers load them on first use. A
// static value import of one anywhere in the server source silently restores
// the boot cost; this check fails the build instead.
//
// Each entry denies a whole package: the package itself and every subpath
// (`@kontourai/veritas` costs as much as `@kontourai/veritas/engine`, and
// `@anthropic-ai/claude-agent-sdk/core` nearly as much as the SDK's root).
export const BOOT_DENIED_STATIC_IMPORTS = Object.freeze([
  '@anthropic-ai/claude-agent-sdk',
  '@kontourai/console-server',
  '@kontourai/veritas',
]);

// Each entry denies one exact specifier. The `@kontourai/flow-agents` root
// re-exports the whole package, while the narrow subpaths synchronous Station
// callers need cost a small fraction of it and stay static.
export const BOOT_DENIED_EXACT_STATIC_IMPORTS = Object.freeze([
  '@kontourai/flow-agents',
]);

function isDenied(specifier, denied, deniedExact) {
  return (
    deniedExact.includes(specifier) ||
    denied.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    )
  );
}

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
 * Throws when the bundle at `file` statically imports any package in
 * `denied` or a subpath of one, or any specifier in `deniedExact`, naming
 * each imported specifier.
 */
export async function assertNoBootDeniedStaticImports(
  file,
  {
    denied = BOOT_DENIED_STATIC_IMPORTS,
    deniedExact = BOOT_DENIED_EXACT_STATIC_IMPORTS,
  } = {},
) {
  const imported = await staticImportSpecifiers(file);
  const found = [...imported]
    .filter((specifier) => isDenied(specifier, denied, deniedExact))
    .sort();
  if (found.length === 0) return;
  throw new Error(
    `${file} statically imports ${found.join(', ')}, which the server must ` +
      'not load at boot. Import types with `import type` and load values on ' +
      'first use, with a dynamic import() or a CommonJS require() ' +
      '(scripts/lib/server-static-imports.mjs).',
  );
}
