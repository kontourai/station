import {
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Zero-tolerance grep-gate for `packages/sdk/src/client/**` (#167 AC6),
 * modeled on this repo's existing `npm run rename:inventory` pattern
 * (CLAUDE.md): a hand-rolled `readFileSync` + regex check per file, not a
 * separate lint plugin or tsconfig project.
 *
 * `client/**` is imported by `src-server/tools/station-control-*.ts`, which
 * is esbuild-bundled into `dist-server/command-station.js` — `@kontourai/station-sdk`
 * is not in `esbuild.config.mjs`'s `external` list, so anything reachable
 * from `client/**` gets inlined at bundle time. A stray `react`/`.tsx`/`.css`
 * import (or a reach-back into the hook/provider/component surface, which
 * could transitively pull one in) would silently break that server build.
 *
 * #167 iteration-2 (L1): the original four named reach-back patterns
 * (`../hooks`, `../providers`, `../components`, `../layout`) only banned the
 * specific paths the audit happened to name — a new reach-back into some
 * other `../` sibling of `client/` (e.g. a future `../api` or `../utils`)
 * would slip through undetected. Banning *any* `../`-relative import makes
 * the gate transitive-by-construction: every file under `client/**` may
 * only import its own siblings (`./foo`) or `./http`, so nothing outside
 * this directory can be reached at all, named exception or not. Dynamic
 * `import(...)`/`require(...)` calls are banned for the same reason — a
 * static-analysis gate over `import ... from '...'` statements can't see
 * through them.
 */

const CLIENT_DIR = join(__dirname, '..', 'client');

const BANNED_IMPORT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "import from 'react'", pattern: /from\s+['"]react['"]/ },
  { label: "import from 'react-dom'", pattern: /from\s+['"]react-dom['"]/ },
  {
    label: "import from '@tanstack/react-query'",
    pattern: /from\s+['"]@tanstack\/react-query['"]/,
  },
  { label: 'import of a .tsx file', pattern: /from\s+['"][^'"]+\.tsx['"]/ },
  { label: 'import of a .css file', pattern: /from\s+['"][^'"]+\.css['"]/ },
  {
    label:
      "relative import reaching outside client/ (only './' siblings are allowed)",
    pattern: /from\s+['"]\.\.\//,
  },
  {
    label: 'dynamic import(...) call',
    pattern: /\bimport\s*\(/,
  },
  {
    label: 'require(...) call',
    pattern: /\brequire\s*\(/,
  },
];

function listTsFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listTsFilesRecursively(fullPath));
      continue;
    }
    if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanForViolations(files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, 'utf-8');
    for (const { label, pattern } of BANNED_IMPORT_PATTERNS) {
      if (pattern.test(contents)) {
        violations.push(`${file}: ${label}`);
      }
    }
  }
  return violations;
}

describe('client-entry portability (#167 AC6)', () => {
  const files = listTsFilesRecursively(CLIENT_DIR);

  it('finds at least one file under packages/sdk/src/client', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it(
    'contains no react/react-dom/@tanstack/react-query/.tsx/.css imports, no ' +
      "'../'-relative imports reaching outside client/, and no dynamic " +
      'import()/require() calls',
    () => {
      const violations = scanForViolations(files);
      expect(violations).toEqual([]);
    },
  );

  it('negative control: the scan actually flags a planted violation (then restores)', () => {
    const fixturePath = join(CLIENT_DIR, '__portability-negative-control__.ts');
    writeFileSync(
      fixturePath,
      "import { useSomething } from '../hooks/useSomething';\n" +
        "const lazy = () => import('./http');\n",
    );
    try {
      const violations = scanForViolations(listTsFilesRecursively(CLIENT_DIR));
      expect(
        violations.some(
          (v) =>
            v.includes('__portability-negative-control__.ts') &&
            v.includes('relative import reaching outside client/'),
        ),
      ).toBe(true);
      expect(
        violations.some(
          (v) =>
            v.includes('__portability-negative-control__.ts') &&
            v.includes('dynamic import(...) call'),
        ),
      ).toBe(true);
    } finally {
      unlinkSync(fixturePath);
    }
  });
});
