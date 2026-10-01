#!/usr/bin/env node
// Button cap (#3045, epic #3039): no header, toolbar or action row shows more
// than TWO labelled actions. Further actions go into an overflow menu;
// icon-only buttons that carry an accessible name do not count.
//
// ## What this proves, and what it cannot
//
// This is a structural scan of JSX source, parsed with the TypeScript compiler
// the repo already depends on (no new dependency). It proves ONE structural
// rule: no JSX element has more than two labelled `<Button>`/`<button>`
// actions among its direct children, beyond what the checked-in baseline
// records. It does NOT see a rendered row. Specifically:
//
//   - It cannot see layout. Three labelled buttons that are siblings in JSX
//     are counted as one row whether CSS lays them out in a line, a wrap, or
//     a column. Containers that are plainly not rows are excluded by role or
//     class (NON_ROW_ROLES, NON_ROW_CLASS_PATTERN): a menu is where the
//     overflow GOES, so its rows are never counted.
//   - It cannot see across components. A header that renders
//     `<PrimaryActions />` beside `<SecondaryActions />` is two JSX
//     containers; the scan counts each on its own. A row assembled from an
//     array (`actions.map(...)`) has no static cardinality and counts zero.
//   - It cannot see responsive collapse. "Headers collapse their controls
//     into the overflow as width shrinks" is a runtime claim; this gate says
//     nothing about it.
//   - Mutually exclusive branches count as the larger arm, not the sum:
//     `{editing ? <Save/> : <Edit/>}` is one action. `cond && <X/>` counts X,
//     except that `&&` guards the TEXT proves exclusive are not summed:
//     `x && <A/>` beside `!x && <B/>`, or `kind === 'a' && <A/>` beside
//     `kind === 'b' && <B/>`. Exclusivity that needs reasoning about values
//     (two different booleans that never coincide) is not seen and overcounts.
//   - A button holding several text blocks (title over description) is a
//     card, not a labelled action.
//   - A control that picks a value rather than performing an action — a tab,
//     a menu item, an option, a pressed/selected/checked toggle — is a choice,
//     not an action, and is not counted (CHOICE_ROLES, CHOICE_STATE_ATTRS).
//   - Only `Button` and `button` are actions. An anchor styled as a button is
//     not seen. An `ActionRow` counts as its filled `primary` and `secondary`
//     slots, so a labelled button placed beside one is still counted with it.
//
// So a green result means "no NEW statically visible row of three labelled
// buttons", not "every row on screen shows at most two". The rendered image
// remains the evidence for the latter.
//
// ## Identity and growth
//
// A row is identified by `file :: component :: element` — the enclosing named
// function and the container's tag plus its first static class (or
// `data-testid`). Never a line number: a baseline keyed to lines fails
// whoever edits the file next. Rows sharing one identity are recorded as a
// descending list of counts and compared position by position, so there is no
// ordinal to renumber when one of them is fixed.
//
// The gate fails only on GROWTH: a violating row the baseline does not
// record, or more labelled actions in a recorded one. A recorded row that
// shrank or disappeared does not fail (under a merge queue an exact-value
// ratchet fails whoever gates next); it prints a note, and
// `node scripts/button-cap-ratchet.mjs --record` lowers the baseline.
// `--record` never raises an entry and never adds one — the baseline only
// goes down. A deliberate exception is a hand edit to the JSON, which is
// what makes it visible in review.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import {
  assertScopeIsHonest,
  describeScope,
  listTrackedFilesUnder,
  UI_SCAN_EXTENSIONS,
  UI_SCAN_ROOTS,
} from './lib/gate-scope.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/** The rule. Not read from the baseline, so a JSON edit cannot move it. */
export const LABELLED_ACTION_CAP = 2;

const BASELINE_PATH = 'scripts/button-cap-baseline.json';

const PINNED_SCOPE_INVENTORY = [
  'src-ui/src/App.tsx',
  'src-ui/src/components/Button.tsx',
  'src-ui/src/components/chat-dock/ChatDockHeader.tsx',
];

