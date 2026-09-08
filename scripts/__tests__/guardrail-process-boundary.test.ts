/**
 * Every guardrail in `scripts/` that no test had ever executed, executed.
 *
 * ## The gap this closes
 *
 * `guardrail-known-bad-fixtures.test.ts` (station#1555) proved five of the
 * gates in this chain bite. It did not enumerate the rest. Walking the
 * package-script graph from `verify:static:raw` finds **54** gates; 18 were
 * already executed as a child process by some test (5 there, 13 by their own
 * test file); the other **36 had never had `main()` run under test at all**.
 * Their tests import the pure scanners and feed them strings, which leaves
 * the entry guard, baseline loading, ceiling comparison, the `FAIL:` output
 * and **the exit code itself** uncovered.
 *
 * That is not a hypothetical gap. Two of the gates below reach a non-zero
 * exit by setting `process.exitCode = 1` and falling off the end of `main()`
 * (`a11y-ratchet.mjs`, `check-markdown-links.mjs`) rather than calling
 * `process.exit(1)`; four more never print `FAIL:` at all and fail by
 * throwing. Nothing had proved any of that produces a non-zero status.
 *
 * ## The two lanes below, and why the split
 *
 * 1. **Known-bad fixture pairs** — the strong form, and the same shape
 *    `guardrail-known-bad-fixtures.test.ts` uses: a throwaway tree, the
 *    production guardrail bytes, one deliberate violation. Each gate gets
 *    both directions, because a fixture that fails proves nothing on its own
 *    (it can fail because the harness is malformed): the clean control is
 *    what binds the failure to the violation.
 * 2. **Production-tree accept runs** — for gates whose known-bad fixture
 *    would cost more than it proves (a 70-entry declared-dependency list to
 *    stand up, a build artifact, a second toolchain). These run the real gate
 *    against this repo and assert exit 0 and no `FAIL:`. That is weaker, and
 *    weaker in a specific way: for a gate that PRINTS its verdict, the output
 *    is what shows `main()` ran, and the case proves the production baseline
 *    parses and the scope resolves. For a gate that says nothing, exit 0 is
 *    indistinguishable from a gate whose entry guard never fired — so those
 *    five carry a second case that runs the same script over an empty tree
 *    and requires it to fail naming one of ITS OWN inputs. Neither case is a
 *    rejection-path proof, and neither is claimed as one.
 *
 * A gate appears in exactly one lane: 13 fixture pairs and 17 accept runs,
 * which is 30 of the 36. The remaining 6 are not covered by anything and are
 * recorded as such, with reasons, in `guardrail-execution-coverage.test.ts` —
 * that file holds the exact partition, so the claim above is a derivation
 * from the package-script graph rather than a count written down here.
 * (`check-generated-pages-links.mjs` also gets a pair below. It is NOT one of
 * the 54: the Pages workflow runs it, not `verify:static:raw`. It is here
 * because the fixture was free once the harness existed.)
 *
 * ## What this suite deliberately does NOT do
 *
 * It does not re-run the gates that already have fixture pairs, and it does
 * not run a production-tree accept pass for gates that have one. Duplicating
 * a gate's execution to raise a coverage number would be the same defect the
 * neighbouring commit removes from `verify:static:raw`.
 *
 * Fixture sources are inline where the violation is a pattern no production
 * scan of `scripts/` looks for — most of these gates scope themselves to
 * `src-ui/src`, `src-desktop/gen`, `dist-pages/` or
 * `examples/builder-delivery-viewer`, so an inline string is invisible to
 * them and the violation stays next to the assertion that reads it.
 *
 * One does not fit that: `station-vocabulary-gate.mjs` scans EVERY tracked
 * text file, this test file included, and an inline fixture made the gate
 * fail on its own test. Its violation therefore lives in a `.fixture` file
 * under `scripts/__tests__/fixtures/guardrail-known-bad/`, whose extension
 * the gate does not read — the same answer
 * `guardrail-known-bad-fixtures.test.ts` reached, and specifically NOT an
 * allowlist entry, which would file down the gate to fit the test. Nothing
 * here narrows a production scan by one byte; that suite's first `describe`
 * block pins it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  importGuardrail,
  runGuardrail,
  scratchRepo,
} from './helpers/guardrail-scratch.js';

/** A single-shot child; the slowest below (a11y, which runs biome) takes ~2s. */
const CASE_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Lane 2: production-tree accept runs
// ---------------------------------------------------------------------------

/**
 * Gates whose rejection path is proven only by the `FAIL:` text a fixture
 * would have to reproduce at a cost out of proportion to the proof. Each is
 * listed with the reason it is here rather than in the fixture lane, so the
 * boundary is a recorded judgement and not an omission.
 */
