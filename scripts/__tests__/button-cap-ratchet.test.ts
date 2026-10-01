import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  evaluate,
  flattenBaselineRows,
  groupBaselineEntries,
  LABELLED_ACTION_CAP,
  loweredBaseline,
  scanSource,
} from '../button-cap-ratchet.mjs';

const GATE = resolve('scripts/button-cap-ratchet.mjs');
const tempDir = trackTempDirs();

/**
 * Runs the gate as a real child process against a fixture tree, because the
 * contract is its EXIT STATUS and the row it names — neither is observable
 * from an imported function.
 */
function runGate(
  files: Record<string, string>,
  baselineRows: Record<string, number[]> = {},
  extraArgs: string[] = [],
) {
  const root = tempDir('button-cap-');
  const tree = join(root, 'tree');
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(join(tree, file), content);
  }
  const baseline = join(root, 'baseline.json');
  writeFileSync(
    baseline,
    JSON.stringify({ rows: flattenBaselineRows(baselineRows) }),
  );
  const result = spawnSync(
    process.execPath,
    [GATE, `--root=${tree}`, `--baseline=${baseline}`, ...extraArgs],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    baseline: () => JSON.parse(readFileSync(baseline, 'utf8')),
  };
}

const row = (buttons: string) => `
import { Button } from './Button';
export function Toolbar() {
  return (
    <div className="toolbar__actions">
      ${buttons}
    </div>
  );
}
`;

const TWO = '<Button>Save</Button><Button>Cancel</Button>';
const THREE = `${TWO}<Button>Export</Button>`;
const FOUR = `${THREE}<Button>Share</Button>`;
const TOOLBAR_KEY = 'Toolbar.tsx :: Toolbar :: div.toolbar__actions';

