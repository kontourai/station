/**
 * Known-bad fixtures for this repo's own guardrails (station#1555, the cheap
 * form of flow-agents#1085).
 *
 * ## Why this file exists
 *
 * A guardrail that has never fired is ambiguous. Zero firings could mean it is
 * a deterrent that works, or it could mean it is inert — and the correct
 * action is opposite in each case. Only a fixture the guardrail *must* reject
 * distinguishes them. That is the whole argument, and it is why this is not
 * mutation testing: same idea, an order of magnitude cheaper and quieter.
 *
 * ## What was actually missing
 *
 * Every guardrail below already had a test file. Not one of them ever
 * executed its guardrail. They import the pure exported detectors and feed
 * them synthetic strings, which leaves the entire `main()` body — baseline
 * loading, the partition/drift preconditions, the `FAIL:` output, and **the
 * exit code itself** — uncovered. `ui-bundle-budget.mjs` is the sharpest
 * case: it is the only one of the five that sets `process.exitCode = 1`
 * rather than calling `process.exit(1)`, and nothing anywhere proved that
 * still produces a non-zero exit. A gate whose rejection path has never been
 * executed is `absence-as-success` pointed at the gate itself.
 *
 * So every case here runs the guardrail **as a child process** and asserts on
 * its real exit status and its real diagnostic text.
 *
 * ## How the fixture avoids tripping the guardrail it tests
 *
 * The obvious trap: a known-bad `.tsx` under `src-ui/src` would be found by
 * the production scan. The obvious fix — adding a scan exclusion — is a new
 * blind spot, which is the failure mode this whole slice is about.
 *
 * Neither is used. Fixture sources live under
 * `scripts/__tests__/fixtures/guardrail-known-bad/` (outside every production
 * scan root) with a `.fixture` suffix (outside biome's and tsc's file
 * recognition), and are materialised into a throwaway git repo at test time.
 * **No production scan is narrowed by one byte.** The first `describe` block
 * below pins that.
 *
 * The scratch repo also receives a copy of the guardrail script itself, so
 * `import.meta.url`-relative baselines resolve to a *fixture* baseline rather
 * than the repo's real one. A fixture bound to the production ceiling would
 * silently stop testing the ceiling check the day the ceiling moved.
 * `expect(copied).toBe(real)` pins that the executed bytes are the production
 * guardrail's.
 *
 * ## The two directions each fixture must prove
 *
 * 1. The guardrail **rejects** the known-bad tree (non-zero exit, naming it).
 * 2. The guardrail **accepts** the same tree with only the violation removed.
 *
 * (2) is what binds the failure to the violation instead of to the harness.
 * Without it, a fixture that fails because the scratch repo is malformed, or
 * because a scope pin threw, is indistinguishable from the guardrail biting.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_TRUTH_GATE_LANES } from '../docs-truth-gate-aggregate.mjs';
import {
  entryPointSpecifiers,
  excludeMatcher,
  inspectWorkspace,
} from '../lib/package-dist-freshness.mjs';
import { PINNED_SCOPE_INVENTORY as NOUN_PINNED_SCOPE_INVENTORY } from '../noun-consistency-gate.mjs';
import {
  baselineDeferrals,
  configuredExclusions,
  discoverScriptSources,
} from '../scripts-typecheck-coverage.mjs';
import {
  BESPOKE_HEADER_EXCEPTIONS,
  HEADER_PINNED_SCOPE_INVENTORY,
  HEADING_PINNED_SCOPE_INVENTORY,
} from '../shell-conformance-ratchet.mjs';
import {
  ALREADY_CANONICAL_EXCLUSIONS,
  PRE_SHELL_LOADING_EXCLUSIONS,
  S4_DEFERRED_EXCLUSIONS,
} from '../state-primitives-ratchet.mjs';
import { TYPECHECK_LANES } from '../typecheck-aggregate.mjs';

const FIXTURE_ROOT = 'scripts/__tests__/fixtures/guardrail-known-bad';

/** Read a checked-in fixture source, dropping only the `.fixture` suffix. */
function fixture(gate: string, name: string): string {
  return readFileSync(join(FIXTURE_ROOT, gate, name), 'utf8');
}

interface ScratchOptions {
  /** Guardrail script basename under `scripts/`, e.g. `state-primitives-ratchet.mjs`. */
  script: string;
  /** Sibling modules the script imports from `scripts/lib/`. */
  libs?: string[];
  /**
   * Further production scripts under `scripts/` the case needs to execute —
   * `check-dist-freshness.mjs` is only half a story without the
   * `write-dist-stamp.mjs` that a real build runs. Copied under the same
   * byte-equality assertion as `script`.
   */
  extraScripts?: string[];
  /** Repo-relative path -> content, materialised and committed. */
  files: Record<string, string | Buffer>;
  /**
   * Skip `git init`/`add`/`commit`. Only for guardrails that do not scope
   * themselves with git — `ui-bundle-budget.mjs` reads a build directory
   * straight off the filesystem, so a repo would be scaffolding noise (and
   * committing its incompressible asset fixtures upsets text-oriented commit
   * hooks). Defaults to a real repo, which is what the other four need.
   */
  git?: boolean;
}

/**
 * A throwaway git repo carrying the guardrail and a tree for it to walk.
 *
 * It has to be a real git repo: every one of these guardrails scopes itself
 * with `git ls-files` or `git grep`, so a loose directory would prove nothing
 * about what runs in `verify:static`.
 */
function scratchRepo({
  script,
  libs = [],
  extraScripts = [],
  files,
  git: useGit = true,
}: ScratchOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-guardrail-fixture-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });

  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join('scripts', script), join(dir, 'scripts', script));
  // The executed bytes must be the production guardrail's, or fault-injecting
  // the real script would not reach this fixture and the binding is fiction.
  expect(readFileSync(join(dir, 'scripts', script), 'utf8')).toBe(
    readFileSync(join('scripts', script), 'utf8'),
  );
  for (const lib of libs) {
    copyFileSync(join('scripts', 'lib', lib), join(dir, 'scripts', 'lib', lib));
  }
  for (const extra of extraScripts) {
    copyFileSync(join('scripts', extra), join(dir, 'scripts', extra));
    expect(readFileSync(join(dir, 'scripts', extra), 'utf8')).toBe(
      readFileSync(join('scripts', extra), 'utf8'),
    );
  }

  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  if (useGit) {
    git('init', '-q');
    git('config', 'user.email', 'guardrail@test.invalid');
    git('config', 'user.name', 'guardrail fixture');
    git('config', 'core.hooksPath', '/dev/null');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fixture');
  }
  return dir;
}

