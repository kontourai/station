/**
 * The engine host-auth issuer, responder, vault and secret store must not be
 * able to reach Station's own principals: the internal API token, the
 * connection service's model credentials, the station-control MCP bearer,
 * or the engine API-key store. Checked over the runtime import graph
 * (type-only imports are erased and do not count), transitively, so a
 * helper module cannot smuggle one in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

const FORBIDDEN = [
  'src-server/utils/internal-api-token.ts',
  'src-server/services/connections/connection-service.ts',
  'src-server/runtime/mcp/station-control-mcp-token.ts',
  'src-server/services/acp/engine-credentials.ts',
];

const ROOTS = [
  'src-server/services/engine-host-auth/responder.ts',
  'src-server/services/engine-host-auth/issuer.ts',
  'src-server/services/engine-host-auth/vault.ts',
  'src-server/services/engine-host-auth/engine-secret-store.ts',
  'src-server/services/engine-host-auth/service.ts',
  'src-server/services/engine-host-auth/kiro-oidc/oidc.ts',
  'src-server/services/engine-host-auth/kiro-oidc/kiro-sign-in.ts',
];

/** Value imports and re-exports: `import type` / `export type` are erased. */
function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(statement)) {
    if (match[2]) continue;
    out.push(match[4] as string);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g))
    out.push(match[1] as string);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
    out.push(match[1] as string);
  return out;
}

function packageExport(specifier: string): string | undefined {
  const match = /^@kontourai\/station-(contracts|shared)\/(.+)$/.exec(
    specifier,
  );
  if (!match) return undefined;
  const pkgDir = join(ROOT, 'packages', match[1] as string);
  const manifest = JSON.parse(
    readFileSync(join(pkgDir, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  const target = manifest.exports?.[`./${match[2]}`];
  const path =
    typeof target === 'string'
      ? target
      : typeof (target as { import?: unknown })?.import === 'string'
        ? (target as { import: string }).import
        : undefined;
  return path ? join(pkgDir, path) : undefined;
}

function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.js$/, '.tsx'),
      base,
      `${base}.ts`,
      join(base, 'index.ts'),
    ])
      if (existsSync(candidate) && candidate.match(/\.(ts|tsx|mjs|js)$/))
        return candidate;
    return undefined;
  }
  return packageExport(specifier);
}

/** Every repository file reachable from `start` through runtime imports, with the path that reached it. */
function reachable(start: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = readFileSync(file, 'utf8');
    for (const specifier of runtimeSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (!target || seen.has(target)) continue;
      seen.set(target, [...(seen.get(file) ?? []), target]);
      queue.push(target);
    }
  }
  return seen;
}

describe('engine host-auth import boundary', () => {
  test('the walker sees through a re-export and skips type-only imports', () => {
    expect(
      runtimeSpecifiers(
        "import type { A } from './a.js';\nimport { b } from './b.js';\nexport { c } from './c.js';\nexport type { D } from './d.js';\nimport './e.js';",
      ),
    ).toEqual(['./b.js', './c.js', './e.js']);
  });

  test('the walker reaches a forbidden module when one is imported (the check can fail)', () => {
    // engine-auth-status imports engine-credentials at runtime today.
    const graph = reachable(
      join(ROOT, 'src-server/services/acp/engine-auth-status.ts'),
    );
    expect([...graph.keys()].map((file) => relative(ROOT, file))).toContain(
      'src-server/services/acp/engine-credentials.ts',
    );
  });

  test.each(ROOTS)('%s reaches none of Station’s own principals', (root) => {
    const graph = reachable(join(ROOT, root));
    const hits = FORBIDDEN.flatMap((forbidden) => {
      const path = graph.get(join(ROOT, forbidden));
      return path
        ? [path.map((file) => relative(ROOT, file)).join(' -> ')]
        : [];
    });
    expect(hits).toEqual([]);
  });
});