describe('button-cap gate, as a child process', () => {
  test('pins the cap the fixtures below are written against', () => {
    expect(LABELLED_ACTION_CAP).toBe(2);
  });

  test('passes a row with two labelled actions', () => {
    const result = runGate({ 'Toolbar.tsx': row(TWO) });
    expect(result.status, result.output).toBe(0);
  });

  test('fails a row with three labelled actions and names the row', () => {
    const result = runGate({ 'Toolbar.tsx': row(THREE) });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(TOOLBAR_KEY);
    expect(result.output).toContain('3 labelled actions');
    expect(result.output).toContain('`overflow` items');
  });

  test('passes a baseline-recorded row that did not grow', () => {
    const result = runGate(
      { 'Toolbar.tsx': row(THREE) },
      { [TOOLBAR_KEY]: [3] },
    );
    expect(result.status, result.output).toBe(0);
  });

  test('fails a baseline-recorded row that grew', () => {
    const result = runGate(
      { 'Toolbar.tsx': row(FOUR) },
      { [TOOLBAR_KEY]: [3] },
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(TOOLBAR_KEY);
    expect(result.output).toContain('up from the recorded 3');
  });

  test('a recorded row survives moving to a different line', () => {
    const moved = `// a comment\n\n\n// that moves every line\n${row(THREE)}`;
    const result = runGate({ 'Toolbar.tsx': moved }, { [TOOLBAR_KEY]: [3] });
    expect(result.status, result.output).toBe(0);
  });

  test('passes an icon-only third action that carries an accessible name', () => {
    const result = runGate({
      'Toolbar.tsx': row(
        `${TWO}<Button aria-label="Refresh"><RefreshGlyph /></Button>`,
      ),
    });
    expect(result.status, result.output).toBe(0);
  });

  test('an icon-only third action with NO accessible name earns no exemption', () => {
    const result = runGate({
      'Toolbar.tsx': row(`${TWO}<Button><RefreshGlyph /></Button>`),
    });
    expect(result.status, result.output).toBe(1);
  });

  test('passes two labelled actions beside an overflow menu holding the rest', () => {
    const result = runGate({
      'Toolbar.tsx': row(`${TWO}
        <button type="button" aria-haspopup="menu" aria-label="More actions">⋯</button>
        <div role="menu" className="menu-surface">
          <button type="button" role="menuitem" className="menu-row">Export</button>
          <button type="button" role="menuitem" className="menu-row">Share</button>
          <button type="button" role="menuitem" className="menu-row">Remove</button>
        </div>`),
    });
    expect(result.status, result.output).toBe(0);
  });

  test('an overflow menu does not excuse three labelled actions beside it', () => {
    const result = runGate({
      'Toolbar.tsx': row(`${THREE}
        <button type="button" aria-haspopup="menu" aria-label="More actions">⋯</button>`),
    });
    expect(result.status, result.output).toBe(1);
  });

  test('a shrunk row passes with a note, and --record lowers the baseline', () => {
    const files = { 'Toolbar.tsx': row(THREE) };
    const note = runGate(files, { [TOOLBAR_KEY]: [4] });
    expect(note.status, note.output).toBe(0);
    expect(note.output).toContain('--record');

    const recorded = runGate(files, { [TOOLBAR_KEY]: [4] }, ['--record']);
    expect(recorded.status, recorded.output).toBe(0);
    expect(recorded.baseline().rows).toEqual([
      { row: TOOLBAR_KEY, labelledActions: 3 },
    ]);
  });

  test('--record refuses growth instead of recording it', () => {
    const result = runGate({ 'Toolbar.tsx': row(THREE) }, {}, ['--record']);
    expect(result.status, result.output).toBe(1);
    expect(result.baseline().rows).toEqual([]);
  });

  test('fails closed on a file that does not parse, naming it', () => {
    const result = runGate({
      'Toolbar.tsx': row(TWO),
      'Broken.tsx': 'export function Broken() { return <div>; }',
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('could not parse Broken.tsx');
  });

  test('the remedy points at ActionRow and explains a renamed row', () => {
    const result = runGate({ 'Toolbar.tsx': row(THREE) });
    expect(result.output).toContain('src-ui/src/components/ActionRow.tsx');
    expect(result.output).toContain('renamed');
  });

  test('fails closed on a tree with nothing to scan', () => {
    const result = runGate({ 'notes.txt': 'no components here' });
    expect(result.status, result.output).toBe(1);
  });

  test('accepts this repository against its checked-in baseline', () => {
    const result = spawnSync(process.execPath, [GATE], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  }, 60_000);
});

describe('button-cap scan', () => {
  const count = (buttons: string) =>
    scanSource('Toolbar.tsx', row(buttons))[0]?.count ?? 0;

  test('mutually exclusive arms count as the larger arm', () => {
    expect(
      count(`${TWO}{editing ? <Button>Apply</Button> : <Button>Edit</Button>}`),
    ).toBe(3);
    expect(
      count(`<Button>Close</Button>{editing ? <Button>Apply</Button> : null}`),
    ).toBe(0);
  });

  // Delta review M1: choosing a ternary's "longer" arm before weighing it
  // against its siblings reported 2 here. With `c` false and `m === 'x'` the
  // screen shows A, B and R.
  test('a ternary is counted once per arm, each with its siblings', () => {
    expect(
      count(`
        {m === 'x' && <Button>Alpha</Button>}
        {m === 'x' && <Button>Beta</Button>}
        {c ? (m !== 'x' && <><Button>Pi</Button><Button>Rho</Button></>) : <Button>Sigma</Button>}`),
    ).toBe(3);
    // The other arm alone would not be over the cap: Pi and Rho exclude
    // Alpha and Beta.
    expect(
      count(`
        {m === 'x' && <Button>Alpha</Button>}
        {m === 'x' && <Button>Beta</Button>}
        {m !== 'x' && <><Button>Pi</Button><Button>Rho</Button></>}`),
    ).toBe(0);
  });

  test('nested ternaries are alternatives all the way down', () => {
    // a ? (b ? [P, Q] excluded by m : R) : null — the R arm shows A, B, R.
    expect(
      count(`
        {m === 'x' && <Button>Alpha</Button>}
        {m === 'x' && <Button>Beta</Button>}
        {a ? (b ? (m !== 'x' && <><Button>Pi</Button><Button>Rho</Button></>) : <Button>Sigma</Button>) : null}`),
    ).toBe(3);
    // Two independent ternaries: the worst combination is one from each.
    expect(
      count(`
        <Button>Alpha</Button>
        {a ? <Button>Beta</Button> : null}
        {b ? null : <Button>Gamma</Button>}`),
    ).toBe(3);
    // Arms of ONE ternary never add up.
    expect(
      count(
        `<Button>Alpha</Button>{a ? <Button>Beta</Button> : <Button>Gamma</Button>}`,
      ),
    ).toBe(0);
    expect(
      count(
        `${TWO}{label ?? <Button>Fallback</Button>}{a || <Button>Other</Button>}`,
      ),
    ).toBe(4);
  });

  test('a conditional action still counts', () => {
    expect(count(`${TWO}{canExport && <Button>Export</Button>}`)).toBe(3);
  });

  test('&& guards the text proves exclusive are not summed', () => {
    // x against !x.
    expect(
      count(
        `${TWO}{busy && <Button>Stop</Button>}{!busy && <Button>Start</Button>}`,
      ),
    ).toBe(3);
    expect(
      count(
        `<Button>Close</Button>{busy && <Button>Stop</Button>}{!busy && <Button>Start</Button>}`,
      ),
    ).toBe(0);
    // One expression against two literals, with other conjuncts alongside.
    expect(
      count(`
        {kind === 'reserve' && <Button>Reserve</Button>}
        {kind === 'stop' && !done && <Button>Stop session</Button>}
        {canCancel && <Button>Cancel</Button>}`),
    ).toBe(0);
    // === against !== on the same literal.
    expect(
      count(`
        {mode === 'sign-in' && <Button>Create account</Button>}
        {mode !== 'sign-in' && <Button>Back to sign in</Button>}
        {mode === 'sign-in' && <Button>Forgot password</Button>}`),
    ).toBe(0);
  });

  // Review M1: the first proof compared guard TEXT and called each of these
  // pairs exclusive, hiding a row of three. None is provable, so all count.
  test.each([
    [
      'a negation that binds tighter than its ||',
      '(!loading || error)',
      '(loading || error)',
    ],
    [
      'a literal comparison inside an ||',
      "(ready || kind === 'x')",
      "(ready || kind === 'y')",
    ],
    ['a negated operand of ===', '!left === right', 'left === right'],
    ['a call, which need not answer the same twice', 'flip()', '!flip()'],
    ['an optional chain', 'host?.ready', '!host?.ready'],
    ['an indexed read', 'flags[0]', '!flags[0]'],
    ['a comparison of two names', 'mode === wanted', 'mode !== wanted'],
    ['a nullish fallback', '(mode ?? fallback)', '!(mode ?? fallback)'],
  ])('%s is not proved exclusive', (_name, first, second) => {
    expect(
      count(`
        {${first} && <Button>First</Button>}
        {${second} && <Button>Second</Button>}
        <Button>Third</Button>`),
    ).toBe(3);
  });

  test('a provable guard stays provable through parentheses and extra conjuncts', () => {
    expect(
      count(`
        {(host.hub.ready) && canAct && <Button>First</Button>}
        {!host.hub.ready && <Button>Second</Button>}
        <Button>Third</Button>`),
    ).toBe(0);
    expect(
      count(`
        {'a' === kind && <Button>First</Button>}
        {kind === 'b' && <Button>Second</Button>}
        <Button>Third</Button>`),
    ).toBe(0);
  });

  test('guards that are merely different are assumed compatible', () => {
    expect(
      count(`
        {canSave && <Button>Save</Button>}
        {canExport && <Button>Export</Button>}
        {canShare && <Button>Share</Button>}`),
    ).toBe(3);
    expect(
      count(`
        {kind === 'a' && <Button>One</Button>}
        {other === 'b' && <Button>Two</Button>}
        {kind !== 'c' && <Button>Three</Button>}`),
    ).toBe(3);
  });

  test('a title-and-description tile is a card, not a labelled action', () => {
    expect(
      count(`
        <button><strong>Run on Station</strong><small>Uses a model you choose.</small></button>
        <button><strong>Run elsewhere</strong><small>Another engine.</small></button>
        <button><strong>Copy an agent</strong><small>Start from yours.</small></button>`),
    ).toBe(0);
    // One text block beside a glyph is still an ordinary labelled button.
    expect(
      count(`${TWO}<button><PlusGlyph /><span>Add another</span></button>`),
    ).toBe(3);
  });

  test('a button inside a single-child wrapper is still in the row', () => {
    expect(
      count(`${TWO}<Tooltip label="x"><Button>Export</Button></Tooltip>`),
    ).toBe(3);
  });

  test('choices are not actions', () => {
    expect(
      count(`
        <button role="tab">One</button>
        <button role="tab">Two</button>
        <button role="tab">Three</button>`),
    ).toBe(0);
    expect(
      count(`
        <Button aria-pressed={a}>List</Button>
        <Button aria-pressed={b}>Board</Button>
        <Button aria-pressed={c}>Graph</Button>`),
    ).toBe(0);
  });

  test('a glyph drawn with text is an icon, not a label', () => {
    expect(
      count(`${TWO}
        <Button aria-label="Zoom out">−</Button>
        <Button aria-label="Zoom in">+</Button>`),
    ).toBe(0);
  });

  test('content between buttons breaks the run; an empty spacer does not', () => {
    expect(count(`<Button>Save</Button><p>Saved a minute ago.</p>${TWO}`)).toBe(
      0,
    );
    expect(count(`<Button>Save</Button><div className="spacer" />${TWO}`)).toBe(
      3,
    );
  });

  // Found by fault injection: a third labelled button added AFTER a row's
  // overflow menu component passed, because the component broke the run.
  test('an overflow menu component in the row does not split it in two', () => {
    expect(
      count(
        `<Button>Test</Button><MoreMenu actions={folded} /><Button>Export</Button><Button>Save</Button>`,
      ),
    ).toBe(3);
    expect(
      count(
        `<Button>Test</Button><MoreMenu actions={folded} /><Button>Save</Button>`,
      ),
    ).toBe(0);
  });

  // Found by fault injection: a Button added beside an ActionRow was the third
  // label on screen and the only one the scan counted.
  test('an ActionRow counts as its filled slots, so a button beside it is caught', () => {
    const actionRow =
      '<ActionRow overflowLabel="More" secondary={<Button>Test</Button>} primary={<Button>Save</Button>} />';
    expect(count(`${actionRow}<Button>Export</Button>`)).toBe(3);
    expect(count(actionRow)).toBe(0);
    // With neither slot filled the overflow trigger carries a word, so the
    // row still shows one labelled action.
    expect(
      count(`${TWO}<ActionRow overflowLabel="Manage" overflow={items} />`),
    ).toBe(3);
    expect(
      count(
        `${TWO}<ActionOverflowMenu label="Manage" triggerText="Manage" actions={a} />`,
      ),
    ).toBe(3);
    expect(
      count(
        '<ActionRow overflowLabel="More" primary={<Button>Save</Button>} /><Button>Export</Button>',
      ),
    ).toBe(0);
  });

  // Delta review M2: an exemption read from the first string ANYWHERE in an
  // attribute let a conditional value hide a row. Only a static string exempts.
  test('a conditional role or class exempts nothing', () => {
    const container = (attributes: string) =>
      scanSource(
        'Bar.tsx',
        `export function Bar() {
          return <div ${attributes}>${THREE}</div>;
        }`,
      ).length;
    expect(container(`className={open ? 'menu-surface' : 'toolbar'}`)).toBe(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JSX source under test, not a template of this file.
    expect(container('className={`menu-surface ${extra}`}')).toBe(1);
    expect(container(`role={open ? 'menu' : undefined}`)).toBe(1);
    expect(container('role={role}')).toBe(1);
    // Static, in any of its spellings.
    expect(container('role="menu"')).toBe(0);
    expect(container(`role={'menu'}`)).toBe(0);
    expect(container('className={`menu-surface`}')).toBe(0);

    const withButton = (attributes: string) =>
      count(`${TWO}<Button ${attributes}>Third</Button>`);
    expect(withButton(`role={selected ? 'tab' : undefined}`)).toBe(3);
    expect(withButton('role="tab"')).toBe(0);
    expect(withButton(`aria-haspopup={open ? 'menu' : undefined}`)).toBe(3);
    // A visually-hidden class has to be static to hide a label.
    expect(
      count(
        `${TWO}<Button><span className={hide ? 'sr-only' : ''}>Third</span></Button>`,
      ),
    ).toBe(3);
  });

  test('a row is still NAMED by a computed class', () => {
    const [found] = scanSource(
      'Bar.tsx',
      `export function Bar() {
        return <div className={\`toolbar \${dense}\`}>${THREE}</div>;
      }`,
    );
    expect(found?.key).toBe('Bar.tsx :: Bar :: div.toolbar');
  });

  test('only a readable menu-opening aria-haspopup exempts a button', () => {
    const withTrigger = (attribute: string) =>
      count(`${TWO}<Button ${attribute}>More actions</Button>`);
    expect(withTrigger('aria-haspopup')).toBe(0);
    expect(withTrigger('aria-haspopup="menu"')).toBe(0);
    expect(withTrigger('aria-haspopup={true}')).toBe(0);
    expect(withTrigger('aria-haspopup="listbox"')).toBe(0);
    expect(withTrigger('aria-haspopup={false}')).toBe(3);
    expect(withTrigger('aria-haspopup="dialog"')).toBe(3);
    expect(withTrigger('aria-haspopup={popup}')).toBe(3);
  });

  test('a class that merely contains "menu" does not make a container a menu', () => {
    const container = (attributes: string) =>
      scanSource(
        'Bar.tsx',
        `export function Bar() {
          return <div ${attributes}>${THREE}</div>;
        }`,
      ).length;
    expect(container('className="context-menu-bar"')).toBe(1);
    expect(container('className="pane__menu-row"')).toBe(1);
    expect(container('className="menu-surface"')).toBe(0);
    expect(container('role="menu" className="context-menu-bar"')).toBe(0);
  });

  test('an overflow menu that inlines a single command counts as a labelled action', () => {
    expect(
      count(
        `${TWO}<ActionOverflowMenu inlineSingle label="More" actions={a} />`,
      ),
    ).toBe(3);
    expect(count(`${TWO}<ChatDockHeaderMoreMenu actions={a} />`)).toBe(3);
    expect(count(`${TWO}<ActionOverflowMenu label="More" actions={a} />`)).toBe(
      0,
    );
    expect(
      count(
        `${TWO}<ActionOverflowMenu inlineSingle={false} label="More" actions={a} />`,
      ),
    ).toBe(0);
    expect(
      count(
        '<ActionRow overflowLabel="More" secondary={x} primary={y} /><ActionOverflowMenu inlineSingle label="More" actions={a} />',
      ),
    ).toBe(3);
  });

  test('a file that does not parse throws, naming the file', () => {
    expect(() =>
      scanSource('Broken.tsx', 'export function Broken() { return <div>; }'),
    ).toThrow(/could not parse Broken\.tsx/);
  });

  test('a menu container is where overflow goes and is never a row', () => {
    const rows = scanSource(
      'Menu.tsx',
      `export function Menu() {
        return (
          <div className="menu-surface">
            <button className="menu-row">One</button>
            <button className="menu-row">Two</button>
            <button className="menu-row">Three</button>
          </div>
        );
      }`,
    );
    expect(rows).toEqual([]);
  });

  test('a mapped list has no static cardinality and is not counted', () => {
    expect(
      count(
        `{actions.map((action) => <Button key={action.id}>{action.label}</Button>)}`,
      ),
    ).toBe(0);
  });

  test('one row yields one finding, keyed by component and element', () => {
    const rows = scanSource(
      'Card.tsx',
      `export const Card = memo(() => (
        <section className="card">
          <footer className="card__footer primary">
            {ready ? <><Button>A one</Button><Button>B two</Button><Button>C three</Button></> : null}
          </footer>
        </section>
      ));`,
    );
    expect(rows.map((found) => found.key)).toEqual([
      'Card.tsx :: Card :: footer.card__footer',
    ]);
  });
});

describe('button-cap baseline comparison', () => {
  const rows = (...counts: number[]) =>
    counts.map((value) => ({ key: 'k', count: value }));

  test('rows sharing an identity compare position by position', () => {
    expect(evaluate(rows(4, 3), { k: [4, 3] }).grown).toEqual([]);
    // Fixing the larger of two leaves the smaller under the larger's slot.
    expect(evaluate(rows(3), { k: [4, 3] }).grown).toEqual([]);
    expect(evaluate(rows(4, 4), { k: [4, 3] }).grown).toHaveLength(1);
    expect(evaluate(rows(4, 3, 3), { k: [4, 3] }).grown).toHaveLength(1);
  });

  test('the stored shape round-trips rows that share an identity', () => {
    const stored = flattenBaselineRows({ k: [4, 3], other: [3] });
    expect(stored).toEqual([
      { row: 'k', labelledActions: 4 },
      { row: 'k', labelledActions: 3 },
      { row: 'other', labelledActions: 3 },
    ]);
    expect(groupBaselineEntries(stored)).toEqual({ k: [4, 3], other: [3] });
  });

  test('a recorded reason survives a rewrite of the baseline', () => {
    const previous = [
      { row: 'k', labelledActions: 4, reason: 'stacked list, not a row' },
      { row: 'other', labelledActions: 3 },
    ];
    expect(flattenBaselineRows({ k: [3], other: [3] }, previous)).toEqual([
      { row: 'k', labelledActions: 3, reason: 'stacked list, not a row' },
      { row: 'other', labelledActions: 3 },
    ]);
  });

  test('lowering never raises an entry and never adds one', () => {
    expect(loweredBaseline(rows(5), { k: [4] })).toEqual({ k: [4] });
    expect(loweredBaseline(rows(3), { k: [4, 3] })).toEqual({ k: [3] });
    expect(loweredBaseline(rows(3), {})).toEqual({});
    expect(loweredBaseline([], { k: [4] })).toEqual({});
  });
});