interface GuardrailResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Both streams, because the guardrails split FAIL/OK across them. */
  output: string;
}

function runGuardrail(
  dir: string,
  script: string,
  env: Record<string, string> = {},
): GuardrailResult {
  const result = spawnSync(process.execPath, [join('scripts', script)], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

// ---------------------------------------------------------------------------
// The exclusion, pinned
// ---------------------------------------------------------------------------

describe('the fixtures narrow no production scan', () => {
  it('every fixture source sits outside every production scan root, and carries the .fixture suffix', () => {
    // The whole point of the `.fixture` suffix and the location: this slice
    // proves guardrails have teeth WITHOUT filing down any of them. If a
    // future fixture lands under `src-ui/src` (or drops the suffix and starts
    // being linted/typechecked as production source), that is a real
    // exclusion appearing by the back door and this fails.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        // `.json` fixture baselines are inert data; source-shaped fixtures
        // are the ones a toolchain would otherwise pick up.
        if (!entry.name.endsWith('.fixture') && !entry.name.endsWith('.json')) {
          offenders.push(path);
        }
      }
    };
    walk(FIXTURE_ROOT);
    expect(offenders).toEqual([]);

    // The scan roots the guardrails under test actually walk. A fixture may
    // never live in one of them — that is what would force an exclusion.
    const found: string[] = [];
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) collect(path);
        else found.push(path);
      }
    };
    collect(FIXTURE_ROOT);
    expect(found.length).toBeGreaterThan(0);
    for (const path of found) {
      expect(path.startsWith(`${FIXTURE_ROOT}/`)).toBe(true);
      for (const root of ['src-ui/', 'src-server/', 'src-shared/', 'packages/'])
        expect(path.startsWith(root)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// state-primitives:ratchet
// ---------------------------------------------------------------------------

describe('state-primitives:ratchet rejects its known-bad tree', {
  timeout: 30_000,
}, () => {
  const SCRIPT = 'state-primitives-ratchet.mjs';
  const LIBS = ['gate-scope.mjs', 'ratchet-utils.mjs'];
  const GATE = 'state-primitives';

  /**
   * Stand-ins for the guardrail's own hardcoded exclusion lists.
   *
   * The ratchet fails when an exclusion entry no longer matches a live
   * finding — a genuinely good check (a stale exclusion is a hole nobody is
   * watching), and one that fires against any tree missing those files. Rather
   * than hand-copy the lists (a second maintenance point that would rot the
   * day someone edits the real ones), the stubs are generated FROM the
   * guardrail's own exported constants. That also proves the staleness check
   * is live in this harness: every entry must match, or the clean control
   * would not be clean.
   */
  function exclusionStubs(): Record<string, string> {
    const stubs: Record<string, string> = {};
    for (const file of [
      ...ALREADY_CANONICAL_EXCLUSIONS,
      ...S4_DEFERRED_EXCLUSIONS,
    ]) {
      const name = file.split('/').pop()!.replace('.tsx', '');
      stubs[file] =
        `// Generated stand-in for a declared ratchet exclusion. See\n` +
        `// exclusionStubs() in guardrail-known-bad-fixtures.test.ts.\n` +
        `export function ${name.replace(/[^A-Za-z0-9_]/g, '')}() {\n` +
        `  return <div className="stub__empty" />;\n` +
        `}\n`;
    }
    for (const { file, text } of PRE_SHELL_LOADING_EXCLUSIONS) {
      const name = file.split('/').pop()!.replace('.tsx', '');
      stubs[file] =
        `// Generated stand-in for the exact pre-shell loading exclusion.\n` +
        `export function ${name.replace(/[^A-Za-z0-9_]/g, '')}() {\n` +
        `  return <main>${text}</main>;\n` +
        `}\n`;
    }
    return stubs;
  }

  /** The clean tree every case below adds exactly one file to. */
  function cleanFiles(): Record<string, string> {
    const baseline = JSON.parse(fixture(GATE, 'baseline.json'));
    // Derived, not hand-written: the deferred entries are live-by-construction
    // above, so the honest ceiling for a clean tree is exactly their count.
    baseline.emptyFamilyCeiling = S4_DEFERRED_EXCLUSIONS.length;
    return {
      'scripts/state-primitives-baseline.json': `${JSON.stringify(baseline, null, 2)}\n`,
      'src-ui/src/App.tsx': fixture(GATE, 'app.tsx.fixture'),
      'src-ui/src/main.tsx': fixture(GATE, 'main.tsx.fixture'),
      'src-ui/src/views/CleanView.tsx': fixture(GATE, 'clean-view.tsx.fixture'),
      ...exclusionStubs(),
    };
  }

  it('accepts the clean tree — the negative control', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: cleanFiles(),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.output).not.toContain('FAIL:');
    expect(result.status).toBe(0);
  });

  it('rejects a bespoke *__empty className (station#993, #996)', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        ...cleanFiles(),
        'src-ui/src/views/BespokeEmptyView.tsx': fixture(
          GATE,
          'bespoke-empty-view.tsx.fixture',
        ),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'FAIL: 1 untriaged file(s) with a live bespoke *__empty className',
    );
    expect(result.output).toContain('src-ui/src/views/BespokeEmptyView.tsx');
  });

  it('rejects an ad-hoc "No X" occurrence over the recorded ceiling (station#1665, #1688)', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        ...cleanFiles(),
        'src-ui/src/views/AdHocNoXView.tsx': fixture(
          GATE,
          'ad-hoc-no-x-view.tsx.fixture',
        ),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'ad-hoc "No X" occurrence(s) exceed the recorded ceiling 0',
    );
    // file:line:snippet, because the ceiling number alone does not tell the
    // next reader which occurrence crossed it — the thing #1665 had to
    // reconstruct by diffing occurrence lists.
    expect(result.output).toMatch(
      /src-ui\/src\/views\/AdHocNoXView\.tsx:\d+: >No playbooks yet</,
    );
  });

  it('fails closed when the scope stops covering a pinned root-level file (station#1559)', () => {
    // The #1559 miss in its process form: the gate could enumerate a subset
    // and still print a clean success line. Dropping App.tsx from the tree
    // makes the pinned inventory unsatisfiable, and the gate must die rather
    // than report on the scope it managed to see.
    const files = cleanFiles();
    delete (files as Record<string, string>)['src-ui/src/App.tsx'];
    const dir = scratchRepo({ script: SCRIPT, libs: LIBS, files });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('src-ui/src/App.tsx');
  });
});

// ---------------------------------------------------------------------------
// mobile-css-ratchet
// ---------------------------------------------------------------------------

