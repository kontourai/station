import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-api';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';
import { VISUAL_VIEWPORT_BOTTOM_INSET_VAR } from '../hooks/useMobileVisualViewport';
import { DOCK_REGION_IDS } from '../regions/region-model';

/**
 * archive#3902 — the chat dock is rendered by the shell (`App.tsx`), so how
 * much of the bottom of the viewport it owns is a SHELL fact, and every route
 * has to be able to clear it without knowing anything about the dock.
 *
 * The defect this pins: `.content-view` reserved `var(--dock-slot-size)`,
 * which is not the dock's footprint. The collapsed bar's element is
 * `calc(--chat-dock-header-height + --safe-bottom)` tall (`ChatDock.tsx`) and
 * the mobile dock anchors to the VISIBLE viewport, so on a 390x844 phone with
 * a home indicator the rendered dock started 34px above where the shell had
 * stopped reserving — and `--layer-dock` (9200) took every tap in that band.
 * Measured live on `/connections/models/new`: the last provider tile's centre
 * hit-tested to `hr.chat-dock__resize-handle`.
 */

const uiSrc = join(__dirname, '..');
const indexCss = readFileSync(join(uiSrc, 'index.css'), 'utf8');

/** Comments out, so a rule quoted in prose is not read as a declaration. */
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/** The FIRST declaration of a custom property, with its full `calc(...)`. */
function declaration(css: string, name: string): string {
  const source = withoutComments(css);
  const index = source.indexOf(`${name}:`);
  expect(index, `${name} not found`).toBeGreaterThan(-1);
  return source.slice(index, source.indexOf(';', index));
}

function ruleBodies(css: string, selector: string): string[] {
  const source = withoutComments(css);
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const index = source.indexOf(`${selector} {`, from);
    if (index === -1) return bodies;
    const end = source.indexOf('}', index);
    bodies.push(source.slice(index, end));
    from = end;
  }
}

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '__tests__') return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '__tests__') return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

const makeTempDir = trackTempDirs();
const clearanceVariables = [
  ...DOCK_REGION_IDS.map((region) => `--region-${region}-size`),
  '--dock-slot-size',
];
const mutationMethods = new Set(['setProperty', 'removeProperty']);

function possibleNames(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  const type = checker.getTypeAtLocation(expression);
  const names = (type.isUnion() ? type.types : [type]).flatMap((part) =>
    part.isStringLiteral() ? [part.value] : [],
  );
  const found = checker.getSymbolAtLocation(expression);
  const symbol =
    found && found.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(found)
      : found;
  if (!symbol || seen.has(symbol)) return names;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  )
    names.push(...possibleNames(declaration.initializer, checker, seen));
  return names;
}

function clearanceWriters(root: string, files: string[]) {
  const program = ts.createProgram(files, {
    types: [],
    lib: ['lib.es2022.d.ts'],
    noResolve: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
  });
  const checker = program.getTypeChecker();
  const writers = new Map(
    clearanceVariables.map((name) => [name, new Set<string>()]),
  );
  for (const file of program.getSourceFiles()) {
    const path = relative(root, file.fileName).replaceAll('\\', '/');
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        const method = ts.isPropertyAccessExpression(target)
          ? target.name.text
          : ts.isElementAccessExpression(target) &&
              ts.isStringLiteralLike(target.argumentExpression)
            ? target.argumentExpression.text
            : undefined;
        const name = node.arguments[0];
        if (method && mutationMethods.has(method) && name) {
          for (const variable of possibleNames(name, checker))
            writers.get(variable)?.add(path);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return Object.fromEntries(
    [...writers].map(([name, paths]) => [name, [...paths].sort()]),
  );
}

describe('the dock clearance is one derivation (station#3902)', () => {
  test('it sums the published height, the safe area and the visible-viewport inset', () => {
    const value = declaration(indexCss, '--dock-bottom-clearance');
    expect(value).toContain('--dock-slot-size');
    expect(value).toContain('--safe-bottom');
    expect(value).toContain(VISUAL_VIEWPORT_BOTTOM_INSET_VAR);
  });

  test("the shell's route outlet reserves it, so every route clears the dock", () => {
    // The BASE rule. The compound `.app__main:has(> [data-region]) > …`
    // rules deliberately zero it: in those modes the dock is a real grid row
    // beside the content rather than fixed over it.
    const bodies = ruleBodies(indexCss, '\n.content-view');
    expect(bodies.length, '.content-view base rule not found').toBe(1);
    expect(bodies[0]).toContain('padding-bottom: var(--dock-bottom-clearance)');
  });

  /**
   * The one-derivation guard, and the reason this file scans the tree rather
   * than naming the files it happened to find: a page that reserves its own
   * bottom space from `--dock-slot-size` is re-deriving the shell's fact
   * from a strictly smaller number, which is how five stylesheets ended up
   * with five different answers. Anchoring a FIXED element above the dock
   * (`bottom:`) is a different job and is deliberately not covered.
   */
  test('no stylesheet reserves body space from --dock-slot-size directly', () => {
    const offenders: string[] = [];
    for (const path of stylesheets(uiSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(
        /(padding-bottom|margin-bottom)\s*:[^;]*/g,
      )) {
        if (match[0].includes('--dock-slot-size')) {
          offenders.push(`${path.slice(uiSrc.length + 1)}: ${match[0].trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  test('the reducer alone writes or clears each active shell-clearance variable', () => {
    expect(clearanceWriters(uiSrc, sourceFiles(uiSrc))).toEqual(
      Object.fromEntries(
        clearanceVariables.map((name) => [
          name,
          ['regions/region-clearance.ts'],
        ]),
      ),
    );
  });

  test('detects an imported variable at the actual mutation and ignores reads', () => {
    const root = makeTempDir('station-clearance-writers-');
    const fixtures = {
      'variables.ts':
        "export const left: string = '--region-left-size'; export const right = '--region-right-size';",
      'writer.ts':
        "import { left as variable, right } from './variables'; element.style.setProperty(variable, '2px'); const style = element.style; style['removeProperty'](right);",
      'reader.ts':
        "import { left } from './variables'; element.style.getPropertyValue(left); element.style.setProperty('--another-property', '2px');",
    };
    const files = Object.entries(fixtures).map(([path, text]) => {
      const file = join(root, path);
      writeFileSync(file, text);
      return file;
    });
    expect(clearanceWriters(root, files)).toEqual({
      '--region-left-size': ['writer.ts'],
      '--region-right-size': ['writer.ts'],
      '--region-bottom-size': [],
      '--dock-slot-size': [],
    });
  });
});
