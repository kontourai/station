import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';
import { describe, expect, test } from 'vitest';

/**
 * archive#3227 A1 — the structural half of the fix, carried forward to the
 * one-vocabulary round (2026-10, C1).
 *
 * `session-state-word-consistency.test.ts` proves the ladder cannot produce
 * a contradiction. It cannot prove that a FUTURE render site goes through
 * it: a surface that turns `session.lifecycleState` or the fold's
 * `orchestrationLifecycleLabel` into a word of its own reintroduces #1069,
 * #1783 and the audit's "Review pending"/"Completed"/"Ready" second
 * vocabulary at a place no lane-walk test looks. Four surfaces did exactly
 * that, and the Activity list did it again through its own refinement
 * table.
 *
 * So the rule is enforced at the import: a rendering surface that names a
 * session's state calls the ladder (`workStatus`, or `sessionWorkStatus`
 * for a bare summary), directly or through the observation adapter. The
 * adapter must itself call the ladder; import aliases do not change that
 * route. The fold's label is an INPUT to the ladder, read by
 * the few modules that classify, and nothing else prints it.
 *
 * Deliberately a source scan and not a lint rule: it needs no new tooling,
 * and the failure message can say what to call instead.
 */

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OBSERVATION_ADAPTER = join('views', 'home', 'useObservedWorkStatus.ts');

/**
 * The modules that may read the fold's label directly: the ladder and its
 * facts, the lane partitions, the item builders, the tone and glyph tables
 * keyed by it, and the few predicates (showEvidence, showDiscard, Stop
 * gating) that branch on a state without printing it.
 */
const LABEL_READERS = new Set([
  join('utils', 'session-state.ts'),
  join('views', 'home', 'work-status.ts'),
  join('views', 'home', 'work-facts.ts'),
  join('views', 'home', 'home-view-model.ts'),
  join('views', 'home', 'home-lane-model.ts'),
  join('views', 'sessions', 'sessions-lane-model.ts'),
  join('views', 'project-page', 'project-live-work-model.ts'),
  join('components', 'kontour', 'station-tones.ts'),
  join('components', 'status', 'StatusGlyph.tsx'),
  join('contexts', 'open-chats-store.ts'),
]);

/** Surfaces that print a session's state, each through the ladder. */
const GUARDED_SURFACES = [
  join('views', 'SessionsView.tsx'),
  join('views', 'project-page', 'ProjectLiveWorkSection.tsx'),
  join('components', 'session-detail', 'SessionDetailHeader.tsx'),
  join('components', 'chat-dock', 'ChatDockInboxRows.tsx'),
  join('components', 'chat-dock', 'ChatInboxHoverCard.tsx'),
];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, found);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

/**
 * Comments are stripped and the whole remaining source is searched, rather
 * than matching an import line's shape: a single-specifier import fits on
 * one line and slipped past the first version's multi-line pattern.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function callsStatusProducer(file: string, allowAdapters = true): boolean {
  const producers = new Map([
    [join(SRC_ROOT, 'views', 'home', 'work-status'), 'workStatus'],
  ]);
  if (allowAdapters) {
    producers.set(
      join(SRC_ROOT, 'views', 'sessions', 'sessions-lane-model'),
      'sessionWorkStatus',
    );
    producers.set(
      join(SRC_ROOT, 'views', 'home', 'useObservedWorkStatus'),
      'useObservedWorkStatus',
    );
  }
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const importedCalls = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const producer = producers.get(
      resolve(dirname(file), statement.moduleSpecifier.text),
    );
    const bindings = statement.importClause?.namedBindings;
    if (!producer || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === producer) {
        importedCalls.add(binding.name.text);
      }
    }
  }
  let called = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      importedCalls.has(node.expression.text)
    )
      called = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return called;
}

/**
 * `Component.prop` pairs whose value the component only classifies and never
 * prints. SessionPlanProgress hands `lifecycleLabel` to
 * sessionPlanProgressRead, which picks skip/live/settled for the plan read
 * (#4864). Add a pair only after reading the component's whole path.
 */
const CLASSIFYING_PROPS = new Set(['SessionPlanProgress.lifecycleLabel']);

/**
 * Whether `node` hands its value, or something computed from it, on to its
 * parent expression: `x.toLowerCase()`, `String(x)`, `x + 'y'`, `c ? x : y`,
 * `(x)`, `x as T`, `x!`. The walk stops at anything else (a statement, an
 * arrow function, a JSX expression, a template span).
 */
function wrapsValue(parent: ts.Node): boolean {
  return (
    ts.isCallExpression(parent) ||
    ts.isPropertyAccessExpression(parent) ||
    ts.isElementAccessExpression(parent) ||
    ts.isBinaryExpression(parent) ||
    ts.isConditionalExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent)
  );
}

/**
 * Where a source puts the fold label in a printing position: a JSX child, a
 * template literal, or a JSX attribute other than a classifying prop (a
 * `title` or `aria-label` prints it as surely as a child does). The walk
 * goes up through wrapping expressions first, so a label lower-cased,
 * stringified or concatenated into one of those positions is reported too.
 * A predicate computed outside JSX braces and templates is not reported;
 * one written inside them is, as the original `{label(` scan did.
 */