describe('mobile-css-ratchet rejects its known-bad tree', {
  timeout: 30_000,
}, () => {
  const SCRIPT = 'mobile-css-ratchet.mjs';

  function cleanFiles(): Record<string, string> {
    return {
      'scripts/mobile-css-baseline.json': `${JSON.stringify(
        { pageLocalMediaQueryCeiling: 0 },
        null,
        2,
      )}\n`,
      // The primitive's responsive rule is deliberately exempt. The fixture
      // has to prove the script accepts that clean tree before a page rule is
      // planted below.
      'src-ui/src/components/SplitPaneLayout.css':
        '@media (max-width: 768px) {}\n',
    };
  }

  it('accepts the clean tree — the negative control', () => {
    const dir = scratchRepo({ script: SCRIPT, files: cleanFiles() });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(0);
    expect(result.output).toContain('0/0 page-local responsive at-rules');
  });

  it('rejects a page-local responsive rule with its real child exit code and source line', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      files: {
        ...cleanFiles(),
        'src-ui/src/views/BadMobileRule.css':
          '.bad-mobile-rule {}\n@container (max-width: 24rem) {}\n',
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'total 1 page-local responsive at-rules exceeds the recorded ceiling 0',
    );
    expect(result.output).toContain('src-ui/src/views/BadMobileRule.css:2');
  });
});

// ---------------------------------------------------------------------------
// noun-consistency:gate
// ---------------------------------------------------------------------------

describe('noun-consistency:gate rejects its known-bad tree', {
  timeout: 30_000,
}, () => {
  const SCRIPT = 'noun-consistency-gate.mjs';
  const LIBS = ['gate-scope.mjs', 'ratchet-utils.mjs'];
  const GATE = 'noun-consistency';
  const REGISTRY = 'packages/contracts/src/settings-registry.ts';

  function cleanFiles(): Record<string, string> {
    const files: Record<string, string> = {
      'scripts/noun-consistency-allowlist.json': '[]\n',
      'src-ui/src/App.tsx': fixture(GATE, 'app.tsx.fixture'),
      'src-ui/src/main.tsx': fixture(GATE, 'main.tsx.fixture'),
      'src-ui/src/views/CleanView.tsx': fixture(GATE, 'clean-view.tsx.fixture'),
      [REGISTRY]: fixture(GATE, 'settings-registry.ts.fixture'),
    };
    // The gate pins its scope inventory (station#1559/#1543 and review L's
    // out-of-src-ui finding), and a pinned path missing from the fixture tree
    // is itself a scope-drift failure — materialise every pin that the clean
    // tree does not already carry, same as the shell-conformance fixture.
    for (const pinned of NOUN_PINNED_SCOPE_INVENTORY) {
      if (!files[pinned]) {
        files[pinned] = fixture(GATE, 'clean-view.tsx.fixture');
      }
    }
    return files;
  }

  it('accepts the clean tree — the negative control', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: cleanFiles(),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.output).not.toContain('FAIL:');
    expect(result.status).toBe(0);
  });

  it('rejects retired vocabulary in a scanned attribute and in a JSX text node', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        ...cleanFiles(),
        'src-ui/src/views/StaleNounView.tsx': fixture(
          GATE,
          'stale-noun-view.tsx.fixture',
        ),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'un-allowlisted stale-noun match(es) found',
    );
    expect(result.output).toContain('Runtime settings');
    expect(result.output).toContain('Guidance');
  });

  it('fails closed on copy it cannot read rather than passing over it', () => {
    // `fail-open-validation` in its purest form: a scanner that skips the
    // shapes it does not understand reports a clean verdict over content it
    // never evaluated. The gate must name what it could not read.
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        ...cleanFiles(),
        [REGISTRY]: fixture(GATE, 'settings-registry-unreadable.ts.fixture'),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'user-facing copy field(s) this gate could not read',
    );
  });

  it('fails closed when its declared non-JSX copy source has left the tree (station#1543)', () => {
    // #1543 exactly: the settings copy moved out of the gate's scan tree and
    // the gate went on printing a success line over what remained. The scope
    // pin is what turns that into a stop.
    const files = cleanFiles();
    delete (files as Record<string, string>)[REGISTRY];
    const dir = scratchRepo({ script: SCRIPT, libs: LIBS, files });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('settings-registry.ts');
    expect(result.output).not.toContain('OK: no un-allowlisted stale-noun');
  });
});

// ---------------------------------------------------------------------------
// shell-conformance:ratchet
// ---------------------------------------------------------------------------