const PRODUCTION_ACCEPT_GATES: ReadonlyArray<{
  readonly script: string;
  readonly args?: readonly string[];
  /** Why no known-bad fixture. */
  readonly reason: string;
  /**
   * Gates that say nothing on the accept path. For those an exit 0 is
   * indistinguishable from a gate that never ran, so each carries a
   * broken-tree probe: the same script, its own sibling modules, and an
   * otherwise empty directory. A gate doing its work fails there naming one
   * of ITS OWN inputs; a gate whose entry guard never fired would exit 0
   * exactly as it does against this repo. `deps`/`libs` are the sibling
   * modules it needs for the failure to come from the gate rather than from
   * module resolution — an `ERR_MODULE_NOT_FOUND` is a non-zero exit that
   * proves nothing.
   */
  readonly brokenTree?: {
    readonly deps?: readonly string[];
    readonly libs?: readonly string[];
    /**
     * Real repository files the gate must have to get past its own
     * preconditions and reach the check under test. Copied byte-equal.
     */
    readonly productionFiles?: readonly string[];
    /** A path the gate itself reads, as it appears in the failure. */
    readonly ownInput: string;
    /**
     * Where `ownInput` is read, and where the entry guard that gates it sits.
     * `guard: null` means the script has no entry guard at all — its module
     * body IS the gate — so the import-mode control below cannot apply and is
     * skipped with this reason on the record.
     */
    readonly readSite: string;
    readonly guard: string | null;
  };
}> = [
  {
    script: 'agent-plugin-validators-gate.mjs',
    reason:
      'compares generated validator output against the checked-in copy; a fixture would have to reproduce the generator, which is the thing under test',
    brokenTree: {
      deps: ['generate-agent-plugin-validators.mjs'],
      ownInput: 'schemas/agent-plugins/1.0.0/plugin.schema.json',
      // Read by generate-agent-plugin-validators.mjs's schema load, reached
      // from this gate's three-line module body.
      readSite: 'generate-agent-plugin-validators.mjs schema load',
      // agent-plugin-validators-gate.mjs is a bare top-level
      // `await generateAgentPluginValidators({ check: true })` — there is no
      // entry guard to be behind, so the import-mode control is inapplicable
      // rather than passed.
      guard: null,
    },
  },
  {
    script: 'channel-ports.mjs',
    args: ['--check'],
    reason:
      'reads the repo-wide channel port assignment; a synthetic tree proves nothing the real assignment does not',
    brokenTree: {
      // The config read is at module TOP LEVEL (channel-ports.mjs:4-7),
      // ahead of the guard — so an empty dir fails at import and proves
      // nothing. Giving the scratch dir the real config gets the process past
      // that, and `--check` then reaches checkGeneratedChannelPorts, whose
      // first read is behind the guard.
      productionFiles: ['config/channel-ports.json'],
      ownInput: 'packages/shared/src/channel-ports.generated.ts',
      readSite: 'channel-ports.mjs:136-143 (checkGeneratedChannelPorts)',
      guard: 'channel-ports.mjs:146',
    },
  },
  {
    script: 'coding-composition-inventory-gate.mjs',
    reason:
      '70 declared dependency paths, 40 of which need stand-ins for the clean control, plus an 8-category capability inventory — the fixture would be larger than the gate',
  },
  {
    script: 'dependency-lifecycle-workflow-gate.mjs',
    reason:
      'scans every workflow file for the install contract; the production workflow set is the subject',
    brokenTree: {
      libs: ['pnpm-lockfile.mjs'],
      ownInput: '.github/workflows',
      readSite: 'dependency-lifecycle-workflow-gate.mjs (readdirSync in main)',
      guard: 'dependency-lifecycle-workflow-gate.mjs:235',
    },
  },
  {
    script: 'examples-conformance.mjs',
    reason:
      'walks the real examples/ workspaces and shells out to npm for each; a fixture would exercise the shim, not the conformance rules',
  },
  {
    script: 'generate-issue-lifecycle-reference.mjs',
    args: ['--check'],
    reason:
      'regenerates a doc from the reducer and diffs it; the generator is the subject',
    brokenTree: {
      deps: ['issue-lifecycle-reducer.mjs'],
      ownInput: 'docs/reference/issue-lifecycle.md',
      // Only under `--check`. Without it the generate branch runs and
      // WRITES this path instead — a different mode from the one the chain
      // composes, which is why the probe passes the declared args.
      readSite: 'generate-issue-lifecycle-reference.mjs:31 (check branch)',
      guard: 'generate-issue-lifecycle-reference.mjs:39',
    },
  },
  {
    script: 'just-interface.mjs',
    reason: 'diffs the justfile against package.json; both are the subject',
  },
  {
    script: 'label-manifest.mjs',
    reason: 'validates the checked-in label manifest against its schema',
  },
  {
    script: 'motion-contract-ratchet.mjs',
    reason:
      'already spawned by prepush-static-gates.test.ts through the pre-push composer; what was missing here is only the direct accept run',
  },
  {
    script: 'native-platform-boundary.mjs',
    reason:
      'the boundary is defined by the real src-ui/src import graph; a two-file fixture would test the regex, which its unit test already does',
  },
  {
    script: 'node-runtime-contract.mjs',
    reason: 'asserts the repo’s own .nvmrc/engines agreement',
    brokenTree: {
      ownInput: 'package.json',
      readSite: 'node-runtime-contract.mjs:25 (assertManifestContract)',
      guard: 'node-runtime-contract.mjs:33',
    },
  },
  {
    script: 'product-version.mjs',
    args: ['--check'],
    reason: 'reconciles the repo’s own version sources',
  },
  {
    script: 'public-contribution-surfaces.mjs',
    reason: 'validates the real public contribution docs set',
  },
  {
    script: 'public-doc-contract-examples.mjs',
    reason:
      'extracts and typechecks contract examples out of the real public docs',
  },
  {
    script: 'public-docs-hygiene.mjs',
    reason: 'validates the real public docs set',
  },
  {
    script: 'release-platform-matrix.mjs',
    reason:
      'reconciles config/release-platform-matrix.json against the workflows',
  },
  {
    script: 'stored-path-expansion-guard.mjs',
    reason:
      'a ratchet over the real src tree whose baseline entries must each still match a live finding; a fixture cannot carry the production baseline and a synthetic one would test nothing the unit test does not',
  },
];