const ACTION_TAGS = new Set(['Button', 'button']);

/** A control with one of these roles picks a value; it is not an action. */
const CHOICE_ROLES = new Set([
  'tab',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'radio',
  'switch',
  'checkbox',
  'treeitem',
]);

/** Toggle/selection state marks a choice control (segmented, filter chip). */
const CHOICE_STATE_ATTRS = ['aria-pressed', 'aria-selected', 'aria-checked'];

/** Containers that are lists of choices, not action rows. */
const NON_ROW_ROLES = new Set([
  'menu',
  'listbox',
  'tablist',
  'radiogroup',
  'tree',
]);

/**
 * Class tokens that mark a menu-like surface: the place overflow actions are
 * moved TO. Matched per token, anchored on a word boundary inside the token
 * (`menu-surface`, `pane-commands__menu`), never as a bare substring.
 */
const NON_ROW_CLASS_PATTERN =
  /(?:^|[-_])(?:menu|popover|dropdown|listbox|palette)(?:$|[-_])/;

const ICON_NAME_PATTERN = /(?:icon|glyph|spinner|chevron|caret|avatar|logo)/i;
const HIDDEN_CLASS_PATTERN = /(?:^|\s)(?:sr-only|visually-hidden)(?:\s|$)/;
const ACCESSIBLE_NAME_ATTRS = ['aria-label', 'aria-labelledby', 'title'];

function isTestFile(file) {
  return (
    file.includes('__tests__/') ||
    file.endsWith('.test.tsx') ||
    file.endsWith('.stories.tsx')
  );
}

function tagNameOf(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

function attributesOf(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.attributes.properties;
}

function findAttribute(node, name) {
  return attributesOf(node).find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function hasSpread(node) {
  return attributesOf(node).some((property) =>
    ts.isJsxSpreadAttribute(property),
  );
}

/** First string literal reachable in an attribute's value, or undefined. */
function staticAttributeText(node, name) {
  const attribute = findAttribute(node, name);
  if (!attribute?.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }
  let found;
  const visit = (child) => {
    if (found !== undefined) return;
    if (ts.isStringLiteralLike(child)) found = child.text;
    else if (ts.isTemplateExpression(child)) found = child.head.text;
    else ts.forEachChild(child, visit);
  };
  visit(attribute.initializer);
  return found;
}

function isJsxNode(node) {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  );
}

function unwrap(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Does a button show text?
// ---------------------------------------------------------------------------

/**
 * A label is a word: two letters in a row. `+`, `−`, `×`, `⋯` and `A` are
 * glyphs drawn with text, and a button showing only one of those is an icon
 * button (it still needs an accessible name to earn the exemption).
 */
function isWordText(text) {
  return /\p{L}{2}/u.test(text);
}

function expressionShowsText(expression) {
  const node = unwrap(expression);
  if (!node) return false;
  if (ts.isStringLiteralLike(node)) return isWordText(node.text);
  if (ts.isTemplateExpression(node)) return true;
  if (ts.isConditionalExpression(node)) {
    return (
      expressionShowsText(node.whenTrue) || expressionShowsText(node.whenFalse)
    );
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return expressionShowsText(node.right);
    }
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return expressionShowsText(node.left) || expressionShowsText(node.right);
    }
    return true;
  }
  if (isJsxNode(node)) return jsxShowsText(node);
  if (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  ) {
    return false;
  }
  // `{label}`, `{t('save')}`, `{props.children}`: a computed value. Treated
  // as text unless its own name says it is an icon (`{icon}`, `{glyph}`).
  return !ICON_NAME_PATTERN.test(node.getText());
}

function childrenShowText(children) {
  return children.some((child) => {
    if (ts.isJsxText(child)) return isWordText(child.text);
    if (ts.isJsxExpression(child)) {
      return child.expression ? expressionShowsText(child.expression) : false;
    }
    return jsxShowsText(child);
  });
}

