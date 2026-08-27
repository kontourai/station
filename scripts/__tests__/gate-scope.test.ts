/**
 * Scope-honesty invariant for the guardrail family (station#1559, #1543;
 * epic #1555 slice 4b, `absence-as-success`).
 *
 * The two bugs these tests were written for are instances. The defect is the
 * MISSING INVARIANT: nothing asserted that a gate's enumerated scope matched
 * the scope its success line named, so both gates under-enumerated for months
 * and printed "OK ... in src-ui/src/**\/*.tsx (523 files scanned)" over a tree
 * of 525. These tests fail on scope drift instead of letting it report clean.
 *
 * The oracle here is deliberately independent of the production helper: it
 * walks the working tree with its own recursion and intersects with a raw
 * `git ls-files` call, so a bug in `gate-scope.mjs`'s own walker cannot make
 * both sides agree.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertScopeIsHonest,
  describeScope,
  UI_SCAN_EXTENSIONS,
  UI_SCAN_ROOTS,
} from '../lib/gate-scope.mjs';
import {
  COPY_SOURCE_FILES,
  SCAN_EXTENSIONS as NOUN_GATE_EXTENSIONS,
  PINNED_SCOPE_INVENTORY as NOUN_GATE_PINNED,
  SCAN_ROOTS as NOUN_GATE_ROOTS,
  listTrackedTsxFiles as nounGateFiles,
  scanCopySourceContent,
} from '../noun-consistency-gate.mjs';
import {
  SCAN_EXTENSIONS as RATCHET_EXTENSIONS,
  PINNED_SCOPE_INVENTORY as RATCHET_PINNED,
  SCAN_ROOTS as RATCHET_ROOTS,
  listTrackedTsxFiles as ratchetFiles,
} from '../state-primitives-ratchet.mjs';

const ROOT = 'src-ui/src';

/** Raw `git ls-files <pathspec>`, no helper in between. */
function gitLsFiles(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', pathspec], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** The test's own working-tree walk — not `gate-scope.mjs`'s. */
function walk(dir: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...walk(path, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      found.push(path.split(sep).join('/'));
    }
  }
  return found;
}

/**
 * Every `.tsx` file that BOTH exists on disk under a declared root and is
 * git-tracked. This is what "the scope" means for both gates — the shared
 * UI tree, all of its roots.
 */
function realTrackedTsxFiles(): string[] {
  const tracked = new Set(UI_SCAN_ROOTS.flatMap((root) => gitLsFiles(root)));
  return UI_SCAN_ROOTS.flatMap((root) =>
    walk(root, '.tsx').filter((file) => tracked.has(file)),
  ).sort();
}

/**
 * The src-ui-only slice of the scope. The two historical pathspec tests below
 * replay station#1559, which is a src-ui lesson; the shared-tree oracle is
 * `realTrackedTsxFiles`.
 */
function realTrackedTsxFilesUnderRoot(): string[] {
  const tracked = new Set(gitLsFiles(ROOT));
  return walk(ROOT, '.tsx')
    .filter((file) => tracked.has(file))
    .sort();
}