describe('every unexecuted guardrail reaches a verdict on this repo', () => {
  for (const {
    script,
    args = [],
    reason,
    brokenTree,
  } of PRODUCTION_ACCEPT_GATES) {
    it(`${script} runs to exit 0 (no known-bad fixture: ${reason})`, {
      timeout: CASE_TIMEOUT,
    }, () => {
      const result = spawnSync(
        process.execPath,
        [join('scripts', script), ...args],
        { encoding: 'utf8', windowsHide: true },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output).not.toContain('FAIL:');
      expect(result.status, output).toBe(0);
      // A gate that prints its verdict has already distinguished itself from
      // a no-op. One that says nothing needs the broken-tree probe below, so
      // a silent entry MUST declare one: without it this case would pass
      // identically against a gate whose `main()` never runs, which is the
      // exact failure this suite exists to rule out.
      if (output.trim() === '') {
        expect(
          brokenTree,
          `${script} is silent on the accept path and declares no brokenTree probe`,
        ).toBeDefined();
      }
    });

    if (!brokenTree) continue;
    it(`${script} does its own work — a tree without ${brokenTree.ownInput} fails`, {
      timeout: CASE_TIMEOUT,
    }, () => {
      const dir = scratchRepo({
        script,
        libs: [...(brokenTree.libs ?? [])],
        extraScripts: [...(brokenTree.deps ?? [])],
        productionFiles: [...(brokenTree.productionFiles ?? [])],
        files: {},
        git: false,
      });
      linkNodeModules(dir);
      // The declared args, not none: every one of these gates branches on
      // `process.argv`, so a no-arg probe can exercise a mode the chain never
      // composes and report it as proof of the mode it does.
      const result = runGuardrail(dir, script, {}, args);
      expect(result.status, result.output).not.toBe(0);
      // Naming the gate's own input is what separates "the gate ran and could
      // not find its data" from "node could not load a module", which is also
      // a non-zero exit and proves nothing about whether the gate executed.
      expect(result.output).toContain(brokenTree.ownInput);
      expect(result.output).not.toContain('ERR_MODULE_NOT_FOUND');
    });

    it(`${script} reaches ${brokenTree.ownInput} only behind its entry guard`, {
      timeout: CASE_TIMEOUT,
    }, () => {
      // The claim the probe above rests on — that the failure came from
      // behind the entry guard — was prose until here. Importing the same
      // script as an ordinary module makes `process.argv[1]` something other
      // than the script, so the guard is false; a diagnostic that survives
      // that was produced at import time and is not evidence `main()` ran.
      //
      // channel-ports.mjs is the reason this exists: its config read IS at
      // module top level, and the first version of this probe reported that
      // import-time ENOENT as proof the gate had executed.
      if (brokenTree.guard === null) {
        // Recorded, not skipped silently: the gate has no entry guard to be
        // behind, so there is nothing here to compute. The type forbids
        // omitting the field, so this disposition is always stated.
        expect(brokenTree.readSite.length).toBeGreaterThan(0);
        return;
      }
      const dir = scratchRepo({
        script,
        libs: [...(brokenTree.libs ?? [])],
        extraScripts: [...(brokenTree.deps ?? [])],
        productionFiles: [...(brokenTree.productionFiles ?? [])],
        files: {},
        git: false,
      });
      linkNodeModules(dir);
      const imported = importGuardrail(dir, script);
      expect(
        imported.output,
        `${script}: ${brokenTree.ownInput} is reported at import time, so the probe cannot tell a working gate from one whose guard (${brokenTree.guard}) never fires`,
      ).not.toContain(brokenTree.ownInput);
    });
  }
});

// ---------------------------------------------------------------------------
// Lane 1: known-bad fixture pairs
// ---------------------------------------------------------------------------

/**
 * Several gates resolve a bare `typescript` (or run biome) from the tree they
 * are checking. Node's ESM resolver ignores `NODE_PATH`, so a scratch dir
 * outside the repo can only reach the installed toolchain through a symlink.
 * It is the real compiler running against a fixture tree — not a stub.
 */
function linkNodeModules(dir: string): void {
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
}