function jsxShowsText(node) {
  if (ts.isJsxFragment(node)) return childrenShowText(node.children);
  const tag = tagNameOf(node);
  if (tag === 'svg' || tag === 'img' || ICON_NAME_PATTERN.test(tag)) {
    return false;
  }
  if (HIDDEN_CLASS_PATTERN.test(staticAttributeText(node, 'className') ?? '')) {
    return false;
  }
  if (findAttribute(node, 'aria-hidden')) return false;
  // A self-closing element inside a button renders no statically visible
  // text; in this codebase that position holds glyphs.
  if (ts.isJsxSelfClosingElement(node)) return false;
  return childrenShowText(node.children);
}

/**
 * `labelled` — shows text; `icon` — shows no text and carries an accessible
 * name; `choice` — a tab/menu item/toggle, not an action; `menu-trigger` —
 * opens a menu (`aria-haspopup`); `card` — a title-and-description tile;
 * `undefined` — not an action element at all.
 *
 * An icon-only button WITHOUT an accessible name earns no exemption and is
 * counted as labelled: the allowance is for a named icon, not for any button
 * that happens to have no text.
 */
export function classifyAction(node) {
  if (ts.isJsxFragment(node)) return undefined;
  if (!ACTION_TAGS.has(tagNameOf(node))) return undefined;
  const role = staticAttributeText(node, 'role');
  if (role && CHOICE_ROLES.has(role)) return 'choice';
  if (CHOICE_STATE_ATTRS.some((name) => findAttribute(node, name))) {
    return 'choice';
  }
  // The trigger of a menu is where the row's overflow lives; labelled or
  // not, it is the remedy and never counts against the row.
  if (findAttribute(node, 'aria-haspopup')) return 'menu-trigger';
  const children = ts.isJsxElement(node) ? node.children : [];
  // A button built from several text blocks — a title over a description —
  // is a card someone picks, not a labelled action in a row.
  const textBlocks = children.filter(
    (child) =>
      (ts.isJsxElement(child) || ts.isJsxFragment(child)) &&
      jsxShowsText(child),
  );
  if (textBlocks.length > 1) return 'card';
  if (childrenShowText(children)) return 'labelled';
  const named =
    hasSpread(node) ||
    ACCESSIBLE_NAME_ATTRS.some((name) => findAttribute(node, name));
  return named ? 'icon' : 'labelled';
}

// ---------------------------------------------------------------------------
// Counting a container's labelled actions
// ---------------------------------------------------------------------------

function meaningfulChildren(node) {
  return node.children.filter(
    (child) => !(ts.isJsxText(child) && child.text.trim().length === 0),
  );
}

// A container's children are flattened into a sequence of tokens: a string
// for each labelled action (its label), and BREAK for any other element that
// has content of its own. A row is an unbroken RUN of labelled actions —
// three buttons separated by paragraphs, labelled fields or sections in a
// long form are three places, not a row. Text, icon buttons, choices, menu
// triggers and self-closing elements neither count nor break.
const BREAK = Symbol('break');

/** `a && b && <X/>` guards X with `a` and `b`, compared as normalised text. */
function conjunctsOf(expression) {
  const node = unwrap(expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...conjunctsOf(node.left), ...conjunctsOf(node.right)];
  }
  return [node.getText().replaceAll(/\s+/g, ' ')];
}

