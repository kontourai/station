import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, win32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  canonicalInstructionPath,
  escapesRoot,
  instructionGateErrors,
  resolveClaudeImports,
  resolveClaudeStartup,
  resolveCodexStartup,
  resolveEffectiveInstructions,
} from '../agent-instructions-gate.mjs';
import { REQUIRED_INSTRUCTION_FILES } from '../agent-instructions-manifest.mjs';

const root = process.cwd();
const governance = `<!-- veritas:governance-block:start -->\nThis repo uses Veritas for AI governance. Read \`.veritas/GOVERNANCE.md\` before making changes.\nAfter changes, run \`veritas readiness\` and address any FAIL lines before finishing.\n<!-- veritas:governance-block:end -->\n`;
function fixture(overrides: Record<string, string> = {}) {
  const files = new Map(
    REQUIRED_INSTRUCTION_FILES.map((file) => [
      resolve(root, file),
      file.endsWith('/CLAUDE.md') ? '@AGENTS.md\n' : '# scoped\n',
    ]),
  );
  files.set(resolve(root, 'AGENTS.md'), '# root\n');
  files.set(resolve(root, 'CLAUDE.md'), `@AGENTS.md\n\n${governance}`);
  files.set(
    resolve(root, 'docs/guides/testing.md'),
    readFileSync('docs/guides/testing.md', 'utf8'),
  );
  for (const [file, text] of Object.entries(overrides))
    files.set(resolve(root, file), text);
  const stat = (path: string) => ({ isFile: () => files.has(path) });
  return { readFile: (path: string) => files.get(path) ?? '', stat };
}