describe('check-markdown-links rejects a broken relative link', () => {
  const SCRIPT = 'check-markdown-links.mjs';

  const clean = {
    'README.md': '[Guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n',
  };

  it('accepts the clean tree — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = runGuardrail(
      scratchRepo({ script: SCRIPT, files: clean }),
      SCRIPT,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'Validated relative links in 2 Markdown files.',
    );
  });

  it('rejects a link whose target does not exist', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: { ...clean, 'README.md': '[Guide](docs/missing.md)\n' },
    });
    const result = runGuardrail(dir, SCRIPT);
    // `check-markdown-links.mjs` sets `process.exitCode = 1` and returns
    // rather than calling `process.exit(1)`. Nothing had ever proved that
    // still leaves a non-zero status.
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('Broken relative Markdown links:');
    expect(result.stderr).toContain(
      '- README.md: [Guide](docs/missing.md) — missing target',
    );
  });

  it('rejects a link that escapes the repository', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: { ...clean, 'README.md': '[Up](../escape.md)\n' },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('— outside repository');
  });
});

describe('check-generated-pages-links rejects a dangling generated href', () => {
  const SCRIPT = 'check-generated-pages-links.mjs';

  // No git: the gate walks `dist-pages/` with readdir and never shells out.
  const tree = (index: string) => ({
    'dist-pages/index.html': index,
    'dist-pages/guide.html': '<p>g</p>\n',
  });

  it('accepts the clean generated site — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: tree(
        '<a href="./guide.html">g</a><a href="https://x.test">e</a>\n',
      ),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'Validated generated links in 2 public pages.',
    );
  });

  it('rejects an href with no generated target', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: tree('<a href="./missing.html">g</a>\n'),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('Broken generated Pages links:');
    expect(result.stderr).toContain(
      '- dist-pages/index.html: ./missing.html — missing generated target',
    );
  });

  it('rejects an href that escapes the generated site', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: tree('<a href="../README.md">g</a>\n'),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('— outside generated site');
  });
});

describe('station-vocabulary:gate rejects a retired vocabulary match', () => {
  const SCRIPT = 'station-vocabulary-gate.mjs';
  const LIBS = ['ratchet-utils.mjs'];

  it('accepts the clean tree — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: { 'docs/ok.md': 'Use STATION_TARGET to choose a Station.\n' },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('FAIL:');
  });

  /**
   * The retired spelling cannot appear inline here: this gate scans every
   * tracked text file in the repository, `scripts/__tests__/*.test.ts`
   * included, so an inline fixture would make the gate fail on its own test.
   * That is the trap `guardrail-known-bad-fixtures.test.ts` documents, and
   * the answer is the same one — a `.fixture` file, whose extension is
   * outside the gate's `TEXT_EXTENSIONS` — rather than an allowlist entry,
   * which would file down the gate to fit the test.
   */
  const retired = readFileSync(
    'scripts/__tests__/fixtures/guardrail-known-bad/station-vocabulary/retired-env.md.fixture',
    'utf8',
  );

  it('rejects the retired environment-variable spelling', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        'docs/ok.md': 'Use STATION_TARGET to choose a Station.\n',
        'docs/bad.md': retired,
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('FAIL: 1 retired vocabulary match(es):');
    expect(result.stderr).toContain(
      `docs/bad.md:1 [station-profile-env] ${retired.trim()}`,
    );
    expect(result.stderr).toContain('use: STATION_TARGET');
  });
});

describe('knowledge-kit-import:gate rejects a Kit-internal import', () => {
  const SCRIPT = 'knowledge-kit-import-gate.mjs';
  const clean = {
    'src-server/ok.ts': "import { thing } from '@kontourai/flow-agents';\n",
  };

  it('accepts the published entry point — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = runGuardrail(
      scratchRepo({ script: SCRIPT, files: clean }),
      SCRIPT,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'OK: no Kit-internal-import violations found',
    );
  });

  it('rejects a deep import past the package exports map', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...clean,
        'src-server/bad.ts':
          "import { x } from '@kontourai/flow-agents/kits/knowledge/adapters/default.js';\n",
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: 1 Kit-internal-import violation(s) found:',
    );
    expect(result.stderr).toContain('[deep-import] src-server/bad.ts:1:');
  });

  it('rejects the segmented filesystem workaround', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...clean,
        'src-server/bad.ts':
          "const p = join('node_modules', '@kontourai', 'flow-agents', 'kits', 'x');\n",
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('[fs-workaround] src-server/bad.ts:1:');
  });
});

