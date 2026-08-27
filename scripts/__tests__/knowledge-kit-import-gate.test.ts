import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEEP_IMPORT_PATTERN,
  FS_PATH_WORKAROUND_PATTERN,
  listScopedFiles,
  scanFileForKitInternalImports,
} from '../knowledge-kit-import-gate.mjs';

// A cold scan of the real 500+ file tree takes about 7s on the native Windows
// floor; this bound dominates that measured operation without weakening the
// fast synthetic cases below.
const COLD_REPOSITORY_SCAN_TIMEOUT_MS = 30_000;

describe('knowledge-kit-import-gate', () => {
  describe('DEEP_IMPORT_PATTERN', () => {
    it('matches an ESM import specifier reaching under kits/', () => {
      expect(
        DEEP_IMPORT_PATTERN.test(
          "import x from '@kontourai/flow-agents/kits/knowledge/adapters/default-store/index.js';",
        ),
      ).toBe(true);
    });

    it('matches a dynamic import() reaching under build/', () => {
      expect(
        DEEP_IMPORT_PATTERN.test(
          "await import('@kontourai/flow-agents/build/src/index.js');",
        ),
      ).toBe(true);
    });

    it('matches a require() reaching under src/', () => {
      expect(
        DEEP_IMPORT_PATTERN.test(
          "const x = require('@kontourai/flow-agents/src/internal.js');",
        ),
      ).toBe(true);
    });

    it('does NOT match the bare package specifier (the exported "." entry)', () => {
      expect(
        DEEP_IMPORT_PATTERN.test("import { X } from '@kontourai/flow-agents';"),
      ).toBe(false);
    });

    it('does NOT match the exported ./package.json subpath', () => {
      expect(
        DEEP_IMPORT_PATTERN.test(
          "require.resolve('@kontourai/flow-agents/package.json')",
        ),
      ).toBe(false);
    });

    it('does NOT match a bare prose mention of the package name', () => {
      expect(
        DEEP_IMPORT_PATTERN.test(
          '// These types mirror @kontourai/flow-agents published sidecar schemas',
        ),
      ).toBe(false);
    });
  });

  describe('FS_PATH_WORKAROUND_PATTERN', () => {
    it('matches the segmented raw-filesystem escape hatch', () => {
      const source =
        "readFileSync(join('node_modules', '@kontourai', 'flow-agents', 'kits', 'knowledge', 'adapters', 'default-store', 'index.js'), 'utf-8')";
      expect(FS_PATH_WORKAROUND_PATTERN.test(source)).toBe(true);
    });

    it('matches across a realistic multi-line join() call', () => {
      const source = [
        'const p = join(',
        "  'node_modules',",
        "  '@kontourai',",
        "  'flow-agents',",
        "  'build',",
        "  'src',",
        "  'index.js',",
        ');',
      ].join('\n');
      expect(FS_PATH_WORKAROUND_PATTERN.test(source)).toBe(true);
    });

    it('does NOT match an unrelated node_modules reference elsewhere in the tree', () => {
      const source =
        "if (existsSync(join(cwd, 'node_modules/.bin/esbuild'))) { return; }";
      expect(FS_PATH_WORKAROUND_PATTERN.test(source)).toBe(false);
    });

    it('does NOT match node_modules/@kontourai references to a DIFFERENT package', () => {
      const source =
        "join('node_modules', '@kontourai', 'station-contracts', 'kits', 'x.js')";
      expect(FS_PATH_WORKAROUND_PATTERN.test(source)).toBe(false);
    });

    it('does NOT match node_modules + @kontourai/flow-agents alone (package root, no internal subpath)', () => {
      const source = "join('node_modules', '@kontourai', 'flow-agents')";
      expect(FS_PATH_WORKAROUND_PATTERN.test(source)).toBe(false);
    });
  });

  describe('scanFileForKitInternalImports', () => {
    it('flags a synthetic deep-import violation with file/line/snippet naming the offender', () => {
      const source =
        "import { readRecord } from '@kontourai/flow-agents/kits/knowledge/adapters/default-store/index.js';\n" +
        'export function useIt() { return readRecord; }\n';
      const findings = scanFileForKitInternalImports(
        'src-server/knowledge-store/evil.ts',
        source,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        file: 'src-server/knowledge-store/evil.ts',
        line: 1,
        kind: 'deep-import',
      });
      expect(findings[0].snippet).toContain(
        '@kontourai/flow-agents/kits/knowledge/adapters/default-store/index.js',
      );
    });

    it('flags a synthetic fs-workaround violation', () => {
      const source =
        "const p = join('node_modules', '@kontourai', 'flow-agents', 'kits', 'x.js');\n" +
        'const raw = readFileSync(p, "utf-8");\n';
      const findings = scanFileForKitInternalImports(
        'src-server/knowledge-store/evil-fs.ts',
        source,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].kind).toBe('fs-workaround');
      expect(findings[0].line).toBe(1);
    });

    it('flags both shapes in the same file independently', () => {
      const source =
        "import x from '@kontourai/flow-agents/kits/a.js';\n" +
        "const p = join('node_modules', '@kontourai', 'flow-agents', 'build', 'x.js');\n";
      const findings = scanFileForKitInternalImports('both.ts', source);
      expect(findings.map((f) => f.kind).sort()).toEqual([
        'deep-import',
        'fs-workaround',
      ]);
    });

    it('finds nothing in a legitimate file using only the exported "." entry', () => {
      const source =
        "import { readWorkflowState } from '@kontourai/flow-agents';\n" +
        "const pkgPath = require.resolve('@kontourai/flow-agents/package.json');\n";
      const findings = scanFileForKitInternalImports('legit.ts', source);
      expect(findings).toHaveLength(0);
    });
  });

  describe('gate against a synthetic on-disk fixture file (not committed to the real tree)', () => {
    it('reads a real temp-dir file and flags it, naming the exact file path + line', () => {
      const dir = mkdtempSync(
        join(tmpdir(), 'knowledge-kit-import-gate-fixture-'),
      );
      try {
        const fixturePath = join(dir, 'synthetic-violation.ts');
        writeFileSync(
          fixturePath,
          '// A contributor reaches past the exports map:\n' +
            "import { DefaultKnowledgeStore } from '@kontourai/flow-agents/kits/knowledge/adapters/default-store/index.js';\n",
          'utf-8',
        );
        const content = readFileSync(fixturePath, 'utf-8');
        const findings = scanFileForKitInternalImports(fixturePath, content);
        expect(findings).toHaveLength(1);
        expect(findings[0].file).toBe(fixturePath);
        expect(findings[0].line).toBe(2);
        expect(findings[0].kind).toBe('deep-import');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('listScopedFiles + scanFileForKitInternalImports (repo-source integration)', () => {
    it(
      'passes cleanly against the real src-server/**, packages/**, src-ui/** trees as of this PR',
      () => {
        const files = listScopedFiles();
        expect(files.length).toBeGreaterThan(500); // sanity: the scan actually ran
        const findings = files.flatMap((file) =>
          scanFileForKitInternalImports(file, readFileSync(file, 'utf-8')),
        );
        expect(findings).toEqual([]);
      },
      COLD_REPOSITORY_SCAN_TIMEOUT_MS,
    );

    it('excludes this gate script itself (which legitimately names the banned patterns in prose/regex)', () => {
      const files = listScopedFiles();
      expect(files).not.toContain('scripts/knowledge-kit-import-gate.mjs');
    });
  });
});