describe('gate scope honesty (station#1559 / #1543)', () => {
  describe('the git pathspec that caused the miss', () => {
    it('omits every .tsx sitting directly in src-ui/src, which is why a `dir/**/*.ext` enumeration cannot be trusted', () => {
      const real = realTrackedTsxFilesUnderRoot();
      const rootLevel = real.filter(
        (file) => file.slice(ROOT.length + 1).indexOf('/') === -1,
      );
      // If this ever becomes empty the premise below is untestable, not fixed.
      expect(rootLevel.length).toBeGreaterThan(0);

      const viaRecursiveGlob = new Set(gitLsFiles(`${ROOT}/**/*.tsx`));
      const omitted = real.filter((file) => !viaRecursiveGlob.has(file));

      // The omission is exactly the root-level files — git's `**` in this
      // pathspec form requires at least one intervening directory.
      expect(omitted).toEqual(rootLevel);
    });

    it('a plain directory pathspec does not have that hole', () => {
      const viaDirectory = new Set(gitLsFiles(ROOT));
      for (const file of realTrackedTsxFilesUnderRoot()) {
        expect(viaDirectory.has(file)).toBe(true);
      }
    });
  });

  describe('each gate enumerates the whole scope it reports on', () => {
    it.each([
      ['noun-consistency gate', nounGateFiles],
      ['state-primitives ratchet', ratchetFiles],
    ])('%s: enumerated count equals the real count', (_name, enumerate) => {
      const real = realTrackedTsxFiles();
      const enumerated = (enumerate() as string[]).slice().sort();

      // The count assertion is the headline invariant; the set assertion is
      // what makes a failure diagnosable.
      expect(enumerated.length).toBe(real.length);
      expect(enumerated).toEqual(real);
    });

    it.each([
      ['noun-consistency gate', nounGateFiles, NOUN_GATE_PINNED],
      ['state-primitives ratchet', ratchetFiles, RATCHET_PINNED],
    ])(
      '%s: every pinned-inventory path is in scope',
      (_name, enumerate, pinned) => {
        const inScope = new Set([
          ...(enumerate() as string[]),
          ...COPY_SOURCE_FILES,
        ]);
        for (const file of pinned as string[]) {
          expect(inScope.has(file)).toBe(true);
        }
      },
    );

    it('both guardrails scan the ONE shared UI tree, so neither can narrow alone', () => {
      // One constant, imported by both (scripts/lib/gate-scope.mjs). A gate
      // declaring its own roots array could drift from the other silently;
      // deriving from the shared constant makes narrowing a one-place
      // decision the lib's docblock records.
      expect(NOUN_GATE_ROOTS).toBe(UI_SCAN_ROOTS);
      expect(RATCHET_ROOTS).toBe(UI_SCAN_ROOTS);
      expect(NOUN_GATE_EXTENSIONS).toBe(UI_SCAN_EXTENSIONS);
      expect(RATCHET_EXTENSIONS).toBe(UI_SCAN_EXTENSIONS);
      // The shared tree covers both packages' UI surfaces — the review L
      // lesson: a gate scanning only src-ui reports "clean in the places I
      // look" while an SDK component renders a retired noun.
      expect(UI_SCAN_ROOTS).toContain('src-ui/src');
      expect(UI_SCAN_ROOTS).toContain('packages/sdk/src/components');
    });

    it('the pinned inventory names the files both issues found outside the scope', () => {
      expect(NOUN_GATE_PINNED).toContain('src-ui/src/App.tsx');
      expect(NOUN_GATE_PINNED).toContain('src-ui/src/main.tsx');
      expect(NOUN_GATE_PINNED).toContain(
        'packages/contracts/src/settings-registry.ts',
      );
      expect(RATCHET_PINNED).toContain('src-ui/src/App.tsx');
      expect(RATCHET_PINNED).toContain('src-ui/src/main.tsx');
    });
  });

  describe('assertScopeIsHonest has power', () => {
    const base = {
      gate: 'test gate',
      roots: NOUN_GATE_ROOTS as string[],
      extensions: NOUN_GATE_EXTENSIONS as string[],
      pinned: [] as string[],
    };

    it('passes on the real enumeration', () => {
      expect(() =>
        assertScopeIsHonest({ ...base, files: nounGateFiles() }),
      ).not.toThrow();
    });

    it('throws, naming the omitted files, when the enumeration is short', () => {
      const short = (nounGateFiles() as string[]).filter(
        (file) => file !== 'src-ui/src/App.tsx',
      );
      expect(() => assertScopeIsHonest({ ...base, files: short })).toThrowError(
        /src-ui\/src\/App\.tsx/,
      );
    });

    it('throws when the enumeration matched nothing at all', () => {
      // The failure mode this exists for: a broken pathspec reports zero
      // findings over zero files and every ceiling check passes.
      expect(() => assertScopeIsHonest({ ...base, files: [] })).toThrowError(
        /enumerated 0 files/,
      );
    });

    it('throws when a pinned path is outside the enumerated scope', () => {
      expect(() =>
        assertScopeIsHonest({
          ...base,
          pinned: ['packages/contracts/src/settings-registry.ts'],
          files: nounGateFiles(),
        }),
      ).toThrowError(/pinned-inventory path/);
    });

    it('reproduces the station#1543 shape: the registry dropping out of scope is a hard failure, not a quieter success line', () => {
      // Injection that found this: emptying COPY_SOURCE_FILES left the gate
      // exiting 0 with a success line that had simply stopped mentioning the
      // registry. Honest wording over a silently narrowed scope is still the
      // defect. The pin is what makes it red.
      expect(() =>
        assertScopeIsHonest({
          ...base,
          pinned: NOUN_GATE_PINNED,
          files: nounGateFiles(),
        }),
      ).toThrowError(/settings-registry\.ts/);
    });

    it('reproduces the exact station#1559 miss when handed the old pathspec result', () => {
      const oldEnumeration = gitLsFiles(`${ROOT}/**/*.tsx`);
      expect(() =>
        assertScopeIsHonest({ ...base, files: oldEnumeration }),
      ).toThrowError(/SCOPE DRIFT/);
    });
  });

  describe('the success line names what was actually walked', () => {
    it('renders concrete per-root counts, never a glob', () => {
      const files = nounGateFiles() as string[];
      const scope = describeScope({
        roots: NOUN_GATE_ROOTS,
        extensions: NOUN_GATE_EXTENSIONS,
        files,
        extraFiles: COPY_SOURCE_FILES,
      });
      // Every root appears with ITS OWN count — a single total would let a
      // root go empty (or missing) without changing the line.
      for (const root of NOUN_GATE_ROOTS) {
        const count = files.filter(
          (file) => file === root || file.startsWith(`${root}/`),
        ).length;
        expect(scope).toContain(root);
        expect(scope).toContain(`(${count} .tsx file`);
      }
      expect(scope).toContain('packages/contracts/src/settings-registry.ts');
      // A pathspec in a success line is a claim about a scope, not a report of
      // one — that is precisely how #1559 read clean for months.
      expect(scope).not.toContain('**');
    });

    it('counts per declared root rather than reporting a single total', () => {
      const scope = describeScope({
        roots: ['a', 'b'],
        extensions: ['.tsx'],
        files: ['a/one.tsx', 'a/two.tsx', 'b/three.tsx'],
      });
      expect(scope).toBe('a (2 .tsx files) + b (1 .tsx file)');
    });
  });
});