describe('unsaved-guard:gate rejects a native confirm and an un-triaged editor', () => {
  const SCRIPT = 'unsaved-guard-gate.mjs';

  /**
   * The gate reads every `KNOWN_DIRTY_STATE_EDITORS` entry unconditionally,
   * so a tree missing one throws ENOENT before any finding is produced. The
   * stand-ins are generated from the guardrail's own exported list rather
   * than hand-copied, so the clean control cannot rot the day someone edits
   * it — the same reason `guardrail-known-bad-fixtures.test.ts` generates the
   * state-primitives exclusion stubs.
   */
  async function cleanFiles(): Promise<Record<string, string>> {
    const { KNOWN_DIRTY_STATE_EDITORS } = (await import(
      '../unsaved-guard-gate.mjs'
    )) as { KNOWN_DIRTY_STATE_EDITORS: string[] };
    expect(KNOWN_DIRTY_STATE_EDITORS.length).toBeGreaterThan(0);
    const files: Record<string, string> = {};
    for (const file of KNOWN_DIRTY_STATE_EDITORS) {
      files[file] =
        '// Generated stand-in for a declared dirty-state editor. See\n' +
        '// cleanFiles() in guardrail-process-boundary.test.ts.\n' +
        "import { useUnsavedGuard } from '../hooks/useUnsavedGuard';\n" +
        'export const stub = useUnsavedGuard;\n';
    }
    return files;
  }

  it('accepts the clean tree — the negative control', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const dir = scratchRepo({ script: SCRIPT, files: await cleanFiles() });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('OK: all ');
  });

  it('rejects a bare confirm() in src-ui', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...(await cleanFiles()),
        'src-ui/src/views/Bad.tsx':
          'export function Bad() {\n  if (confirm("go?")) return null;\n}\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: 1 bare confirm()/prompt() (or window.confirm()/window.prompt()) call(s) found:',
    );
    expect(result.stderr).toContain('src-ui/src/views/Bad.tsx:2:');
  });

  it('rejects an un-triaged dirty-state editor', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...(await cleanFiles()),
        'src-ui/src/views/NewEditor.tsx':
          'const [dirty, setDirty] = useState(false);\nexport const x = dirty;\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: 1 un-triaged dirty-state declaration(s) found outside the known-editor list:',
    );
    expect(result.stderr).toContain('src-ui/src/views/NewEditor.tsx');
  });

  it('rejects a known editor that dropped the guard import', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const files = await cleanFiles();
    const victim = Object.keys(files)[0];
    const dir = scratchRepo({
      script: SCRIPT,
      files: { ...files, [victim]: 'export const stub = null;\n' },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: 1 known dirty-state editor(s) missing the useUnsavedGuard import:',
    );
    expect(result.stderr).toContain(victim);
  });
});

describe('builder-delivery-viewer-import:gate rejects an unpublished import', () => {
  const SCRIPT = 'builder-delivery-viewer-import-gate.mjs';
  const ROOT = 'examples/builder-delivery-viewer/src';
  const clean = {
    [`${ROOT}/plugin.tsx`]:
      "import { validateTrustBundle } from '@kontourai/flow-agents';\n" +
      "import '@kontourai/surface/trust-panel/element';\n",
  };

  it('accepts published contracts only — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({ script: SCRIPT, files: clean });
    linkNodeModules(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'OK: Builder Delivery Viewer uses only published contracts',
    );
  });

  it('rejects a private build/ import', { timeout: CASE_TIMEOUT }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...clean,
        [`${ROOT}/evil.ts`]:
          "import x from '@kontourai/flow-agents/build/src/index.js';\n",
      },
    });
    linkNodeModules(dir);
    const result = runGuardrail(dir, SCRIPT);
    // This gate never prints `FAIL:` — it prints its own header and exits 1.
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'Builder Delivery Viewer import gate failed:',
    );
    expect(result.stderr).toContain(
      `private-flow-agents-import: ${ROOT}/evil.ts:1`,
    );
  });

  it('rejects an unapproved node:fs mutation capability', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...clean,
        [`${ROOT}/evil.ts`]: "import { writeFileSync } from 'node:fs';\n",
      },
    });
    linkNodeModules(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      `unapproved-module-capability: ${ROOT}/evil.ts:1`,
    );
  });
});

describe('check-mobile-permissions rejects an unreviewed Android permission', () => {
  const SCRIPT = 'check-mobile-permissions.mjs';
  const ANDROID_MANIFEST =
    'src-desktop/gen/android/app/src/main/AndroidManifest.xml';

  // Byte-for-byte the declarations check-mobile-permissions.test.ts feeds the
  // pure auditor, materialised as the files the gate actually reads. The two
  // tests therefore agree on what "reviewed" means; only this one proves the
  // process exits non-zero when it is not.
  const manifest = `
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-feature android:name="android.hardware.camera.any" android:required="false" />
  <uses-permission android:name="android.permission.RECORD_AUDIO" />
  <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
  <uses-feature android:name="android.hardware.microphone" android:required="false" />
  <application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules">
    <activity android:windowSoftInputMode="adjustResize" />
  </application>
`;
  const exclusions =
    '<exclude domain="root" path="." /><exclude domain="file" path="." />' +
    '<exclude domain="database" path="." /><exclude domain="sharedpref" path="." />' +
    '<exclude domain="external" path="." />';
  const files = (androidManifest: string) => ({
    [ANDROID_MANIFEST]: androidManifest,
    'src-desktop/gen/android/app/src/main/res/xml/data_extraction_rules.xml': `
  <data-extraction-rules>
    <cloud-backup>${exclusions}</cloud-backup>
    <device-transfer>${exclusions}</device-transfer>
  </data-extraction-rules>
`,
    'src-desktop/gen/apple/station_iOS/Info.plist': `
  <key>NSCameraUsageDescription</key><string>Station uses the camera to scan pairing codes from another device.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Station connects to Station hosts on your local network.</string>
  <key>NSMicrophoneUsageDescription</key><string>Station uses the microphone for voice conversations with your agents.</string>
`,
  });

  // The gate honours two ambient variables; leaving them inherited would let
  // a developer's shell decide which manifests this case audits.
  const ENV = {
    STATION_ANDROID_PACKAGE_MANIFEST: '',
    STATION_REQUIRE_PACKAGED_PERMISSION_AUDIT: '',
  };

  it('accepts the reviewed declarations — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    // No git: the gate walks `src-desktop/gen` with readdirSync and resolves
    // its root from `import.meta.url`, never from git.
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: files(manifest),
    });
    const result = runGuardrail(dir, SCRIPT, ENV);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('mobile permission audit: PASS');
  });

  it('rejects an unreviewed permission', { timeout: CASE_TIMEOUT }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: files(
        manifest.replace(
          '<activity',
          '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n<activity',
        ),
      ),
    });
    const result = runGuardrail(dir, SCRIPT, ENV);
    // This gate throws rather than printing `FAIL:`; the non-zero status is
    // node's uncaught-exception exit, which nothing had proved.
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'Android source manifest permissions drifted; missing=[] unexpected=[android.permission.ACCESS_FINE_LOCATION]',
    );
  });

  it('rejects a loosened credential backup boundary', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: files(
        manifest.replace(
          'android:allowBackup="false"',
          'android:allowBackup="true"',
        ),
      ),
    });
    const result = runGuardrail(dir, SCRIPT, ENV);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'Android source manifest must retain the reviewed credential backup boundary android:allowBackup="false".',
    );
  });
});