describe('shell-conformance:ratchet rejects its known-bad tree', {
  timeout: 30_000,
}, () => {
  const SCRIPT = 'shell-conformance-ratchet.mjs';
  // gate-scope: the ratchet now scans src-ui for stacked page-level headings
  // (station#2931) and asserts its own scan scope is honest, so the fixture
  // tree needs that helper the same way the state-primitives fixture does.
  const LIBS = ['gate-scope.mjs', 'ratchet-utils.mjs'];
  const GATE = 'shell-conformance';

  /**
   * The clean tree this guardrail's counts are supposed to accept: route views
   * that render no page header of their own, plus every path the gate pins —
   * both scope inventories and both recorded header exceptions. An exception
   * naming a file the scan cannot see is itself a failure, so the control has
   * to carry them.
   */
  function cleanFiles(): Record<string, string> {
    const files: Record<string, string> = {
      'scripts/shell-conformance-baseline.json': `${JSON.stringify(
        {
          bespokeHeaderCeiling: 0,
          stackedHeadingCeiling: 0,
          recordedAt: '2026-08-20T00:00:00Z',
          recordedBy:
            'guardrail known-bad fixture (station#1555) — not the repo baseline.',
        },
        null,
        2,
      )}\n`,
      'src-ui/src/views/ScratchView.tsx': fixture(
        GATE,
        'conformant-view.tsx.fixture',
      ).replace(/__COMPONENT__/g, 'ScratchView'),
    };
    for (const pinned of [
      ...HEADER_PINNED_SCOPE_INVENTORY,
      ...HEADING_PINNED_SCOPE_INVENTORY,
    ]) {
      if (!files[pinned]) {
        files[pinned] = fixture(GATE, 'conformant-view.tsx.fixture').replace(
          /__COMPONENT__/g,
          'PinnedScopeView',
        );
      }
    }
    // The recorded exceptions must exist AND still carry a header, or the
    // gate reports them as stale/missing rather than accepting the tree.
    for (const excepted of BESPOKE_HEADER_EXCEPTIONS.keys()) {
      files[excepted] = fixture(GATE, 'bespoke-view.tsx.fixture').replace(
        /__COMPONENT__/g,
        'ExceptedView',
      );
    }
    return files;
  }

  it('accepts the clean tree — the negative control', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: cleanFiles(),
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.output).not.toContain('FAIL:');
    expect(result.status).toBe(0);
  });

  it('rejects a route view that writes a page header of its own', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        ...cleanFiles(),
        'src-ui/src/views/ScratchView.tsx': fixture(
          GATE,
          'bespoke-view.tsx.fixture',
        ).replace(/__COMPONENT__/g, 'ScratchView'),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('bespoke page-header count 1 exceeds');
    expect(result.output).toContain('src-ui/src/views/ScratchView.tsx');
  });

  it('rejects a bespoke header in pages/, not only views/', () => {
    // The glob covers two roots. A signal that walked one of them would still
    // report a clean count over the other, which is the shape SHELL-17 found.
    const dir = scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      files: {
        ...cleanFiles(),
        'src-ui/src/pages/ScratchPage.tsx': fixture(
          GATE,
          'bespoke-view.tsx.fixture',
        ).replace(/__COMPONENT__/g, 'ScratchPage'),
      },
    });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('src-ui/src/pages/ScratchPage.tsx');
  });

  it('rejects an exception whose file no longer carries a header', () => {
    const files = cleanFiles();
    const [firstException] = [...BESPOKE_HEADER_EXCEPTIONS.keys()];
    files[firstException] = fixture(
      GATE,
      'conformant-view.tsx.fixture',
    ).replace(/__COMPONENT__/g, 'ExceptedView');
    const dir = scratchRepo({ script: SCRIPT, libs: LIBS, files });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('no longer carry a bespoke header');
    expect(result.output).toContain(firstException);
  });

  it('fails closed when a pinned path is missing from the scanned tree', () => {
    // THE scope-coverage invariant: a count reported over a tree the gate
    // never walked is worse than no count. Dropping a pinned file must stop
    // the run rather than lower the number.
    const files = cleanFiles();
    delete files[HEADER_PINNED_SCOPE_INVENTORY[0]];
    const dir = scratchRepo({ script: SCRIPT, libs: LIBS, files });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(HEADER_PINNED_SCOPE_INVENTORY[0]);
  });

  it('refuses a baseline with no bespoke-header ceiling', () => {
    const files = cleanFiles();
    const baseline = JSON.parse(
      files['scripts/shell-conformance-baseline.json'],
    );
    baseline.bespokeHeaderCeiling = undefined;
    files['scripts/shell-conformance-baseline.json'] =
      `${JSON.stringify(baseline, null, 2)}\n`;
    const dir = scratchRepo({ script: SCRIPT, libs: LIBS, files });
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('no numeric `bespokeHeaderCeiling`');
  });
});

// ---------------------------------------------------------------------------
// ui-bundle:budget
// ---------------------------------------------------------------------------