describe('agent instruction topology', () => {
  test('validates the repository and resolves actual rule content for every scope and harness', () => {
    expect(instructionGateErrors()).toEqual([]);
    const exists = (file: string) =>
      [
        'AGENTS.md',
        'src-ui/AGENTS.md',
        'CLAUDE.md',
        'src-ui/CLAUDE.md',
      ].includes(file.replace(/^\.\//, ''));
    expect(resolveCodexStartup({ cwd: 'src-ui', exists })).toEqual([
      'AGENTS.md',
      'src-ui/AGENTS.md',
    ]);
    expect(resolveCodexStartup({ exists })).toEqual(['AGENTS.md']);
    expect(resolveClaudeStartup({ cwd: 'src-ui', exists })).toEqual([
      'CLAUDE.md',
      'src-ui/CLAUDE.md',
    ]);
    const scopes = [
      'src-server',
      'src-ui',
      'scripts',
      'src-desktop',
      'packages/contracts',
      'packages/sdk',
      'tests',
    ];
    for (const scope of scopes) {
      const path = `${scope}/example.ts`;
      const allRules = Object.fromEntries(
        scopes.map((value) => [
          `${value}/AGENTS.md`,
          `RULE_${value.replaceAll('/', '_').toUpperCase()}\n`,
        ]),
      );
      const data = fixture({
        'AGENTS.md': 'RULE_ROOT\n',
        ...allRules,
      });
      for (const harness of ['codex', 'claude'] as const) {
        const resolved = resolveEffectiveInstructions({
          path,
          harness,
          root,
          ...data,
        });
        const text = resolved.routed
          .map(({ text }: { text: string }) => text)
          .join('\n');
        expect(text).toContain('RULE_ROOT');
        expect(text).toContain(
          `RULE_${scope.replaceAll('/', '_').toUpperCase()}`,
        );
        for (const unrelated of scopes.filter((value) => value !== scope))
          expect(text).not.toContain(
            `RULE_${unrelated.replaceAll('/', '_').toUpperCase()}`,
          );
      }
    }
    const rootLaunch = resolveEffectiveInstructions({
      path: 'src-ui/example.ts',
      harness: 'codex',
      root,
      ...fixture({
        'AGENTS.md': 'RULE_ROOT\n',
        'src-ui/AGENTS.md': 'RULE_SRC_UI\n',
      }),
    });
    expect(
      rootLaunch.startup.map(({ text }: { text: string }) => text).join('\n'),
    ).toContain('RULE_ROOT');
    expect(
      rootLaunch.startup.map(({ text }: { text: string }) => text).join('\n'),
    ).not.toContain('RULE_SRC_UI');
    expect(
      instructionGateErrors({
        ...fixture({
          'AGENTS.md': scopes.map((value) => `@${value}/AGENTS.md`).join('\n'),
        }),
      }),
    ).toContain('AGENTS.md must not import instruction scopes');
  });

  test('fails closed for missing/empty scopes, over-budget content, and wrapper drift', () => {
    expect(
      instructionGateErrors({ ...fixture({ 'src-ui/AGENTS.md': '' }) }),
    ).toContain('instruction file is empty: src-ui/AGENTS.md');
    expect(
      instructionGateErrors({
        ...fixture(),
        encoder: { encode: () => Array(9_999), free() {} },
      }),
    ).toContain('AGENTS.md exceeds tokens budget (9999 > 2048)');
    expect(
      instructionGateErrors({ ...fixture({ 'CLAUDE.md': '@AGENTS.md\n' }) }),
    ).toContain(
      'CLAUDE.md must be the root AGENTS wrapper plus the canonical governance block',
    );
    expect(
      instructionGateErrors({
        ...fixture({
          'CLAUDE.md': `@AGENTS.md\n\n${governance.replace('Veritas', 'Other')}`,
        }),
      }),
    ).toContain(
      'CLAUDE.md must be the root AGENTS wrapper plus the canonical governance block',
    );
    expect(
      instructionGateErrors({
        ...fixture({ 'src-ui/AGENTS.override.md': '# override\n' }),
      }),
    ).toContain('unsupported instruction override: src-ui/AGENTS.override.md');
  });

  test('reports unsupported overrides with canonical repository separators', () => {
    expect(canonicalInstructionPath('src-ui\\AGENTS.override.md')).toBe(
      'src-ui/AGENTS.override.md',
    );
    expect(canonicalInstructionPath('src-ui/AGENTS.override.md')).toBe(
      'src-ui/AGENTS.override.md',
    );
  });

  test('rejects broken instruction links and fragments', () => {
    expect(
      instructionGateErrors({
        ...fixture({ 'AGENTS.md': '[missing](nope.md)\n' }),
      }),
    ).toContain("AGENTS.md has broken instruction link 'nope.md'");
    expect(
      instructionGateErrors({
        ...fixture({
          'AGENTS.md': '[missing](docs/guides/testing.md#not-a-heading)\n',
        }),
      }),
    ).toContain(
      "AGENTS.md has broken instruction fragment 'docs/guides/testing.md#not-a-heading'",
    );
  });

  test('rejects root imports of every scope and stale backlog claims', () => {
    expect(
      instructionGateErrors({
        ...fixture({ 'AGENTS.md': '@src-server/AGENTS.md\n' }),
      }),
    ).toContain('AGENTS.md must not import instruction scopes');
    expect(
      instructionGateErrors({
        ...fixture({ 'AGENTS.md': '# Active backlog\nstation#4295\n' }),
      }),
    ).toContain(
      'AGENTS.md must not make roadmap, backlog, or current-state claims',
    );
  });

  test('rejects undeclared instructions and generated-policy copies outside the owner', () => {
    const data = fixture();
    expect(
      instructionGateErrors({
        ...data,
        instructionFiles: ['AGENTS.md', 'extra/AGENTS.md'],
      }),
    ).toContain('unsupported instruction file: extra/AGENTS.md');
    expect(
      instructionGateErrors({
        ...fixture({
          'src-ui/AGENTS.md': '<!-- station:verification-policy:start -->\n',
        }),
        trackedFiles: ['AGENTS.md', 'src-ui/AGENTS.md'],
      }),
    ).toContain(
      'src-ui/AGENTS.md must not own generated verification-policy policy',
    );
  });

  test('rejects unsupported, escaping, broken, and cyclic imports', () => {
    for (const [text, error] of [
      ['@../AGENTS.md\n', 'instruction import escapes root: ../AGENTS.md'],
      ['@/AGENTS.md\n', 'unsupported instruction import: /AGENTS.md'],
      [
        '@MISSING.md\n',
        'instruction target is not a regular file: src-ui/MISSING.md',
      ],
    ])
      expect(() =>
        resolveClaudeImports(
          'src-ui/CLAUDE.md',
          fixture({ 'src-ui/CLAUDE.md': text }),
        ),
      ).toThrow(error);
    const cyclic = fixture({
      'src-ui/CLAUDE.md': '@again.md\n',
      'src-ui/again.md': '@CLAUDE.md\n',
    });
    expect(() => resolveClaudeImports('src-ui/CLAUDE.md', cyclic)).toThrow(
      'instruction import cycle',
    );
  });

  test('rejects an import redirected outside the repository by a symlink', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-instructions-'));
    const outside = mkdtempSync(
      resolve(tmpdir(), 'station-instructions-outside-'),
    );
    try {
      writeFileSync(resolve(fixtureRoot, 'CLAUDE.md'), '@linked.md\n');
      writeFileSync(resolve(outside, 'linked.md'), 'RULE_OUTSIDE\n');
      symlinkSync(
        resolve(outside, 'linked.md'),
        resolve(fixtureRoot, 'linked.md'),
      );
      expect(() =>
        resolveClaudeImports('CLAUDE.md', { root: fixtureRoot }),
      ).toThrow('instruction realpath escapes root: linked.md');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('treats an absolute Windows relative result and a directory alias as escapes', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-instructions-'));
    const outside = mkdtempSync(
      resolve(tmpdir(), 'station-instructions-outside-'),
    );
    try {
      writeFileSync(resolve(fixtureRoot, 'CLAUDE.md'), '@linked.md\n');
      writeFileSync(resolve(outside, 'linked.md'), 'RULE_OUTSIDE\n');
      symlinkSync(outside, resolve(fixtureRoot, 'alias'));
      expect(
        instructionGateErrors({ root: fixtureRoot, trackedFiles: [] }),
      ).toContain('redirected instruction directory: alias');
      expect(() =>
        resolveClaudeImports('CLAUDE.md', {
          root: 'C:\\repo',
          readFile: () => 'RULE\n',
          stat: () => ({ isFile: () => true }),
          realpath: (path: string) =>
            path === 'C:\\repo' ? 'C:\\repo' : 'D:\\outside',
        }),
      ).toThrow('instruction realpath escapes root');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('recognizes Windows parent traversal, cross-volume results, and contained paths', () => {
    const rootPath = 'C:\\repo';
    expect(
      escapesRoot(
        rootPath,
        'C:\\outside',
        win32.relative(rootPath, 'C:\\outside'),
      ),
    ).toBe(true);
    expect(
      escapesRoot(
        rootPath,
        'D:\\outside',
        win32.relative(rootPath, 'D:\\outside'),
      ),
    ).toBe(true);
    expect(
      escapesRoot(
        rootPath,
        'C:\\repo\\src\\AGENTS.md',
        win32.relative(rootPath, 'C:\\repo\\src\\AGENTS.md'),
      ),
    ).toBe(false);
  });
});