describe('font-origin:ratchet rejects an external font origin', () => {
  const SCRIPT = 'font-origin-ratchet.mjs';
  // Every SCOPE_SENTINEL must be tracked, or the gate refuses rather than
  // going vacuously green — the scope assertion is part of what is proven.
  const clean = {
    'src-ui/index.html': '<!doctype html><html></html>\n',
    'src-ui/src/index.css': ':root { --x: 0; }\n',
    'src-desktop/tauri.conf.json': '{}\n',
    'packages/cli/src/commands/lifecycle.ts': 'export const x = 1;\n',
  };

  it('accepts self-hosted fonts — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = runGuardrail(
      scratchRepo({ script: SCRIPT, files: clean }),
      SCRIPT,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      '[font-origin] OK: 0 external font origin references across 4 scanned file(s)',
    );
  });

  it('rejects a Google Fonts stylesheet link', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...clean,
        'src-ui/index.html':
          '<link href="https://fonts.googleapis.com/css2?family=Inter">\n<!doctype html>\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      '[font-origin] external font origin: src-ui/index.html:1:',
    );
    expect(result.stderr).toContain(
      'font-origin gate failed: 1 external font origin reference(s)',
    );
  });

  it('refuses rather than going vacuously green when a sentinel leaves the scan', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { 'src-desktop/tauri.conf.json': _dropped, ...withoutSentinel } =
      clean;
    const dir = scratchRepo({ script: SCRIPT, files: withoutSentinel });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'font-origin scan scope is broken — sentinel file(s) not in the scanned list: src-desktop/tauri.conf.json.',
    );
  });
});

describe('focus-visible:ratchet rejects a new outline suppression', () => {
  const SCRIPT = 'focus-visible-ratchet.mjs';
  // `walk()` readdirs each source root with no existence check, so both roots
  // need a file even when the case is about neither of them.
  const roots = {
    'src-ui/src/.keep': '',
    'packages/connect/src/react/.keep': '',
  };
  const inventory = (exceptions: unknown[]) => ({
    'docs/ui/focus-outline-exceptions.json': `${JSON.stringify({ exceptions }, null, 2)}\n`,
  });

  it('accepts a tree with no suppressions — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: { ...roots, ...inventory([]) },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'Focus-visible ratchet: 0 reviewed outline suppressions; new exceptions are blocked.',
    );
  });

  it('rejects an unreviewed outline: none', { timeout: CASE_TIMEOUT }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([]),
        'src-ui/src/a.css': '.b:focus { outline: none; }\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      '"missing":[{"path":"src-ui/src/a.css","selector":".b:focus"}]',
    );
  });

  it('accepts the same rule once it is a reviewed exception — the binding, from the other side', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([
          {
            path: 'src-ui/src/a.css',
            selector: '.b:focus',
            reason: 'reviewed floor applies',
          },
        ]),
        'src-ui/src/a.css': '.b:focus { outline: none; }\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
  });

  it('rejects an inventory entry that no longer matches anything', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([
          {
            path: 'src-ui/src/gone.css',
            selector: '.b:focus',
            reason: 'reviewed floor applies',
          },
        ]),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      '"stale":[{"path":"src-ui/src/gone.css","selector":".b:focus"}]',
    );
  });
});

