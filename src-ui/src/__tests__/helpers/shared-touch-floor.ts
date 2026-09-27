import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared mobile touch floor in `index.css`: inside the phone/short-coarse
 * media block, every DIRECT `button, a, .button, [role="button"]` child of an
 * `__actions`-style row gets 44px minimums. Components that rely on that rule
 * instead of declaring their own floor prove the DOM half themselves (their
 * controls are direct children of an `__actions` row); this reads the CSS half
 * once, so the rule's selector and declarations are checked in one place.
 *
 * jsdom computes no layout, so this is a stylesheet check, not a measurement.
 */
const MOBILE_MEDIA =
  '@media (max-width: 768px), (max-height: 540px) and (pointer: coarse)';
const DIRECT_CONTROL = '> :is(button, a, .button, [role="button"])';
const ACTIONS_ARM = '[class*="__actions"]';

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');

/** The body of every `@media` block whose prelude is exactly `prelude`. */
function mediaBlocks(css: string, prelude: string): string[] {
  const blocks: string[] = [];
  for (
    let at = css.indexOf(prelude);
    at > -1;
    at = css.indexOf(prelude, at + 1)
  ) {
    const open = css.indexOf('{', at);
    if (normalize(css.slice(at, open)) !== prelude) continue;
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(css.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return blocks;
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const declaration of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    result[declaration.slice(0, colon).trim()] = declaration
      .slice(colon + 1)
      .trim();
  }
  return result;
}

/**
 * The declarations of the shared `__actions` direct-child floor rule, or
 * `undefined` when no rule in the mobile block selects that arm's direct
 * controls.
 */
export function sharedActionsTouchFloor(): Record<string, string> | undefined {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../index.css'),
    'utf8',
  );
  for (const block of mediaBlocks(css, MOBILE_MEDIA)) {
    for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = normalize(rule[1].replace(/\/\*[\s\S]*?\*\//g, ''));
      if (!selector.endsWith(DIRECT_CONTROL)) continue;
      const container = selector.slice(0, -DIRECT_CONTROL.length).trim();
      if (!container.startsWith(':is(')) continue;
      if (!container.includes(ACTIONS_ARM)) continue;
      return declarations(rule[2]);
    }
  }
  return undefined;
}
