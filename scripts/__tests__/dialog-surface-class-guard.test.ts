import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildDefinedClassChecker,
  EXEMPT,
  evaluate,
  extractDialogSurfaceClasses,
  findUndefinedDialogSurfaceClasses,
  listScannedSourceFiles,
  listScannedStyleFiles,
  SCAN_PATHSPECS,
  SCOPE_SENTINELS,
} from '../dialog-surface-class-guard.mjs';

describe('dialog-surface-class guard source matching', () => {
  test('extracts a direct plain-literal overlayClassName/panelClassName pair', () => {
    const source = `
      <ResponsiveDialogSurface
        overlayClassName="acp-add-dialog__overlay"
        panelClassName="acp-add-dialog"
      >`;
    expect(extractDialogSurfaceClasses(source)).toEqual([
      { prop: 'overlayClassName', token: 'acp-add-dialog__overlay' },
      { prop: 'panelClassName', token: 'acp-add-dialog' },
    ]);
  });

  test('extracts every space-separated class in a multi-class literal', () => {
    const source = `<ResponsiveDialogSurface overlayClassName="composer-popover-overlay composer-popover-overlay--start">`;
    expect(extractDialogSurfaceClasses(source)).toEqual([
      { prop: 'overlayClassName', token: 'composer-popover-overlay' },
      { prop: 'overlayClassName', token: 'composer-popover-overlay--start' },
    ]);
  });

  test('extracts the static prefix of a template literal and drops the dynamic tail', () => {
    // Dialog.tsx's own shape.
    const source =
      '<ResponsiveDialogSurface overlayClassName={`station-dialog__overlay ${overlayClassName}`.trim()}>';
    expect(extractDialogSurfaceClasses(source)).toEqual([
      { prop: 'overlayClassName', token: 'station-dialog__overlay' },
    ]);
  });

  test('drops a token that is entirely a runtime interpolation', () => {
    const source =
      '<ResponsiveDialogSurface panelClassName={`station-dialog--${variant}`}>';
    expect(extractDialogSurfaceClasses(source)).toEqual([]);
  });

  test('does not match a bare identifier or member expression', () => {
    const source =
      '<ResponsiveDialogSurface overlayClassName={cx.overlay} panelClassName={cx.panel}>';
    expect(extractDialogSurfaceClasses(source)).toEqual([]);
  });

  test('skips a class passed to <Dialog>, not <ResponsiveDialogSurface>', () => {
    const source = `
      <Dialog
        panelClassName="usage-telemetry-disclosure"
        overlayClassName="usage-telemetry-disclosure__overlay"
      >`;
    expect(extractDialogSurfaceClasses(source)).toEqual([]);
  });

  test('resolves ownership positionally across two ResponsiveDialogSurface calls in one file', () => {
    const source = `
      function First() {
        return <ResponsiveDialogSurface overlayClassName="first-overlay" />;
      }
      function Second() {
        return <ResponsiveDialogSurface overlayClassName="second-overlay" />;
      }
    `;
    expect(extractDialogSurfaceClasses(source)).toEqual([
      { prop: 'overlayClassName', token: 'first-overlay' },
      { prop: 'overlayClassName', token: 'second-overlay' },
    ]);
  });

  test('a ResponsiveDialogSurface prop after a Dialog call earlier in the file is still direct', () => {
    const source = `
      <Dialog panelClassName="usage-telemetry-disclosure" />
      <ResponsiveDialogSurface overlayClassName="acp-add-dialog__overlay" />
    `;
    expect(extractDialogSurfaceClasses(source)).toEqual([
      { prop: 'overlayClassName', token: 'acp-add-dialog__overlay' },
    ]);
  });
});

describe('dialog-surface-class guard definition checking', () => {
  test('finds a class defined as a plain rule', () => {
    const isDefined = buildDefinedClassChecker(['a.css'], () => '.foo { }');
    expect(isDefined('foo')).toBe(true);
  });

  test('does not treat a compound descendant class as defining its own prefix', () => {
    // The exact false-negative this gate was rewritten to fix: `.foo__bar`
    // must not make `isDefined('foo')` true.
    const isDefined = buildDefinedClassChecker(
      ['a.css'],
      () => '.foo__bar { } .foo__baz { }',
    );
    expect(isDefined('foo')).toBe(false);
    expect(isDefined('foo__bar')).toBe(true);
  });

  test('finds a class inside a compound selector or a pseudo-class', () => {
    const isDefined = buildDefinedClassChecker(
      ['a.css'],
      () => '.foo.bar:hover { }',
    );
    expect(isDefined('bar')).toBe(true);
  });
});