describe('non-JSX copy sources (station#1543)', () => {
  const settingsRegistry = COPY_SOURCE_FILES[0];

  it('the settings registry is registered as a scanned copy source', () => {
    expect(settingsRegistry).toBe(
      'packages/contracts/src/settings-registry.ts',
    );
  });

  it('finds retired nouns in defineSetting label/description/placeholder', () => {
    // Lowercase 'prompts' is the LLM sense and is NOT a finding (delta
    // review: only the capital-P product noun is banned); lowercase
    // 'playbooks' has no LLM sense and stays banned case-insensitively.
    const source = `
      defineSetting({
        key: 'runtime',
        label: 'Agent runtime',
        description: "Agent framework runtime Station's own engine runs on.",
      }),
      defineSetting({
        key: 'templateVariables',
        label: 'Template variables',
        placeholder: 'used in prompts',
      }),
      defineSetting({
        key: 'guidance',
        label: 'Saved playbooks',
        placeholder: 'run a playbook',
      }),
    `;
    const { findings, unscannable } = scanCopySourceContent(
      'fixture.ts',
      source,
    );
    expect(unscannable).toEqual([]);
    expect(
      findings.map((finding: { snippet: string }) => finding.snippet),
    ).toEqual([
      'Agent runtime',
      "Agent framework runtime Station's own engine runs on.",
      'Saved playbooks',
      'run a playbook',
    ]);
  });

  it('bans the capital-P product noun in defineSetting copy but not the lowercase LLM sense', () => {
    const source = `
      defineSetting({
        key: 'a',
        label: 'Prompts',
        description: 'Prompts you run often become skills.',
      }),
      defineSetting({
        key: 'b',
        label: 'Send a prompt',
        description: 'The system prompt is assembled per turn.',
      }),
    `;
    const { findings, unscannable } = scanCopySourceContent(
      'fixture.ts',
      source,
    );
    expect(unscannable).toEqual([]);
    expect(
      findings.map((finding: { snippet: string }) => finding.snippet),
    ).toEqual(['Prompts', 'Prompts you run often become skills.']);
  });

  it('ignores the same identifiers where they are type declarations, not copy', () => {
    const source = `
      export interface SettingDefinition {
        label: string;
        description: string;
        placeholder?: string;
      }
      defineSetting({ key: 'a', label: 'Log level', description: 'Fine.' }),
    `;
    const { findings, unscannable } = scanCopySourceContent(
      'fixture.ts',
      source,
    );
    expect(findings).toEqual([]);
    expect(unscannable).toEqual([]);
  });

  it('ignores banned words in comments', () => {
    const source = `
      defineSetting({
        // Confirmed against runtime-initialize.ts — a runtime detail.
        key: 'a',
        label: 'Log level',
        description: 'Fine.',
      }),
    `;
    const { findings } = scanCopySourceContent('fixture.ts', source);
    expect(findings).toEqual([]);
  });

  it('reports copy it cannot read instead of skipping it', () => {
    // A scanner that silently drops the shapes it does not understand is the
    // same defect as a gate that under-enumerates its scope.
    const source = `
      defineSetting({ key: 'a', label: LABELS.agentRuntime, description: 'Fine.' }),
    `;
    const { findings, unscannable } = scanCopySourceContent(
      'fixture.ts',
      source,
    );
    expect(findings).toEqual([]);
    expect(unscannable).toHaveLength(1);
    expect(unscannable[0].snippet).toContain('label:');
  });

  it('fails closed when a registered copy source yields no blocks to scan', () => {
    const { unscannable } = scanCopySourceContent(
      'fixture.ts',
      'export const APP_SETTINGS_REGISTRY = [];',
    );
    expect(unscannable).toHaveLength(1);
    expect(unscannable[0].snippet).toContain('no defineSetting');
  });

  it('actually reads the real registry — blocks found, nothing unscannable', () => {
    // Pins that the live file is genuinely scanned, so a clean result over it
    // means "read and clean", not "read nothing".
    const source = readFileSync(settingsRegistry, 'utf8');
    const { findings, unscannable } = scanCopySourceContent(
      settingsRegistry,
      source,
    );
    expect(unscannable).toEqual([]);
    expect(findings).toEqual([]);
    expect(source).toContain('defineSetting(');
  });
});