describe('accent-foreground:ratchet rejects an underived foreground on an accent fill', () => {
  const SCRIPT = 'accent-foreground-ratchet.mjs';
  const roots = Object.fromEntries(
    [
      'src-ui/src',
      'packages/connect/src/react',
      'packages/sdk/src',
      'examples/getting-started-starter/src',
      'examples/coding-starter/src',
      'examples/knowledge-docs-starter/src',
    ].map((root) => [`${root}/.keep`, '']),
  );
  const inventory = (exceptions: unknown[]) => ({
    'docs/ui/accent-foreground-exceptions.json': `${JSON.stringify({ exceptions }, null, 2)}\n`,
  });

  it('accepts a derived foreground — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([]),
        'src-ui/src/a.css':
          '.cta { background: var(--accent-primary); color: var(--text-on-accent); }\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'Accent-foreground ratchet: 0 reviewed accent fills',
    );
  });

  it('rejects a hard-coded foreground on an accent fill', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([]),
        'src-ui/src/a.css':
          '.cta { background: var(--accent-primary); color: #fff; }\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'NEW accent-filled control with an underived foreground: src-ui/src/a.css — .cta',
    );
    expect(result.stderr).toContain('Consume var(--text-on-accent)');
  });

  it('rejects an inventory entry that no longer matches anything', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([
          {
            path: 'src-ui/src/gone.css',
            selector: '.cta',
            reason: 'reviewed pairing',
          },
        ]),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'STALE inventory entry: src-ui/src/gone.css — .cta',
    );
  });
});

describe('a11y:ratchet rejects a new accessibility violation', () => {
  const SCRIPT = 'a11y-ratchet.mjs';

  /**
   * The production ceiling is zero (`scripts/a11y-baseline.json`), so this
   * fixture keeps it at zero: a ratchet fixture bound to a moving production
   * number would stop testing the comparison the day the number moved. The
   * biome config carries only what makes the gate ACTIVE — with
   * `a11y.recommended` unset the gate prints `INACTIVE:` and returns, which
   * is a real branch and a vacuous test.
   */
  const config = {
    'biome.json': `${JSON.stringify(
      {
        linter: {
          enabled: true,
          rules: { recommended: false, a11y: { recommended: true } },
        },
      },
      null,
      2,
    )}\n`,
    'scripts/a11y-baseline.json': `${JSON.stringify({ ceilings: {}, total: 0 }, null, 2)}\n`,
  };

  it('accepts a clean component — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...config,
        'src-ui/clean.tsx':
          'export const A = () => <button type="button">x</button>;\n',
      },
    });
    linkNodeModules(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    // The gate refuses to report a count it could not measure, so the
    // presence of this line is also proof biome actually ran.
    expect(result.stdout).toContain('OK: 0 violation(s), none above ceiling.');
  });

  it('rejects a violation above the zero ceiling', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...config,
        'src-ui/clean.tsx': 'export const A = () => <button>x</button>;\n',
      },
    });
    linkNodeModules(dir);
    const result = runGuardrail(dir, SCRIPT);
    // `a11y-ratchet.mjs` sets `process.exitCode = 1` and returns rather than
    // calling `process.exit(1)`; this is the assertion that it still exits
    // non-zero, which nothing anywhere had made.
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: accessibility violations increased.',
    );
    expect(result.stderr).toContain('useButtonType: 1 > ceiling 0');
  });

  it('accepts the same violation once the ceiling admits it — the binding, from the other side', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...config,
        'scripts/a11y-baseline.json': `${JSON.stringify(
          { ceilings: { useButtonType: 1 }, total: 1 },
          null,
          2,
        )}\n`,
        'src-ui/clean.tsx': 'export const A = () => <button>x</button>;\n',
      },
    });
    linkNodeModules(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('FAIL:');
  });
});