describe('dialog-surface-class guard scope honesty', () => {
  test('every sentinel is inside the scanned set', () => {
    const files = listScannedSourceFiles();
    for (const sentinel of SCOPE_SENTINELS) {
      expect(files).toContain(sentinel);
    }
  });

  test('a lost sentinel fails rather than reporting green', () => {
    expect(evaluate([], ['src-ui/src/a.tsx'])).toMatchObject({ ok: false });
  });

  test('the scanned source set is every tracked .tsx under SCAN_PATHSPECS, minus tests', () => {
    const tracked = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split('\n')
      .filter((line) => line.endsWith('.tsx'))
      .filter((line) => !line.includes('__tests__'));

    expect([...listScannedSourceFiles()].sort()).toEqual(tracked.sort());
  });

  test('the repo is at zero, which is the whole point of this gate', () => {
    const sourceFiles = listScannedSourceFiles();
    const styleFiles = listScannedStyleFiles();
    const isDefined = buildDefinedClassChecker(styleFiles);
    const violations = findUndefinedDialogSurfaceClasses(sourceFiles, {
      isDefined,
    });
    expect(evaluate(violations, sourceFiles)).toMatchObject({
      violations: [],
      ok: true,
    });
  });

  test('EXEMPT entries name a real file in scope', () => {
    const files = listScannedSourceFiles();
    for (const entry of EXEMPT) {
      expect(files).toContain(entry.file);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The gate's REJECTION path, run as a real child process against a
 * throwaway git repository. A guardrail whose refusal has never executed is
 * unproven: the pure functions above say what it DECIDES, and only these say
 * what it does with that decision — the `FAIL:` sentence and, critically,
 * the exit status. Bounded, single-shot children; classified process-heavy
 * in `scripts/vitest-resource-manifest.mjs` for exactly that reason.
 */
describe('dialog-surface-class guard at the process boundary', () => {
  const GUARD = resolve(import.meta.dirname, '../dialog-surface-class-guard.mjs');
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dialog-surface-class-guard-'));
    created.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    return dir;
  }

  /** Every sentinel present with a clean, defined class, so only the
   * injected file can decide the outcome. */
  const cleanSentinels = Object.fromEntries(
    SCOPE_SENTINELS.map((path, index) => [
      path,
      `export const Sentinel${index} = () => (\n` +
        `  <ResponsiveDialogSurface overlayClassName="sentinel-${index}-overlay" />\n` +
        ');\n',
    ]),
  );
  const sentinelCss =
    SCOPE_SENTINELS.map((_, index) => `.sentinel-${index}-overlay { }`).join(
      '\n',
    ) + '\n';

  function runGuard(dir: string) {
    return spawnSync(process.execPath, [GUARD], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  test('exits 0 and names its scope when every dialog-surface class is defined', () => {
    const run = runGuard(
      repoWith({
        ...cleanSentinels,
        'src-ui/src/sentinels.css': sentinelCss,
      }),
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'OK: 0 undefined overlayClassName/panelClassName classes',
    );
  });

  test('exits 1 and names the offending file when an overlay class regrows undefined', () => {
    const run = runGuard(
      repoWith({
        ...cleanSentinels,
        'src-ui/src/sentinels.css': sentinelCss,
        'src-ui/src/components/Regression.tsx':
          'export const Regression = () => (\n' +
          '  <ResponsiveDialogSurface overlayClassName="regression-dialog__overlay" />\n' +
          ');\n',
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'FAIL: 1 overlayClassName/panelClassName value(s)',
    );
    expect(run.stderr).toContain(
      'src-ui/src/components/Regression.tsx: overlayClassName="regression-dialog__overlay"',
    );
  });

  test('does not flag the same class name passed to <Dialog> instead', () => {
    const run = runGuard(
      repoWith({
        ...cleanSentinels,
        'src-ui/src/sentinels.css': sentinelCss,
        'src-ui/src/components/ViaDialog.tsx':
          'export const ViaDialog = () => (\n' +
          '  <Dialog panelClassName="undefined-but-safe" />\n' +
          ');\n',
      }),
    );
    expect(run.status).toBe(0);
  });
});