const COMPARES_LITERAL_PATTERN =
  /^(.+?) ?([!=]==) ?('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)$/;

function negationOf(guard) {
  return guard.startsWith('!') ? guard.slice(1) : `!${guard}`;
}

/**
 * Two guards that cannot both hold: `x` against `!x`, one expression compared
 * with two different literals (`kind === 'a'` / `kind === 'b'`), or with the
 * same literal both ways (`mode === 'a'` / `mode !== 'a'`).
 * Only what is provable from the text; anything else is assumed compatible,
 * which overcounts rather than hides a row.
 */
function guardsExclude(first, second) {
  if (first === negationOf(second) || `!(${first})` === second) return true;
  if (`!(${second})` === first) return true;
  const left = COMPARES_LITERAL_PATTERN.exec(first);
  const right = COMPARES_LITERAL_PATTERN.exec(second);
  if (!left || !right || left[1] !== right[1]) return false;
  const sameLiteral = left[3] === right[3];
  // `=== 'a'` with `=== 'b'`, or `=== 'a'` with `!== 'a'`.
  if (left[2] === '===' && right[2] === '===') return !sameLiteral;
  return left[2] !== right[2] && sameLiteral;
}

function tokensExclude(first, second) {
  return first.guards.some((guard) =>
    second.guards.some((other) => guardsExclude(guard, other)),
  );
}

/** The largest set of actions in `run` that can all be on screen at once. */
function largestCompatible(run) {
  if (run.length > 12) return run; // never seen; do not search 2^n for it
  let best = [];
  const extend = (index, chosen) => {
    if (chosen.length + (run.length - index) <= best.length) return;
    if (index === run.length) {
      best = chosen;
      return;
    }
    const candidate = run[index];
    if (!chosen.some((token) => tokensExclude(token, candidate))) {
      extend(index + 1, [...chosen, candidate]);
    }
    extend(index + 1, chosen);
  };
  extend(0, []);
  return best;
}

function longestRun(tokens) {
  let best = [];
  let run = [];
  const settle = () => {
    const visible = largestCompatible(run);
    if (visible.length > best.length) best = visible;
  };
  for (const token of tokens) {
    if (token === BREAK) {
      settle();
      run = [];
    } else {
      run.push(token);
    }
  }
  settle();
  return best;
}

function labelOf(node) {
  const text = node.getText().replaceAll(/<[^>]*>|[{}]/g, ' ');
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 40);
}

function tokensInExpression(expression, guards) {
  const node = unwrap(expression);
  if (!node) return [];
  if (isJsxNode(node)) return tokensInChild(node, guards);
  if (ts.isConditionalExpression(node)) {
    // Mutually exclusive arms: the arm with the longer run stands for both.
    const whenTrue = tokensInExpression(node.whenTrue, guards);
    const whenFalse = tokensInExpression(node.whenFalse, guards);
    return longestRun(whenFalse).length > longestRun(whenTrue).length
      ? whenFalse
      : whenTrue;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return tokensInExpression(node.right, [
        ...guards,
        ...conjunctsOf(node.left),
      ]);
    }
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const left = tokensInExpression(node.left, guards);
      const right = tokensInExpression(node.right, guards);
      return longestRun(right).length > longestRun(left).length ? right : left;
    }
  }
  // `.map(...)`, identifiers, calls: no static cardinality.
  return [];
}

function tokensInChild(child, guards = []) {
  if (ts.isJsxText(child)) return [];
  if (ts.isJsxExpression(child)) {
    return child.expression ? tokensInExpression(child.expression, guards) : [];
  }
  if (ts.isJsxFragment(child)) {
    return child.children.flatMap((inner) => tokensInChild(inner, guards));
  }
  // `ActionRow` renders its `primary` and `secondary` props as labelled
  // buttons, so it stands in this run as that many — otherwise a button added
  // BESIDE an ActionRow would be the third label on screen and the first one
  // the scan saw.
  if (!ts.isJsxFragment(child) && tagNameOf(child) === 'ActionRow') {
    return ['primary', 'secondary']
      .filter((slot) => findAttribute(child, slot))
      .map((slot) => ({ guards, label: `ActionRow ${slot}` }));
  }
  const kind = classifyAction(child);
  if (kind !== undefined) {
    if (kind !== 'labelled') return [];
    return [
      {
        guards,
        label: ts.isJsxElement(child)
          ? child.children.map(labelOf).join(' ').trim() || '(unnamed icon)'
          : '(unnamed icon)',
      },
    ];
  }
  // A wrapper around exactly one button (`<Tooltip><Button/></Tooltip>`) is
  // transparent: the button is still a member of this row. Any other element
  // is its own container, scanned as one, and breaks the run here.
  if (ts.isJsxElement(child) && !isNonRowContainer(child)) {
    const inner = meaningfulChildren(child);
    if (
      inner.length === 1 &&
      (ts.isJsxElement(inner[0]) || ts.isJsxSelfClosingElement(inner[0]))
    ) {
      const innerIsWrapper =
        ts.isJsxElement(inner[0]) && meaningfulChildren(inner[0]).length === 1;
      if (ACTION_TAGS.has(tagNameOf(inner[0])) || innerIsWrapper) {
        return tokensInChild(inner[0], guards);
      }
    }
  }
  // A self-closing element is not content between two rows: it is a spacer
  // (`<div className="spacer" />`), a field or badge that sits IN the row, a
  // modal that renders elsewhere — or the row's own overflow menu component,
  // which must never be what hides a third labelled button beside it.
  if (ts.isJsxSelfClosingElement(child)) return [];
  return [BREAK];
}