function labelPrintSites(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'orchestrationLifecycleLabel'
    ) {
      let value: ts.Node = node;
      while (wrapsValue(value.parent)) value = value.parent;
      const holder = value.parent;
      if (ts.isTemplateSpan(holder)) sites.push('template');
      else if (ts.isJsxExpression(holder)) {
        const attribute = holder.parent;
        if (!ts.isJsxAttribute(attribute)) sites.push('JSX text');
        else {
          const element = attribute.parent.parent;
          const prop = `${element.tagName.getText(source)}.${attribute.name.getText(source)}`;
          if (!CLASSIFYING_PROPS.has(prop)) sites.push(`${prop} attribute`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe('the fold-label print scan', () => {
  test('lets a classifying prop and a predicate read the label', () => {
    expect(
      labelPrintSites(
        'fixture.tsx',
        `const row = orchestrationLifecycleLabel(s) === 'Draft' ? null : (
          <SessionPlanProgress sessionId="a" lifecycleLabel={orchestrationLifecycleLabel(s)} />
        );`,
      ),
    ).toEqual([]);
  });

  test('reports the label printed as JSX text', () => {
    expect(
      labelPrintSites(
        'fixture.tsx',
        'const row = <span>{orchestrationLifecycleLabel(s)}</span>;',
      ),
    ).toEqual(['JSX text']);
  });

  test('reports the label printed through a template literal', () => {
    expect(
      labelPrintSites(
        'fixture.ts',
        `const word = \`\${orchestrationLifecycleLabel(s)} now\`;`,
      ),
    ).toEqual(['template']);
  });

  test('reports the label printed through a text attribute', () => {
    expect(
      labelPrintSites(
        'fixture.tsx',
        'const row = <span title={orchestrationLifecycleLabel(s)} />;',
      ),
    ).toEqual(['span.title attribute']);
  });

  test.each([
    ['lower-cased', '{orchestrationLifecycleLabel(s).toLowerCase()}'],
    ['stringified', '{String(orchestrationLifecycleLabel(s))}'],
    ['concatenated', "{orchestrationLifecycleLabel(s) + ' now'}"],
    ['chosen by a ternary', "{live ? orchestrationLifecycleLabel(s) : ''}"],
  ])('reports the label %s into JSX text', (_shape, child) => {
    expect(
      labelPrintSites('fixture.tsx', `const row = <span>${child}</span>;`),
    ).toEqual(['JSX text']);
  });

  test('reports the label wrapped inside a template literal', () => {
    expect(
      labelPrintSites(
        'fixture.ts',
        `const word = \`\${orchestrationLifecycleLabel(s).toLowerCase()} now\`;`,
      ),
    ).toEqual(['template']);
  });

  test('exempts only the named component and prop', () => {
    expect(
      labelPrintSites(
        'fixture.tsx',
        `const rows = <>
          <OtherComponent lifecycleLabel={orchestrationLifecycleLabel(s)} />
          <SessionPlanProgress title={orchestrationLifecycleLabel(s)} />
        </>;`,
      ),
    ).toEqual([
      'OtherComponent.lifecycleLabel attribute',
      'SessionPlanProgress.title attribute',
    ]);
  });
});

describe('a session state is worded by the ladder alone', () => {
  const files = sourceFiles(SRC_ROOT);

  test('no retired word derivation exists anywhere', () => {
    const offenders = files
      .filter((file) =>
        /\b(sessionStatusWord|sessionLifecycleLabel|lifecycleLabelText|SESSION_STATE_REFINEMENTS|activityRunningDetail)\b/.test(
          withoutComments(readFileSync(file, 'utf8')),
        ),
      )
      .map((file) => file.slice(SRC_ROOT.length));
    expect(
      offenders,
      `${offenders.join(', ')} names a retired status-word derivation. The status ladder (workStatus / sessionWorkStatus) is the only source of status words.`,
    ).toEqual([]);
  });

  test('every guarded surface calls a canonical status producer', () => {
    for (const guarded of GUARDED_SURFACES) {
      expect(
        callsStatusProducer(join(SRC_ROOT, guarded)),
        `${guarded} no longer reads the status ladder or its adapter`,
      ).toBe(true);
    }
    expect(
      callsStatusProducer(join(SRC_ROOT, OBSERVATION_ADAPTER), false),
      'the observation adapter must delegate status wording to workStatus',
    ).toBe(true);
  });

  test('outside the classifiers, nothing turns the fold label into text', () => {
    // The fold label is a classification input; printing it (or switching
    // on it to pick a word) is a second vocabulary. A guarded surface may
    // still branch on it for a predicate or hand it to a classifying prop,
    // so this checks the shapes that print it: JSX text, a template, or a
    // text-bearing attribute.
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.slice(SRC_ROOT.length);
      if (LABEL_READERS.has(name)) continue;
      const sites = labelPrintSites(file, readFileSync(file, 'utf8'));
      if (sites.length) offenders.push(`${name} (${sites.join(', ')})`);
    }
    expect(offenders).toEqual([]);
  });

  test('the scan actually reaches the rendering surfaces it is guarding', () => {
    const scanned = files.map((file) => file.slice(SRC_ROOT.length));
    for (const guarded of GUARDED_SURFACES) expect(scanned).toContain(guarded);
    expect(scanned).toContain(OBSERVATION_ADAPTER);
    expect(scanned.length).toBeGreaterThan(300);
  });
});
