/**
 * The CSS sandbox for custom appearance (docs/decisions/custom-appearance.md).
 *
 * The server's text check (`customCssTextViolations`) is early feedback. This
 * is the guard: the CSS is parsed by the browser into a constructed
 * stylesheet, and the parsed rules are walked. Checking what the parser
 * produced, not the text, is what makes it escape-proof: `\75 rl(` and
 * `URL(` both serialize as `url(`, a shorthand's image is visible on its
 * longhand, and a custom property's raw value (which `var()` would
 * re-tokenize at use) still carries its backslash, which is refused.
 *
 * Kept: style rules (and nested ones), `@media`, `@supports`, `@container`,
 * `@layer` and `@keyframes`. Dropped: every other at-rule. Constructed sheets
 * already ignore `@import`; it is dropped here too in case a browser does
 * not. A declaration whose value fetches is removed; a rule whose declaration
 * block still fetches after that (a shorthand holding a `var()`, which the
 * CSSOM does not expand) loses its whole block; and if the final sheet's text
 * still fetches anything, nothing is applied.
 */
import {
  type CustomCssStripped,
  type CustomCssViolationKind,
  fetchingValueKind,
  splitCssDeclarations,
  URL_TAKING_FUNCTION,
} from '@kontourai/station-contracts/custom-appearance';

export interface SanitizedCss {
  /** The adoptable sheet, or `null` where constructed sheets are unavailable. */
  sheet: CSSStyleSheet | null;
  /** The sheet's text after sanitizing; what the pre-paint cache stores. */
  text: string;
  stripped: CustomCssStripped[];
}

const cut = (value: string) => value.slice(0, 120);

/** True where this browser can build and adopt constructed stylesheets. */
export function constructedSheetsSupported(): boolean {
  try {
    return (
      typeof CSSStyleSheet !== 'undefined' &&
      typeof new CSSStyleSheet().replaceSync === 'function' &&
      typeof document !== 'undefined' &&
      'adoptedStyleSheets' in document
    );
  } catch {
    return false;
  }
}

function defined<T>(name: string): T | undefined {
  return (globalThis as Record<string, unknown>)[name] as T | undefined;
}

type RuleCtor = abstract new (...args: never[]) => CSSRule;
const is = (rule: CSSRule, name: string): boolean => {
  const ctor = defined<RuleCtor>(name);
  return ctor !== undefined && rule instanceof ctor;
};

/** Rules whose children are walked and which are otherwise harmless. */
const GROUPING = [
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSContainerRule',
  'CSSLayerBlockRule',
];

/**
 * Whether one declaration fetches. A backslash is refused where the text is
 * tokenized again later (a custom property's raw value, any value holding
 * `var()`, whose substitution re-tokenizes it so `\75 rl(` becomes `url(`)
 * and anywhere near a URL-taking function (the URL parser reads `\` as `/`,
 * so `url("\\data:…")` and `url("\\#x")` load a same-origin path).
 * Elsewhere the parser has already resolved escapes, and the CSSOM adds its
 * own when it serializes a string or attribute selector (`[title='"']` reads
 * back as `"\""`), which cannot fetch; there backslashes are ignored.
 */
function declarationFetchKind(property: string, value: string) {
  const lower = value.toLowerCase();
  const name = property.trim().toLowerCase();
  if (
    name.startsWith('--') ||
    lower.includes('var(') ||
    URL_TAKING_FUNCTION.test(lower)
  )
    return fetchingValueKind(lower, name);
  return fetchingValueKind(lower.replace(/\\/g, ''), name);
}

/**
 * Block or sheet text, split into declarations outside strings and
 * parentheses (a `;` inside a string does not end a declaration), each
 * checked as above.
 */
function textFetchKind(text: string) {
  for (const { property, value } of splitCssDeclarations(text)) {
    const kind = declarationFetchKind(property, value);
    if (kind) return kind;
  }
  return null;
}

function sanitizeDeclarations(
  style: CSSStyleDeclaration,
  where: string,
  stripped: CustomCssStripped[],
): void {
  const names: string[] = [];
  for (let i = 0; i < style.length; i += 1) names.push(style.item(i));
  for (const name of names) {
    const kind = declarationFetchKind(name, style.getPropertyValue(name));
    if (!kind) continue;
    style.removeProperty(name);
    stripped.push({ where: cut(where), what: cut(name), reason: kind });
  }
  // A shorthand with var() is kept whole and its longhands read empty, so the
  // block's own text is the last word.
  const rest = textFetchKind(style.cssText);
  if (rest) {
    style.cssText = '';
    stripped.push({ where: cut(where), what: '*', reason: rest });
  }
}