function isNonRowContainer(node) {
  if (ts.isJsxFragment(node)) return false;
  const role = staticAttributeText(node, 'role');
  if (role && NON_ROW_ROLES.has(role)) return true;
  const className = staticAttributeText(node, 'className') ?? '';
  return className
    .split(/\s+/)
    .some((token) => NON_ROW_CLASS_PATTERN.test(token));
}

/**
 * One row must produce one finding. A fragment flattened into its JSX parent
 * is already counted as part of that parent, which has the useful class.
 */
function isCountedByParent(node) {
  if (!ts.isJsxFragment(node)) return false;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isBinaryExpression(parent))
  ) {
    parent = parent.parent;
  }
  if (parent && ts.isJsxExpression(parent)) parent = parent.parent;
  return Boolean(
    parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent)),
  );
}

// ---------------------------------------------------------------------------
// Row identity
// ---------------------------------------------------------------------------

function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Nearest enclosing NAMED function: a declaration, or a const-bound one. */
function enclosingComponentName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
    if (isFunctionLike(current)) {
      // `const X = () => …` and `const X = memo(forwardRef(() => …))`.
      let owner = current.parent;
      while (owner && ts.isCallExpression(owner)) owner = owner.parent;
      if (
        owner &&
        ts.isVariableDeclaration(owner) &&
        ts.isIdentifier(owner.name)
      ) {
        return owner.name.text;
      }
    }
  }
  return '<module>';
}

