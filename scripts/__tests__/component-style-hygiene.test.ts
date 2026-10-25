import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  compareComponentStyle,
  inspectComponentStyle,
} from '../component-style-hygiene.mjs';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const GATE = resolve(__dirname, '../component-style-hygiene.mjs');

describe('component and style policy', () => {
  it('finds standard-action and dialog bypasses while allowing composite controls and canonical components', () => {
    expect(
      inspectComponentStyle(
        'panel.tsx',
        '<button className="item__action item--primary">Save</button>',
      ),
    ).toEqual([
      { kind: 'bespoke-action', key: '"item__action item--primary"' },
    ]);
    expect(inspectComponentStyle('panel.tsx', '<div role="dialog" />')).toEqual(
      [{ kind: 'bespoke-dialog', key: 'div' }],
    );
    for (const source of [
      '<dialog open />',
      '<div role={"dialog"} />',
      '<aside role={`alertdialog`} />',
    ]) {
      expect(inspectComponentStyle('panel.tsx', source)).toHaveLength(1);
    }
    expect(
      inspectComponentStyle(
        'panel.tsx',
        '<><button role="switch" className="toggle" /><Button variant="primary">Save</Button><Dialog title="Edit" /></>',
      ),
    ).toEqual([]);
    expect(
      inspectComponentStyle(
        'panel.tsx',
        'const example = \'<div role="dialog">\';',
      ),
    ).toEqual([]);
  });
  it('reports legacy token references, permits geometry and canonical tokens, and attributes growth per file and signature', () => {
    expect(
      inspectComponentStyle(
        'panel.css',
        '.item { padding: var(--space-4); color: var(--k-text); min-height: 44px; }',
      ),
    ).toEqual([{ kind: 'legacy-token', key: '--space-4' }]);
    expect(
      inspectComponentStyle(
        'panel.css',
        '/* var(--space-4) */ .item { content: "var(--space-4)"; padding: var(--k-space-4); }',
      ),
    ).toEqual([]);
    expect(
      compareComponentStyle(
        { 'old.css': { 'legacy-token:--space-4': 1 } },
        { 'old.css': { 'legacy-token:--space-4': 2 } },
      ),
    ).toEqual([]);
    expect(
      compareComponentStyle(
        { 'new.css': { 'legacy-token:--space-4': 1 } },
        { 'old.css': { 'legacy-token:--space-4': 1 } },
      ),
    ).toEqual([{ file: 'new.css', key: 'legacy-token:--space-4', added: 1 }]);
  });
  it('refuses malformed inventories instead of accepting missing debt limits', () => {
    for (const baseline of [
      null,
      [],
      { 'a.css': null },
      { 'a.css': { token: -1 } },
      { 'a.css': { token: '1' } },
    ]) {
      expect(() => compareComponentStyle({}, baseline)).toThrow();
    }
  });
  it('flags a role="alert" surface that carries its own action, and nothing that ErrorState already owns', () => {
    expect(
      inspectComponentStyle(
        'pane.tsx',
        '<p role="alert">Subtasks unavailable. <Button onClick={retry}>Retry</Button></p>',
      ),
    ).toEqual([{ kind: 'alert-with-action', key: 'p' }]);
    expect(
      inspectComponentStyle(
        'pane.tsx',
        '<div role={"alert"}><span>Failed.<button type="button">Retry</button></span></div>',
      ),
    ).toEqual([{ kind: 'alert-with-action', key: 'div' }]);
    for (const source of [
      '<p role="alert">Subtasks unavailable.</p>',
      '<p role="status">Saved. <Button>Undo</Button></p>',
      '<><p role="alert">Failed.</p><Button>Retry</Button></>',
      '<ErrorState variant="compact" title="Failed" action={<Button>Retry</Button>} />',
      'const example = \'<p role="alert"><button /></p>\';',
    ]) {
      expect(inspectComponentStyle('pane.tsx', source)).toEqual([]);
    }
  });
  describe('as a child process against a disposable repository', () => {
    const makeTempDir = trackTempDirs({ lifetime: 'test' });
    const runGate = (
      files: Record<string, string>,
      baseline: Record<string, Record<string, number>>,
    ) => {
      const root = makeTempDir('component-style-gate-');
      execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
      const write = (file: string, content: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
      };
      for (const [file, content] of Object.entries(files)) write(file, content);
      write(
        'scripts/component-style-hygiene-baseline.json',
        `${JSON.stringify({ version: 1, files: baseline }, null, 2)}\n`,
      );
      return spawnSyncBounded(process.execPath, [GATE], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
    };
    const alert = (label: string) =>
      `export const View = () => <p role="alert">${label} unavailable. <Button onClick={retry}>Retry</Button></p>;\n`;
    const inherited = {
      'src-ui/src/Inherited.tsx': { 'alert-with-action:p': 2 },
    };

    it('rejects a new alert-with-action in a pane package and names it', () => {
      const result = runGate(
        {
          'src-ui/src/Inherited.tsx': alert('Old') + alert('Older'),
          'packages/board-pane/src/NewPane.tsx': alert('Board'),
        },
        inherited,
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'packages/board-pane/src/NewPane.tsx: alert-with-action:p (+1)',
      );
      expect(result.stderr).toContain('ErrorState');
      expect(result.stderr).not.toContain('Inherited.tsx');
    });

    it('accepts the inherited baseline and any shrink of it, including a removed file', () => {
      const unchanged = runGate(
        { 'src-ui/src/Inherited.tsx': alert('Old') + alert('Older') },
        inherited,
      );
      expect(unchanged.status, unchanged.stderr).toBe(0);
      expect(unchanged.stdout).toContain('0 new');
      const shrunk = runGate(
        {
          'src-ui/src/Inherited.tsx': alert('Old'),
          'src-ui/src/Clean.tsx': 'export const Clean = () => null;\n',
        },
        {
          ...inherited,
          'packages/basis-pane/src/Fixed.tsx': { 'alert-with-action:p': 1 },
        },
      );
      expect(shrunk.status, shrunk.stderr).toBe(0);
    });
  });
});