function atRuleName(rule: CSSRule): string {
  const match = /^@([a-z-]+)/i.exec(rule.cssText);
  return match ? match[1]!.toLowerCase() : rule.constructor.name;
}

function reasonForDropped(name: string): CustomCssViolationKind {
  if (name === 'import') return 'import';
  if (name === 'font-face') return 'font-face';
  return 'at-rule';
}

function sanitizeRules(
  list: CSSRuleList,
  remove: (index: number) => void,
  stripped: CustomCssStripped[],
): void {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const rule = list[index]!;
    if (is(rule, 'CSSStyleRule')) {
      const styleRule = rule as CSSStyleRule;
      sanitizeDeclarations(styleRule.style, styleRule.selectorText, stripped);
      // Nested style rules (CSS nesting) give a style rule grouping members.
      const nestingRule = styleRule as CSSStyleRule &
        Partial<Pick<CSSGroupingRule, 'cssRules' | 'deleteRule'>>;
      const nested = nestingRule.cssRules;
      if (nested && nested.length > 0)
        sanitizeRules(nested, (i) => nestingRule.deleteRule!(i), stripped);
      continue;
    }
    if (is(rule, 'CSSNestedDeclarations')) {
      sanitizeDeclarations(
        (rule as CSSRule & { style: CSSStyleDeclaration }).style,
        '(nested)',
        stripped,
      );
      continue;
    }
    if (is(rule, 'CSSKeyframeRule')) {
      const frame = rule as CSSKeyframeRule;
      sanitizeDeclarations(frame.style, frame.keyText, stripped);
      continue;
    }
    if (is(rule, 'CSSLayerStatementRule')) continue;
    if (is(rule, 'CSSKeyframesRule')) {
      const frames = rule as CSSKeyframesRule;
      sanitizeRules(
        frames.cssRules,
        (i) =>
          frames.deleteRule((frames.cssRules[i] as CSSKeyframeRule).keyText),
        stripped,
      );
      continue;
    }
    if (GROUPING.some((name) => is(rule, name))) {
      const group = rule as CSSGroupingRule;
      sanitizeRules(group.cssRules, (i) => group.deleteRule(i), stripped);
      continue;
    }
    const name = atRuleName(rule);
    remove(index);
    stripped.push({
      where: cut(rule.cssText.split('{')[0]!.trim()),
      what: `@${name}`,
      reason: reasonForDropped(name),
    });
  }
}

/**
 * Parse and sanitize `css`. Returns the adoptable sheet (or `null` without
 * constructed-sheet support, in which case nothing is applied) and what was
 * removed.
 */
export function sanitizeCustomCss(css: string): SanitizedCss {
  if (!constructedSheetsSupported())
    return { sheet: null, text: '', stripped: [] };
  const stripped: CustomCssStripped[] = [];
  const refuse = (reason: CustomCssViolationKind): SanitizedCss => {
    stripped.push({ where: '(sheet)', what: '*', reason });
    return { sheet: new CSSStyleSheet(), text: '', stripped };
  };
  try {
    // Top-level rules are not deleted in place (a sheet refuses to drop an
    // @namespace while other rules follow it): the kept rules' text is parsed
    // into a fresh sheet, which is walked again and must then keep all of it.
    const parsed = new CSSStyleSheet();
    parsed.replaceSync(css);
    const kept: string[] = [];
    sanitizeRules(
      parsed.cssRules,
      (i) => {
        kept[i] = '';
      },
      stripped,
    );
    const text = Array.from(parsed.cssRules, (rule, i) =>
      kept[i] === '' ? '' : rule.cssText,
    )
      .filter(Boolean)
      .join('\n');
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    const again: CustomCssStripped[] = [];
    sanitizeRules(sheet.cssRules, () => undefined, again);
    if (again.length > 0) return refuse(again[0]!.reason);
    const final = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
    const left = textFetchKind(final);
    // Unreachable unless a rule type serializes a fetch it did not expose to
    // the walk; refuse the sheet rather than trust it.
    if (left) return refuse(left);
    return { sheet, text: final, stripped };
  } catch {
    // A parse or CSSOM failure applies nothing.
    return refuse('at-rule');
  }
}