describe('claim-fixture:ratchet rejects an unfixtured claim state', () => {
  const SCRIPT = 'claim-fixture-ratchet.mjs';
  const LIBS = ['ratchet-utils.mjs'];
  // The production baseline is copied in rather than hand-written, so the
  // gapCeiling this case runs against is the one that ships (0 today).
  const EXTRA = ['claim-fixture-baseline.json'];

  /**
   * Stand-ins generated from the guardrail's own exported registry, not
   * hand-copied: a hardcoded copy would silently stop covering the real
   * surface the day someone edits `CLAIM_SURFACES`.
   */
  async function surfaces() {
    const { CLAIM_SURFACES } = (await import(
      '../claim-fixture-ratchet.mjs'
    )) as {
      CLAIM_SURFACES: {
        file: string;
        testFile: string;
        declarations: { name: string; kind: string }[];
      }[];
    };
    expect(CLAIM_SURFACES.length).toBeGreaterThan(0);
    return CLAIM_SURFACES;
  }

  async function cleanFiles(coveredStates = ['idle']) {
    const files: Record<string, string> = {};
    for (const surface of await surfaces()) {
      files[surface.file] = surface.declarations
        .map(
          (declaration) =>
            `export function ${declaration.name}(state) {\n` +
            coveredStates
              .map(
                (phase) =>
                  `  switch (state.phase) { case '${phase}': return '${phase}'; }`,
              )
              .join('\n') +
            '\n}\n',
        )
        .join('\n');
      files[surface.testFile] = coveredStates
        .map(
          (phase) =>
            `it('${phase}', () => { fixture({ phase: '${phase}' }); });`,
        )
        .join('\n');
    }
    return files;
  }

  it('accepts a fully fixtured surface — the negative control', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      extraScripts: EXTRA,
      files: await cleanFiles(),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('OK: 0 gap(s) <= ceiling 0');
  });

  it('rejects a switch member with no fixture', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const files = await cleanFiles();
    // One extra source state, no matching quoted token in the test file.
    for (const surface of await surfaces()) {
      files[surface.file] = files[surface.file].replace(
        /case 'idle': return 'idle'; \}/g,
        "case 'idle': return 'idle'; case 'error': return 'error'; }",
      );
    }
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      extraScripts: EXTRA,
      files,
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('unfixtured claim state(s) (ceiling 0):');
    expect(result.stderr).toContain(
      "'error' — no fixture in the paired test file",
    );
  });

  it('rejects a registry entry whose declaration is gone', {
    timeout: CASE_TIMEOUT,
  }, async () => {
    const files = await cleanFiles();
    const [surface] = await surfaces();
    const [declaration] = surface.declarations;
    files[surface.file] = files[surface.file].replace(
      `export function ${declaration.name}(`,
      'export function renamedAway(',
    );
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      extraScripts: EXTRA,
      files,
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'could not be located in source (stale CLAIM_SURFACES entry)',
    );
    expect(result.stderr).toContain(`${surface.file} :: ${declaration.name}`);
  });

  it('refuses to trust an untracked claim surface', {
    timeout: CASE_TIMEOUT,
  }, () => {
    // A real repository that simply does not track the claim surfaces. The
    // check runs before any content is read, so their absence is exactly the
    // condition it refuses — and `git: false` would NOT test this: it yields
    // `fatal: not a git repository`, a different failure that never reaches
    // the gate's own verdict.
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      extraScripts: EXTRA,
      files: { 'README.md': '# tracked, but not a claim surface\n' },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('are not git-tracked (staged/committed)');
  });
});

describe('responsive-surface:ratchet rejects an uninventoried surface', () => {
  const SCRIPT = 'responsive-surface-ratchet.mjs';
  const roots = {
    'src-ui/src/.keep': '',
    'packages/connect/src/react/.keep': '',
  };
  const inventory = (surfaces: unknown[]) => ({
    'docs/ui/responsive-surfaces.json': `${JSON.stringify(
      {
        version: 1,
        ownerRules: [{ prefix: 'src-ui/src/', owner: 'UI' }],
        actionInventory: 'docs/ui/responsive-action-surfaces.txt',
        surfaces,
      },
      null,
      2,
    )}\n`,
    'docs/ui/responsive-action-surfaces.txt': '# path|strategy|evidence\n',
  });

  it('accepts an empty inventory over an empty tree — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: { ...roots, ...inventory([]) },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(
      'Responsive surface inventory: 0 modal-like surfaces',
    );
  });

  it('rejects a modal-like surface nobody inventoried', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([]),
        'src-ui/src/components/FooModal.tsx':
          'export const Foo = () => null;\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      '"missing":["src-ui/src/components/FooModal.tsx"]',
    );
  });

  it('accepts the same surface once inventoried — the binding, from the other side', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      git: false,
      files: {
        ...roots,
        ...inventory([
          {
            path: 'src-ui/src/components/FooModal.tsx',
            strategy: 'covered',
            evidence: 'tests/foo.spec.ts',
          },
        ]),
        'src-ui/src/components/FooModal.tsx':
          'export const Foo = () => null;\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(0);
  });
});

describe('docs:reference:gate rejects a doc naming a path that does not exist', () => {
  const SCRIPT = 'docs-reference-gate.mjs';
  // The gate refuses outright unless its whole live-document scope resolves,
  // so the clean tree is the scope, not a convenience.
  const scope: Record<string, string> = {};
  for (const dir of [
    'docs/guides',
    'docs/reference',
    'docs/architecture',
    'docs/patterns',
    'docs/design',
    'docs/contexts',
    'docs/adr',
  ]) {
    scope[`${dir}/a.md`] = '# a\n';
  }
  for (const file of [
    'docs/architecture.md',
    'docs/glossary.md',
    'docs/README.md',
    'README.md',
    'AGENTS.md',
    'CONTEXT.md',
    'CONTEXT-MAP.md',
    'SECURITY.md',
  ]) {
    scope[file] = '# x\n';
  }

  it('accepts docs that name nothing — the negative control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = runGuardrail(
      scratchRepo({ script: SCRIPT, files: scope }),
      SCRIPT,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('OK: every repo path named in');
  });

  it('rejects a named repo path that does not exist', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...scope,
        'docs/guides/a.md': '# a\n\nSee `src-server/nope.ts`.\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: 1 path(s) named in live docs do not exist.',
    );
    expect(result.stderr).toContain('src-server/nope.ts');
  });

  it('refuses rather than reporting clean when its scope is incomplete', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { 'SECURITY.md': _dropped, ...withoutScope } = scope;
    const dir = scratchRepo({ script: SCRIPT, files: withoutScope });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: could not enumerate the required live-document scope.',
    );
  });
});