describe('ui-bundle:budget rejects its known-bad build output', {
  timeout: 30_000,
}, () => {
  const SCRIPT = 'ui-bundle-budget.mjs';
  const GATE = 'ui-bundle-budget';

  /**
   * Assets are generated rather than checked in: the breach case needs
   * incompressible bytes, and a committed blob of them would be noise in the
   * history. The `index.html` that references them IS checked in, because the
   * asset-enumeration shape is the part station#1218 got wrong (it summed
   * only the first asset and read green over an oversized payload for its
   * whole life).
   */
  function buildOutput(jsBytes: number): Record<string, string | Buffer> {
    return {
      'scripts/ui-bundle-budget.json': fixture(GATE, 'budget.json'),
      'dist-ui/index.html': fixture(GATE, 'index.html.fixture'),
      // Split across the two eager JS references so a gate that measured only
      // the first would see half the payload — the #1218 defect.
      'dist-ui/assets/entry.js': randomBytes(Math.ceil(jsBytes / 2)),
      'dist-ui/assets/eager-chunk.js': randomBytes(Math.ceil(jsBytes / 2)),
      'dist-ui/assets/entry.css': randomBytes(256),
    };
  }

  function stageLocalBundleDependency(dir: string): void {
    const contracts = join(dir, 'packages/contracts');
    mkdirSync(contracts, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'bundle-fixture', workspaces: ['packages/contracts'] })}\n`,
    );
    writeFileSync(
      join(contracts, 'package.json'),
      `${JSON.stringify({ name: '@kontourai/station-contracts', main: 'index.js' })}\n`,
    );
    writeFileSync(join(contracts, 'index.js'), 'export {};\n');
    mkdirSync(join(dir, 'node_modules/@kontourai'), { recursive: true });
    symlinkSync(
      contracts,
      join(dir, 'node_modules/@kontourai/station-contracts'),
      'dir',
    );
  }

  it('accepts a build inside the budget — the negative control', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: ['pnpm-lockfile.mjs', 'workspace-dependency-satisfaction.mjs'],
      extraScripts: ['workspace-dependency-provenance.mjs'],
      files: buildOutput(1024),
      git: false,
    });
    stageLocalBundleDependency(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Initial UI bundle');
  });

  it('refuses to print a measurement when node_modules belongs to another worktree', () => {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: ['pnpm-lockfile.mjs', 'workspace-dependency-satisfaction.mjs'],
      extraScripts: ['workspace-dependency-provenance.mjs'],
      files: buildOutput(1024),
      git: false,
    });
    const foreign = scratchRepo({ script: SCRIPT, files: {}, git: false });
    mkdirSync(join(foreign, 'node_modules'), { recursive: true });
    symlinkSync(
      join(foreign, 'node_modules'),
      join(dir, 'node_modules'),
      'dir',
    );

    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'node_modules must be a real directory owned by this worktree',
    );
    expect(result.output).not.toContain('Initial UI bundle');
  });

  it('rejects an entry payload over budget, and the process really exits non-zero', () => {
    // The assertion that could not have been made before: this is the only
    // guardrail of the set that sets `process.exitCode = 1` instead of
    // calling `process.exit(1)`. Nothing had ever executed it, so nothing had
    // ever proved a breach produces a non-zero exit at all — a budget that
    // prints a complaint and exits 0 is `absence-as-success` wearing the
    // costume of a gate.
    const dir = scratchRepo({
      script: SCRIPT,
      libs: ['pnpm-lockfile.mjs', 'workspace-dependency-satisfaction.mjs'],
      extraScripts: ['workspace-dependency-provenance.mjs'],
      files: buildOutput(8192),
      git: false,
    });
    stageLocalBundleDependency(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/entry JS gzip \d+ exceeds 2048 bytes/);
  });

  it('sums every eager asset, so a breach split across two of them is still caught (station#1218)', () => {
    // Each half is comfortably inside the budget; only the sum is not. A gate
    // matching just the first asset would report clean here.
    const dir = scratchRepo({
      script: SCRIPT,
      libs: ['pnpm-lockfile.mjs', 'workspace-dependency-satisfaction.mjs'],
      extraScripts: ['workspace-dependency-provenance.mjs'],
      files: buildOutput(3072),
      git: false,
    });
    stageLocalBundleDependency(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('2 JS');
  });
});

// ---------------------------------------------------------------------------
// dist:freshness (station#1813)
// ---------------------------------------------------------------------------

describe('dist:freshness rejects a build output that no longer matches its source', {
  timeout: 30_000,
}, () => {
  const SCRIPT = 'check-dist-freshness.mjs';
  const LIBS = ['module-entry.mjs', 'package-dist-freshness.mjs'];
  const EXTRA = ['write-dist-stamp.mjs'];

  /**
   * A miniature workspace with the exact shape that produced station#1813: one
   * package whose published entry points resolve into a **gitignored** build
   * directory, and one whose entry points resolve to tracked sources.
   *
   * The second package is not decoration. The gate's scope is derived, not
   * declared, so a control that must be classified *out* is what proves the
   * classification is doing work rather than matching everything.
   */
  function workspaceFiles(publicType = 'string'): Record<string, string> {
    return {
      '.gitignore': 'dist/\n',
      'package.json': `${JSON.stringify(
        {
          name: 'fixture-root',
          private: true,
          workspaces: ['packages/thing', 'packages/plain'],
          scripts: {
            'build:thing': 'npm run --workspace=packages/thing build',
          },
        },
        null,
        2,
      )}\n`,
      'packages/thing/package.json': `${JSON.stringify(
        {
          name: '@fixture/thing',
          main: 'dist/index.js',
          types: 'dist/index.d.ts',
          exports: {
            '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          },
          scripts: { build: 'tsc && node ../../scripts/write-dist-stamp.mjs' },
        },
        null,
        2,
      )}\n`,
      'packages/thing/tsconfig.json': `${JSON.stringify(
        {
          compilerOptions: { outDir: './dist', rootDir: './src' },
          include: ['src/**/*'],
          exclude: ['node_modules', 'dist', 'src/__tests__/**'],
        },
        null,
        2,
      )}\n`,
      'packages/thing/src/index.ts': `export interface Thing { id: ${publicType} }\n`,
      // Excluded from the package's own build by its tsconfig, so it must not
      // participate in the freshness digest either.
      'packages/thing/src/__tests__/thing.test.ts': 'export const cases = 1;\n',
      'packages/plain/package.json': `${JSON.stringify(
        { name: '@fixture/plain', exports: { '.': './src/index.ts' } },
        null,
        2,
      )}\n`,
      'packages/plain/src/index.ts': 'export const plain = true;\n',
    };
  }

  /**
   * What the package's real `build` script does at the point this gate cares
   * about: produce output, then stamp the source digest it was produced from.
   * The compiler itself is irrelevant here — the gate never reads dist content,
   * only the stamp — so the emit is simulated and the stamping is the
   * production script, executed.
   */
  function build(dir: string): void {
    const pkg = join(dir, 'packages', 'thing');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(
      join(pkg, 'dist', 'index.d.ts'),
      readFileSync(join(pkg, 'src', 'index.ts'), 'utf8'),
    );
    writeFileSync(join(pkg, 'dist', 'index.js'), 'export {};\n');
    const stamped = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'write-dist-stamp.mjs')],
      { cwd: pkg, encoding: 'utf8', windowsHide: true },
    );
    expect(stamped.status).toBe(0);
  }

  function repo(publicType?: string): string {
    return scratchRepo({
      script: SCRIPT,
      libs: LIBS,
      extraScripts: EXTRA,
      files: workspaceFiles(publicType),
    });
  }

  it('accepts a freshly built dist — the negative control', () => {
    const dir = repo();
    build(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.output).not.toContain('FAIL:');
    expect(result.status).toBe(0);
    expect(result.output).toContain('packages/thing/dist is fresh');
    // The derived classification, both directions: the src-backed sibling is
    // enumerated and excluded, and the enumerated total equals the real one.
    expect(result.output).toContain(
      'Checked 2 workspace package(s); 1 resolve entry points through a git-ignored build directory.',
    );
    expect(result.output).toContain(
      'packages/plain — 1 entry point(s) resolve to tracked sources',
    );
  });

  it('rejects a dist left stale by a source change, and says *dist is stale* rather than blaming a consumer', () => {
    // The station#1813 sequence exactly: build, then change the source so the
    // package's public type differs from the built .d.ts — which is what a
    // merge touching `packages/connect/src` does to every worktree at once.
    const dir = repo();
    build(dir);
    writeFileSync(
      join(dir, 'packages', 'thing', 'src', 'index.ts'),
      'export interface Thing { id: number; label: string }\n',
    );

    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'FAIL: packages/thing/dist is STALE relative to packages/thing/src.',
    );
    // The whole harm in #1813 is a correct tool blaming a file nobody touched
    // (`ConnectionBannerSource.tsx`, `OnboardingGate.tsx` in the live instance). A
    // guardrail whose diagnostic points at the wrong file is worse than none,
    // so the failure must lead with the dist directory and never name a
    // consumer as the offender.
    const failLine = result.output
      .split('\n')
      .find((line) => line.startsWith('FAIL:'))!;
    expect(failLine).toContain('packages/thing/dist');
    expect(failLine).not.toContain('.tsx');

    // ...and it must name the command that fixes it, derived from the root
    // manifest rather than hardcoded.
    expect(result.output).toContain('Fix: npm run build:thing');
  });

  it('accepts the same tree once the build is re-run — binding the failure to the staleness', () => {
    // The other direction. Without it, a red that came from a malformed
    // fixture is indistinguishable from the guardrail biting.
    const dir = repo();
    build(dir);
    writeFileSync(
      join(dir, 'packages', 'thing', 'src', 'index.ts'),
      'export interface Thing { id: number; label: string }\n',
    );
    expect(runGuardrail(dir, SCRIPT).status).toBe(1);
    build(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(0);
    expect(result.output).toContain('packages/thing/dist is fresh');
  });

  it('rejects a dist that was never built at all', () => {
    const dir = repo();
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAIL: packages/thing/dist is MISSING');
    expect(result.output).toContain('Fix: npm run build:thing');
  });

  it('rejects a dist built before the gate existed, rather than assuming it is fresh', () => {
    // Every worktree on this checkout has one of these the moment this lands.
    // Treating an unstamped dist as fresh would make the gate inert on exactly
    // the population it was built for.
    const dir = repo();
    const pkg = join(dir, 'packages', 'thing');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(
      join(pkg, 'dist', 'index.d.ts'),
      'export interface Thing {}\n',
    );
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('has no current freshness stamp');
    expect(result.output).toContain('Fix: npm run build:thing');
  });

  it('ignores changes the package excludes from its own build, so the gate is not noise', () => {
    // A gate that reds on an edit that cannot change the built .d.ts trains
    // people to rebuild reflexively, which is the habit that lets a real
    // staleness through. The digest follows the package's own tsconfig
    // `exclude`, so this is derived rather than a hardcoded `__tests__` rule.
    const dir = repo();
    build(dir);
    writeFileSync(
      join(dir, 'packages', 'thing', 'src', '__tests__', 'thing.test.ts'),
      'export const cases = 2;\nexport const added = true;\n',
    );
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(0);
    expect(result.output).toContain('packages/thing/dist is fresh');
  });

  it('rejects a tsconfig exclude that leaves the digest covering no source file (station#1813 review, HIGH-2)', () => {
    // The latent catastrophe. Moving a package from `__tests__/` to co-located
    // `*.test.ts` — an ordinary refactor, in a different file, reviewed by
    // someone thinking about tests — used to collapse the exclude pattern to
    // its root and reduce the digest to two manifest files, so every source
    // change read fresh FOREVER with no diagnostic.
    const dir = repo();
    const pkg = join(dir, 'packages', 'thing');
    writeFileSync(
      join(pkg, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: { outDir: './dist', rootDir: './src' },
          include: ['src/**/*'],
          exclude: ['node_modules', 'dist', 'src/**'],
        },
        null,
        2,
      )}\n`,
    );
    build(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'cannot be checked: the freshness digest covers no source file',
    );
    // Rebuilding is the wrong advice here and the gate must not give it.
    expect(result.output).toContain('Rebuilding will not');
    expect(result.output).toContain('narrow `exclude`');
  });

  it('excludes only what the pattern really matches, so a co-located test glob keeps the digest live', () => {
    // The other direction, and the one that proves the matcher rather than the
    // backstop: with `src/**/*.test.ts` the source tree must STILL be covered,
    // a public-type change must still read stale, and a test-file edit must
    // still read fresh.
    const dir = repo();
    const pkg = join(dir, 'packages', 'thing');
    writeFileSync(
      join(pkg, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: { outDir: './dist', rootDir: './src' },
          include: ['src/**/*'],
          exclude: ['node_modules', 'dist', 'src/**/*.test.ts'],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(pkg, 'src', 'co-located.test.ts'),
      'export const a = 1;\n',
    );
    build(dir);
    expect(runGuardrail(dir, SCRIPT).status).toBe(0);

    // A test edit is still not a staleness.
    writeFileSync(
      join(pkg, 'src', 'co-located.test.ts'),
      'export const a = 2;\n',
    );
    expect(runGuardrail(dir, SCRIPT).status).toBe(0);

    // A real source change still is.
    writeFileSync(
      join(pkg, 'src', 'index.ts'),
      'export interface Thing { id: number; label: string }\n',
    );
    const stale = runGuardrail(dir, SCRIPT);
    expect(stale.status).toBe(1);
    expect(stale.output).toContain('is STALE');
  });

  it('rejects a workspace that enumerates zero packages (station#1813 review, M-1)', () => {
    // `Checked 0 workspace package(s)` and exit 0 is the `> 300` floor defect:
    // the gate inspected nothing and called it clean.
    const dir = repo();
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'fixture-root', private: true }, null, 2)}\n`,
    );
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'FAIL: no workspace package was enumerated, so nothing was checked.',
    );
  });

  it('expands the object form of `workspaces` rather than silently reading zero', () => {
    const dir = repo();
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'fixture-root',
          private: true,
          workspaces: { packages: ['packages/thing', 'packages/plain'] },
          scripts: {
            'build:thing': 'npm run --workspace=packages/thing build',
          },
        },
        null,
        2,
      )}\n`,
    );
    build(dir);
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Checked 2 workspace package(s)');
  });

  it('reports an unparseable workspace manifest instead of dropping the package (station#1813 review, L-2)', () => {
    const dir = repo();
    build(dir);
    writeFileSync(join(dir, 'packages', 'plain', 'package.json'), '{ broken');
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'packages/plain/package.json could not be parsed',
    );
  });

  it('names a stale executable-only build as an executable, not as a typecheck failure', () => {
    // `packages/cli` publishes only a `bin`. Nothing typechecks through it, so
    // the consumer-file sentence would be a confident wrong diagnosis.
    const dir = repo();
    const manifest = JSON.parse(
      readFileSync(join(dir, 'packages', 'thing', 'package.json'), 'utf8'),
    );
    writeFileSync(
      join(dir, 'packages', 'thing', 'package.json'),
      `${JSON.stringify(
        {
          ...manifest,
          main: undefined,
          types: undefined,
          exports: undefined,
          bin: { thing: './dist/thing.mjs' },
        },
        null,
        2,
      )}\n`,
    );
    mkdirSync(join(dir, 'packages', 'thing', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'thing', 'dist', 'thing.mjs'), '\n');
    const result = runGuardrail(dir, SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('publishes that output as an executable');
    expect(result.output).toContain('the installed command just runs old code');
    expect(result.output).not.toContain('report a type error');
  });

  it('matches exclude patterns positionally rather than collapsing them to a root prefix', () => {
    // The unit behind HIGH-2, pinned in both directions.
    const collapsed = excludeMatcher(['src/**/*.test.ts']);
    expect(collapsed('src/index.ts')).toBe(false);
    expect(collapsed('src/core/thing.ts')).toBe(false);
    expect(collapsed('src/a.test.ts')).toBe(true);
    expect(collapsed('src/core/a.test.ts')).toBe(true);

    const directory = excludeMatcher(['src/__tests__/**']);
    expect(directory('src/__tests__/a.ts')).toBe(true);
    expect(directory('src/index.ts')).toBe(false);

    const bare = excludeMatcher(['dist', 'node_modules']);
    expect(bare('dist/index.js')).toBe(true);
    expect(bare('distant/index.js')).toBe(false);
  });

  it('is wired ahead of every typecheck project, and the build that stamps it', () => {
    // Fixtures prove the gate bites; only this proves it is reached. #1813 is
    // a *missing dependency between two scripts*, so the wiring is the fix and
    // an unwired gate would be the same defect with more code.
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(root.scripts.typecheck.startsWith('npm run dist:freshness &&')).toBe(
      true,
    );
    expect(root.scripts['dist:freshness']).toBe(
      'node scripts/check-dist-freshness.mjs',
    );
    const connect = JSON.parse(
      readFileSync('packages/connect/package.json', 'utf8'),
    );
    expect(connect.scripts.build).toContain(
      'node ../../scripts/write-dist-stamp.mjs',
    );
  });

  it('finds every dist-backed package in this repo — the recorded sibling audit (station#1813 AC4)', () => {
    // The audit answer, recomputed every run instead of written down once. If
    // a sibling grows a git-ignored entry point it appears here and the gate
    // starts covering it; if one stops having one, this fails rather than
    // letting the gate quietly govern nothing.
    //
    // The first version of this test pinned `['packages/connect']` and was
    // WRONG — `entryPointSpecifiers` read `main`/`module`/`types`/`exports` but
    // not `bin`, so `packages/cli`, whose only entry point is the git-ignored
    // bundle `station --link` installs, was reported as publishing none. A
    // derivation that recomputes the wrong property every run is not better
    // than a stale constant; it is a stale constant that looks live.
    const inspected = inspectWorkspace(process.cwd());
    const distBacked = inspected.packages
      .filter((pkg) => pkg.distBacked)
      .map((pkg) => pkg.relDir);
    expect(distBacked).toEqual(['packages/cli', 'packages/connect']);

    // …and *why* each one is on the path, so a package landing in scope for a
    // different reason than the audit recorded is visible.
    const fieldsFor = (relDir: string) =>
      inspected.packages.find((pkg) => pkg.relDir === relDir)!.distFields;
    expect(fieldsFor('packages/cli')).toEqual({ dist: ['bin'] });
    expect(fieldsFor('packages/connect').dist).toEqual(
      expect.arrayContaining(['exports', 'main', 'types']),
    );
  });

  it('reads bare entry-point specifiers, not only ./-prefixed ones', () => {
    // `packages/connect` declares `"main": "dist/index.js"` and
    // `"types": "dist/index.d.ts"` without a leading `./`. An earlier
    // `startsWith('.')` filter discarded both, so connect was in scope only
    // because its `exports` map happens to use `./`-prefixed strings — a
    // sibling going dist-backed via a bare `main` alone would have been
    // reported clean.
    expect(
      entryPointSpecifiers({
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
      }),
    ).toEqual(['dist/index.d.ts', 'dist/index.js']);
    expect(
      entryPointSpecifiers({ bin: { station: './dist/station.mjs' } }),
    ).toEqual(['dist/station.mjs']);
    // `imports`-style values are not published entry points.
    expect(entryPointSpecifiers({ main: '#internal' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// typecheck:scripts coverage (station#1805)
// ---------------------------------------------------------------------------

describe('typecheck:scripts refuses a scripts/ tree it does not fully account for', {
  timeout: 60_000,
}, () => {
  const SCRIPT = 'scripts-typecheck-coverage.mjs';

  /**
   * The gate resolves TypeScript from the repo root it is checking, so the
   * scratch repo is given a real one by symlink. It is the installed compiler
   * running against a fixture tree — not a stub, and not `npx` reaching for
   * whatever it can find (a placeholder `tsc` package exists on the registry
   * and exits 1 with a friendly message, which is how this fixture first
   * "failed").
   */
  function linkCompiler(dir: string): void {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(
      resolve('node_modules', 'typescript'),
      join(dir, 'node_modules', 'typescript'),
      'dir',
    );
  }

  interface TreeOptions {
    /** tsconfig `include`, defaulting to the production glob. */
    include?: string[];
    /** tsconfig `exclude`, minus `node_modules`. */
    exclude?: string[];
    /** baseline `deferred`; defaults to `exclude`. */
    deferred?: string[];
    /** Extra repo-relative files. */
    files?: Record<string, string>;
  }

  function tree({
    include = ['scripts/**/*.ts'],
    exclude = ['scripts/deferred/broken.ts'],
    deferred,
    files = {},
  }: TreeOptions = {}): string {
    const dir = scratchRepo({
      script: SCRIPT,
      libs: ['module-entry.mjs'],
      files: {
        'package.json': `${JSON.stringify({ name: 'scratch', private: true }, null, 2)}\n`,
        'tsconfig.scripts.json': `${JSON.stringify(
          {
            compilerOptions: {
              noEmit: true,
              strict: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              types: [],
            },
            include,
            exclude: ['node_modules', ...exclude],
          },
          null,
          2,
        )}\n`,
        'scripts/scripts-typecheck-baseline.json': `${JSON.stringify(
          { deferred: deferred ?? exclude },
          null,
          2,
        )}\n`,
        'scripts/clean.ts': 'export const clean: number = 1;\n',
        'scripts/nested/also-clean.ts': 'export const nested: string = "x";\n',
        'scripts/deferred/broken.ts':
          '// Deliberately ill-typed; stands in for the 57 real deferrals.\n' +
          'export const broken: number = "not a number";\n',
        ...files,
      },
    });
    linkCompiler(dir);
    return dir;
  }

  it('accepts a tree where every file is compiled or declared deferred — the negative control', () => {
    const result = runGuardrail(tree(), SCRIPT);
    expect(result.output).not.toContain('FAIL:');
    expect(result.status).toBe(0);
    // The exact partition, not a floor. A floor ("at least N checked") cannot
    // notice files vanishing from the numerator.
    expect(result.output).toContain(
      'Typechecked 2 of 3 TypeScript file(s) under scripts/; 1 deferred',
    );
    expect(result.output).toContain(
      'OK:   every .ts/.tsx/.mts/.cts file under scripts/ is compiled or declared deferred.',
    );
  });

  it('rejects a narrowed include glob that silently drops files from the program (the station#1805 shape itself)', () => {
    // This is the defect the whole issue is about, reproduced against the gate
    // that exists to catch it: a glob that looks like it covers `scripts/` and
    // does not. `scripts/*.ts` compiles the top level and silently omits every
    // subdirectory — and without this assertion the gate would report a clean
    // run over the two files it could still see.
    const result = runGuardrail(tree({ include: ['scripts/*.ts'] }), SCRIPT);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'FAIL: 1 TypeScript file(s) under scripts/ are neither compiled nor declared deferred',
    );
    expect(result.output).toContain('scripts/nested/also-clean.ts');
  });

  it('rejects a deferral widened in the tsconfig but not in the reviewable baseline', () => {
    // Making a type error go away by adding a file to `exclude` is the path of
    // least resistance under deadline. Requiring the same edit in a named
    // baseline is what turns it into something a reviewer sees.
    const result = runGuardrail(
      tree({
        exclude: ['scripts/deferred/broken.ts', 'scripts/nested/also-clean.ts'],
        deferred: ['scripts/deferred/broken.ts'],
      }),
      SCRIPT,
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain('disagree about what is deferred');
    expect(result.output).toContain('scripts/nested/also-clean.ts');
  });

  it('rejects a deferred entry that no longer names a real file', () => {
    // A list that keeps naming deleted files can hide a deletion behind a
    // stale entry — and an assertion that only iterates the list checking
    // non-emptiness cannot catch an entry disappearing, it just loops once
    // fewer.
    const result = runGuardrail(
      tree({
        exclude: ['scripts/deferred/broken.ts', 'scripts/deferred/gone.ts'],
      }),
      SCRIPT,
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain('name a file that no longer exists');
    expect(result.output).toContain('scripts/deferred/gone.ts');
  });

  it('rejects a file that is declared deferred while the compiler builds it anyway', () => {
    // `exclude` only filters root files; an excluded file still enters the
    // program through an import. Left unchecked, the baseline would claim
    // coverage was deferred for something already covered — a deferral list
    // that overstates the gap is as dishonest as one that understates it.
    const result = runGuardrail(
      tree({
        exclude: ['scripts/nested/also-clean.ts', 'scripts/deferred/broken.ts'],
        files: {
          'scripts/importer.ts':
            "export { nested } from './nested/also-clean.js';\n",
        },
      }),
      SCRIPT,
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'declared deferred but the compiler built them anyway',
    );
    expect(result.output).toContain('scripts/nested/also-clean.ts');
  });

  it('really typechecks — a type error in a covered file exits non-zero (the #1805 defect class)', () => {
    // The original finding was a live `TS2353` in `scripts/` that every gate
    // in the repo read as green. This is that case, executed.
    const result = runGuardrail(
      tree({
        files: {
          'scripts/regression.ts':
            'interface Shape { id: string }\n' +
            'export const value: Shape = { id: "a", gatePass: true };\n',
        },
      }),
      SCRIPT,
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain('exited 2');
    expect(result.output).toMatch(/scripts\/regression\.ts.*error TS2353/);
    expect(result.output).toContain('gatePass');
  });

  it('is wired into npm run typecheck, and covers this repo exhaustively right now', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    // station#4249: `typecheck` no longer names its 12 sub-lanes directly in
    // its own package.json field -- it delegates to the completion-mode
    // aggregate runner, whose lane catalog is the source of truth for what
    // actually runs. Assert THAT catalog still names typecheck:scripts,
    // rather than grepping a field that is now just an aggregate invocation.
    expect(root.scripts.typecheck).toContain(
      'node scripts/typecheck-aggregate.mjs',
    );
    expect(TYPECHECK_LANES.map((lane) => lane.id)).toContain(
      'typecheck:scripts',
    );
    expect(root.scripts['typecheck:scripts']).toBe(
      'node scripts/scripts-typecheck-coverage.mjs',
    );

    // Moving the lane list out of package.json bought completion-mode
    // reporting and created a NEW way to go uncovered: while `typecheck` was
    // an `&&` chain, adding `typecheck:<x>` without joining the chain was
    // self-evident in the diff; now a lane can exist as a script and simply
    // never run, and nothing about the aggregate's output would say so. This
    // caught exactly that during a merge — main added `typecheck:basis-pane`
    // to the chain this aggregate replaced, and resolving toward the
    // aggregate would have dropped the lane silently. Asserted as an exact
    // set, both directions: a script with no lane is an unrun gate, and a
    // lane with no script is a lane that cannot run.
    const typecheckScripts = Object.keys(root.scripts)
      .filter((name) => name.startsWith('typecheck:'))
      .sort();
    expect(TYPECHECK_LANES.map((lane) => lane.script).sort()).toEqual(
      typecheckScripts,
    );

    // The production partition, asserted here as an exact set so that a
    // deferral added without a baseline edit — or a file quietly leaving the
    // scan — fails a test rather than only a gate someone can rerun.
    const discovered = discoverScriptSources(process.cwd());
    const configured = configuredExclusions(process.cwd());
    expect(configured).toEqual(baselineDeferrals(process.cwd()));
    expect(discovered.length).toBeGreaterThan(configured.length);
    for (const file of configured) expect(discovered).toContain(file);
  });

  // station#4249 review: symmetric to the typecheck assertion above, and for
  // the same reason -- without this, reverting JUST the docs:truth:gate line
  // back to its old `&&` chain would pass every test in this suite today.
  it('docs:truth:gate is wired into the completion-mode aggregate runner, and its lane catalog matches package.json', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(root.scripts['docs:truth:gate']).toBe(
      'node scripts/docs-truth-gate-aggregate.mjs',
    );
    // Every lane the aggregate runner claims to run must be a REAL npm
    // script, and its command text must be exactly what the old `&&` chain
    // used to run for that check -- proving this is a mechanical un-chaining,
    // not a change to what any individual check does.
    const expectedCommands: Record<string, string> = {
      'contribution:gate': 'node scripts/public-contribution-surfaces.mjs',
      'labels:check': 'node scripts/label-manifest.mjs',
      'docs:issue-lifecycle:check':
        'node scripts/generate-issue-lifecycle-reference.mjs --check',
      'docs:contributor-commands:check': 'node scripts/just-interface.mjs',
      'docs:public:hygiene': 'node scripts/public-docs-hygiene.mjs',
      'docs:hygiene:repo': 'node scripts/repo-docs-hygiene.mjs',
      'docs:index:check': 'node scripts/docs-index.mjs --check',
      'docs:cli-parity:check': 'node scripts/cli-doc-parity.mjs',
      'docs:public:contract-examples':
        'node scripts/public-doc-contract-examples.mjs',
      'docs:links:check': 'node scripts/check-markdown-links.mjs',
    };
    expect(DOCS_TRUTH_GATE_LANES.map((lane) => lane.id)).toEqual([
      'contribution:gate',
      'labels:check',
      'docs:issue-lifecycle:check',
      'docs:contributor-commands:check',
      'docs:public:hygiene',
      'docs:hygiene:repo',
      'docs:index:check',
      'docs:cli-parity:check',
      'docs:public:contract-examples',
      'docs:foundations:test',
      'docs:links:check',
      'docs:truth:biome',
    ]);
    for (const lane of DOCS_TRUTH_GATE_LANES) {
      expect(root.scripts).toHaveProperty(lane.script);
      if (expectedCommands[lane.id]) {
        expect(root.scripts[lane.script]).toBe(expectedCommands[lane.id]);
      }
    }
    // The extracted biome check's command text is byte-identical to what the
    // old `&&` chain ran last, just given its own script id.
    expect(root.scripts['docs:truth:biome']).toContain(
      'npx biome check .github/labels.json',
    );
  });
});