function elementLabel(node) {
  if (ts.isJsxFragment(node)) return '<>';
  const tag = tagNameOf(node);
  const className = staticAttributeText(node, 'className')
    ?.trim()
    .split(/\s+/)[0];
  if (className) return `${tag}.${className}`;
  const testId = staticAttributeText(node, 'data-testid');
  return testId ? `${tag}[${testId}]` : tag;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Every container in `content` whose labelled-action count exceeds the cap,
 * as `{ key, file, component, element, count, labels, line }`. `line` and
 * `labels` are for a human to navigate with; neither is part of the identity.
 */
export function scanSource(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const rows = [];
  const visit = (node) => {
    if (
      (ts.isJsxElement(node) || ts.isJsxFragment(node)) &&
      !isNonRowContainer(node) &&
      !isCountedByParent(node) &&
      classifyAction(node) === undefined
    ) {
      const labels = longestRun(
        node.children.flatMap((child) => tokensInChild(child)),
      ).map((token) => token.label);
      const count = labels.length;
      if (count > LABELLED_ACTION_CAP) {
        const component = enclosingComponentName(node);
        const element = elementLabel(node);
        rows.push({
          key: `${file} :: ${component} :: ${element}`,
          file,
          component,
          element,
          count,
          labels,
          children: meaningfulChildren(node).length,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rows;
}

export function scanFiles(files, readFile) {
  return files
    .filter((file) => !isTestFile(file))
    .flatMap((file) => scanSource(file, readFile(file)));
}

/** `{ key: [counts, descending] }` — the shape the baseline stores. */
export function groupRows(rows) {
  const grouped = {};
  for (const row of rows) {
    grouped[row.key] ??= [];
    grouped[row.key].push(row.count);
  }
  for (const counts of Object.values(grouped)) counts.sort((a, b) => b - a);
  return Object.fromEntries(
    Object.entries(grouped).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Compares the live rows with the baseline, position by position within each
 * identity. Growth is a live count with no recorded partner, or one larger
 * than its partner. Shrink is the reverse and is reported, not failed.
 */
export function evaluate(rows, baselineRows) {
  const current = groupRows(rows);
  const grown = [];
  const shrunk = [];
  for (const [key, counts] of Object.entries(current)) {
    const recorded = baselineRows[key] ?? [];
    counts.forEach((count, index) => {
      const allowed = recorded[index];
      if (allowed === undefined || count > allowed) {
        grown.push({ key, count, allowed });
      } else if (count < allowed) {
        shrunk.push({ key, count, allowed });
      }
    });
    for (const allowed of recorded.slice(counts.length)) {
      shrunk.push({ key, count: undefined, allowed });
    }
  }
  for (const [key, recorded] of Object.entries(baselineRows)) {
    if (current[key]) continue;
    for (const allowed of recorded) {
      shrunk.push({ key, count: undefined, allowed });
    }
  }
  return { current, grown, shrunk };
}

/**
 * The baseline after a `--record`: each recorded entry lowered to the live
 * count, fixed entries dropped. Never raises and never adds — growth is not
 * something a flag can accept.
 */
export function loweredBaseline(rows, baselineRows) {
  const current = groupRows(rows);
  const lowered = {};
  for (const [key, recorded] of Object.entries(baselineRows)) {
    const counts = (current[key] ?? [])
      .slice(0, recorded.length)
      .map((count, index) => Math.min(count, recorded[index]));
    if (counts.length > 0) lowered[key] = counts;
  }
  return lowered;
}

/**
 * The baseline file stores one `{ row, labelledActions, reason? }` object per
 * recorded row — rows sharing an identity are simply repeated — so the file is
 * plain objects and numbers that `JSON.stringify` and the formatter print the
 * same way. These two convert to and from the grouped shape the comparison
 * uses.
 *
 * `reason` is for a row that is recorded because the scan is WRONG about it
 * (a stacked list it reads as a row), as opposed to debt waiting to be folded.
 * It is kept per identity across `--record`.
 */
export function groupBaselineEntries(entries) {
  return groupRows(
    entries.map((entry) => ({ key: entry.row, count: entry.labelledActions })),
  );
}

export function flattenBaselineRows(grouped, previousEntries = []) {
  const reasons = new Map(
    previousEntries
      .filter((entry) => entry.reason)
      .map((entry) => [entry.row, entry.reason]),
  );
  return Object.entries(grouped).flatMap(([row, counts]) =>
    counts.map((labelledActions) => ({
      row,
      labelledActions,
      ...(reasons.has(row) ? { reason: reasons.get(row) } : {}),
    })),
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function walkTsx(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx')) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

const REMEDY = [
  '',
  `A header, toolbar or action row shows at most ${LABELLED_ACTION_CAP} labelled actions (#3045).`,
  'Keep the two that matter most as labelled buttons and move the rest into',
  'an overflow menu: pass them as `actions` to `ChatDockHeaderMoreMenu`',
  '(src-ui/src/components/chat-dock/ChatDockHeaderMoreMenu.tsx) with a',
  '`label` naming the row, as src-ui/src/views/SkillsView.tsx does. An',
  'icon-only button with an `aria-label` does not count. Do not add the row to',
  'scripts/button-cap-baseline.json: the baseline records what existed when',
  'the rule arrived and only goes down.',
  '',
].join('\n');

function main() {
  // `--root` scans a directory tree directly (fixtures, a scratch copy) and
  // keys rows relative to it. Without it the gate scans the shared UI scope
  // from git and proves the enumeration covers that scope before counting.
  const root = option('root');
  const baselinePath = option('baseline') ?? BASELINE_PATH;

  let files;
  let readFile;
  let scope;
  if (root) {
    const absolute = walkTsx(root);
    const toKey = (path) => relative(root, path).split(sep).join('/');
    const byKey = new Map(absolute.map((path) => [toKey(path), path]));
    files = [...byKey.keys()];
    readFile = (file) => readFileSync(byKey.get(file), 'utf8');
    scope = `${files.length} .tsx file(s) under ${root}`;
    if (files.length === 0) {
      console.error(`FAIL: button-cap ratchet found no .tsx files in ${root}.`);
      process.exit(1);
    }
  } else {
    files = UI_SCAN_ROOTS.flatMap((scanRoot) =>
      listTrackedFilesUnder(scanRoot, UI_SCAN_EXTENSIONS),
    );
    readFile = (file) => readFileSync(file, 'utf8');
    assertScopeIsHonest({
      gate: 'button-cap ratchet',
      roots: UI_SCAN_ROOTS,
      extensions: UI_SCAN_EXTENSIONS,
      pinned: PINNED_SCOPE_INVENTORY,
      files,
    });
    scope = describeScope({
      roots: UI_SCAN_ROOTS,
      extensions: UI_SCAN_EXTENSIONS,
      files,
    });
  }

  const rows = scanFiles(files, readFile);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baselineRows = groupBaselineEntries(baseline.rows ?? []);

  if (process.argv.includes('--report')) {
    const sorted = [...rows].sort(
      (a, b) => b.count - a.count || (a.key < b.key ? -1 : 1),
    );
    console.log(
      `${sorted.length} row(s) over the cap of ${LABELLED_ACTION_CAP} labelled actions (${scope}):`,
    );
    for (const row of sorted) {
      console.log(
        `  ${row.count}  ${row.key}  (line ${row.line}, ${row.children} children)`,
      );
      console.log(`       ${row.labels.join(' | ')}`);
    }
    return;
  }

  const result = evaluate(rows, baselineRows);

  if (process.argv.includes('--record')) {
    if (result.grown.length > 0) {
      console.error(
        'FAIL: --record only lowers the baseline, and these rows GREW:',
      );
      for (const entry of result.grown) console.error(`  ${entry.key}`);
      console.error(REMEDY);
      process.exit(1);
    }
    const lowered = loweredBaseline(rows, baselineRows);
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...baseline, rows: flattenBaselineRows(lowered, baseline.rows ?? []) }, null, 2)}\n`,
    );
    console.log(
      `Recorded ${Object.keys(lowered).length} baseline row identity(ies) in ${baselinePath}.`,
    );
    return;
  }

  console.log(
    `Button-cap ratchet (#3045 — at most ${LABELLED_ACTION_CAP} labelled actions per row). Scanned ${scope}.`,
  );

  if (result.grown.length > 0) {
    console.error(
      `\nFAIL: ${result.grown.length} action row(s) exceed the cap beyond the recorded baseline:\n`,
    );
    for (const entry of result.grown) {
      const lines = rows
        .filter((row) => row.key === entry.key && row.count === entry.count)
        .map((row) => row.line)
        .join(', ');
      console.error(
        entry.allowed === undefined
          ? `  ${entry.key}\n    ${entry.count} labelled actions in a row the baseline does not record (now at line ${lines}).`
          : `  ${entry.key}\n    ${entry.count} labelled actions, up from the recorded ${entry.allowed} (now at line ${lines}).`,
      );
    }
    console.error(REMEDY);
    process.exit(1);
  }

  if (result.shrunk.length > 0) {
    console.log(
      `NOTE: ${result.shrunk.length} recorded row(s) now show fewer labelled actions than the baseline allows. Lower it with: node scripts/button-cap-ratchet.mjs --record`,
    );
    for (const entry of result.shrunk) {
      console.log(
        `  ${entry.key}: recorded ${entry.allowed}, now ${entry.count ?? 'conforming or gone'}`,
      );
    }
  }
  console.log(
    `OK: ${rows.length} recorded row(s) over the cap, none new and none grown.`,
  );
}

if (invokedDirectly(import.meta.url)) main();
