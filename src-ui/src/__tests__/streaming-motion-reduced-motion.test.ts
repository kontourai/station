import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * station#2651: every streaming-aliveness primitive MUST declare an explicit
 * universal reduced-motion primitive. Shimmer is removed and sweep becomes
 * static; the other animation durations are clamped by tokens.css.
 */

const CSS_PATH = path.resolve(import.meta.dirname, '..', 'index.css');
const TOKENS_CSS_PATH = path.resolve(import.meta.dirname, '..', 'tokens.css');
const css = readFileSync(CSS_PATH, 'utf8');
const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');

/**
 * Extract the concatenated body of every
 * `@media (prefers-reduced-motion: reduce)` block via brace counting.
 */
function reducedMotionBlocks(source: string): string {
  const bodies: string[] = [];
  const opener = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let match: RegExpExecArray | null = opener.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      index += 1;
    }
    bodies.push(source.slice(opener.lastIndex, index - 1));
    match = opener.exec(source);
  }
  return bodies.join('\n');
}

const reduced = reducedMotionBlocks(css);

function universalReducedRule(source: string): string {
  const start = source.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 1;
  let index = open + 1;
  while (index < source.length && depth) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') depth -= 1;
    index += 1;
  }
  expect(depth).toBe(0);
  return (
    source
      .slice(open + 1, index - 1)
      .match(/\*,\s*\*::before,\s*\*::after\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  );
}

test('universal reduced-motion primitive is exact', () => {
  const rule = universalReducedRule(tokensCss);
  expect(rule).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  expect(rule).toMatch(/animation-iteration-count:\s*1\s*!important/);
  expect(rule).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
});

/** The rule body a selector owns inside the reduced-motion context. */
function reducedRuleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`);
  const found = reduced.match(rule);
  expect(
    found,
    `expected a prefers-reduced-motion counterpart rule for "${selector}" in index.css`,
  ).not.toBeNull();
  return found?.[1] ?? '';
}

describe('station#2651 reduced-motion counterparts', () => {
  test.each([
    'reveal-once-enter',
    'stream-caret-blink',
    'stream-shimmer',
    'indeterminate-sweep',
  ])('keyframe %s exists', (keyframe) => {
    expect(css, `expected @keyframes ${keyframe} in index.css`).toContain(
      `@keyframes ${keyframe}`,
    );
  });

  test('shimmer is fully removed (not just frozen) under reduce', () => {
    expect(reducedRuleFor('.streaming-tip::after')).toMatch(/content:\s*none/);
  });

  test('sweep keeps a static subtle bar under reduce (transform pinned, overlay retained)', () => {
    const body = reducedRuleFor('.indeterminate-sweep::after');
    expect(body).toMatch(/transform:/);
    expect(body).not.toMatch(/content:\s*none/);
    expect(body).not.toMatch(/display:\s*none/);
  });
});
