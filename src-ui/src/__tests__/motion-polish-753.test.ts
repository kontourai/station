import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * station#753 motion polish pass. Asserts the computed motion CONTRACT for
 * each new surface class, the same discipline `chat-dock-motion.test.ts`
 * established: read the CSS source (comments stripped — a comment mentioning
 * a property is not a declaration), not a jsdom computed style, since jsdom
 * does not apply real stylesheet cascade/animation.
 *
 * `motion-contract-ratchet.mjs` already proves every declaration here uses a
 * token, never a literal, and never `transition: all`. What THIS file proves
 * is the shape of the choreography the ratchet cannot see: which token, which
 * keyframe direction, the stagger's per-child delay ladder and its 7+ cap,
 * and that every construct with a DELAY (the one thing the global
 * `prefers-reduced-motion` reset in tokens.css does not zero) explicitly
 * zeroes it.
 */

const SRC = path.resolve(import.meta.dirname, '..');
const read = (...parts: string[]) =>
  readFileSync(path.join(SRC, ...parts), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

/** Every rule body the selector participates in, inside `scope`. */
function rulesFor(scope: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|[,{}\\n])\\s*[^{}]*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`,
    'g',
  );
  const bodies: string[] = [];
  let match: RegExpExecArray | null = rule.exec(scope);
  while (match !== null) {
    bodies.push(match[1]);
    match = rule.exec(scope);
  }
  return bodies;
}

/** The body of a `@keyframes name { ... }` block, brace-balanced. */
function keyframeBody(source: string, name: string): string {
  const start = source.indexOf(`@keyframes ${name}`);
  expect(start, `missing @keyframes ${name}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 1;
  let index = open + 1;
  while (index < source.length && depth) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    index++;
  }
  return source.slice(open + 1, index - 1);
}

/** The body of the reduced-motion media query immediately declared in `source`. */
function reducedMotionBodies(source: string): string[] {
  const bodies: string[] = [];
  const re = /@media \(prefers-reduced-motion: reduce\)\s*\{/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth) {
      if (source[index] === '{') depth++;
      else if (source[index] === '}') depth--;
      index++;
    }
    bodies.push(source.slice(match.index + match[0].length, index - 1));
    match = re.exec(source);
  }
  return bodies;
}

const routeTransitionCss = read('app-shell', 'route-transition.css');
const splitPaneCss = read('components', 'SplitPaneLayout.css');
const indexCss = read('index.css');
const chatCss = read('components', 'chat', 'chat.css');

describe('station#753 item 1: route entrance', () => {
  test('translates in from 4px, not the retired 6px/8px', () => {
    const from = keyframeBody(routeTransitionCss, 'route-enter').match(
      /from\s*\{([^}]*)\}/,
    )?.[1];
    expect(from, 'route-enter must declare a from{} frame').toBeDefined();
    expect(from).toMatch(/opacity:\s*0/);
    expect(from).toMatch(/transform:\s*translateY\(4px\)/);
  });

  test('uses the base duration and the directional out-easing', () => {
    const bodies = rulesFor(routeTransitionCss, '.route-transition');
    const animation = bodies
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(animation).toBeDefined();
    expect(animation).toMatch(/var\(--motion-base\)/);
    expect(animation).toMatch(/var\(--ease-out\)/);
  });
});

describe('station#753 item 4: skeleton -> content fade', () => {
  test('.route-outlet-content fades opacity only, at the fast duration', () => {
    const bodies = rulesFor(routeTransitionCss, '.route-outlet-content');
    const animation = bodies
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(animation).toBeDefined();
    expect(animation).toMatch(/var\(--motion-fast\)/);
    const frames = keyframeBody(routeTransitionCss, 'route-outlet-content-fade');
    expect(frames).not.toMatch(/transform/);
    expect(frames).toMatch(/opacity:\s*0/);
    expect(frames).toMatch(/opacity:\s*1/);
  });

  test('collapses under reduced motion', () => {
    const bodies = reducedMotionBodies(routeTransitionCss);
    const covering = bodies.find((body) => body.includes('.route-outlet-content'));
    expect(covering, 'no reduced-motion override for .route-outlet-content').toBeDefined();
    expect(covering).toMatch(/animation:\s*none/);
  });
});

describe('station#753 item 2: list entrance stagger', () => {
  test('steps the first 6 children 20ms apart, on token duration/easing', () => {
    for (let n = 1; n <= 6; n++) {
      const bodies = rulesFor(splitPaneCss, `.entrance-stagger > *:nth-child(${n})`);
      const delay = bodies
        .flatMap((body) => body.split(';'))
        .find((declaration) => /^\s*animation-delay\s*:/.test(declaration));
      expect(delay, `nth-child(${n}) missing animation-delay`).toBeDefined();
      expect(delay).toContain(`${(n - 1) * 20}ms`);
    }
    const base = rulesFor(splitPaneCss, '.entrance-stagger > *')
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(base).toBeDefined();
    expect(base).toMatch(/var\(--motion-base\)/);
    expect(base).toMatch(/var\(--ease-out\)/);
  });

  test('caps children 7+ at zero delay — late rows never lag behind data', () => {
    const bodies = rulesFor(splitPaneCss, '.entrance-stagger > *:nth-child(n + 7)');
    const delay = bodies
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation-delay\s*:/.test(declaration));
    expect(delay).toBeDefined();
    expect(delay).toContain('0ms');
  });

  test('reduced motion zeroes BOTH the animation and every child delay', () => {
    const bodies = reducedMotionBodies(splitPaneCss);
    const covering = bodies.filter((body) => body.includes('.entrance-stagger'));
    expect(covering.length).toBeGreaterThan(0);
    const joined = covering.join('\n');
    expect(joined).toMatch(/\.entrance-stagger > \*\s*\{[^}]*animation:\s*none/);
    // The global tokens.css reset zeroes animation-DURATION, never
    // animation-DELAY (motion.md is explicit that anything with delays must
    // zero them itself) — this must state it for every child position, not
    // just the base rule, or a still-mounted row 2-6 would sit invisible for
    // its un-zeroed delay before its (now instant) animation ever starts.
    expect(joined).toMatch(/animation-delay:\s*0ms/);
  });
});

describe('station#753 item 3: dialog open transition', () => {
  test('.responsive-surface-panel opens on scale + opacity, base duration, emphasized easing', () => {
    const bodies = rulesFor(indexCss, '.responsive-surface-panel');
    const animation = bodies
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(animation).toBeDefined();
    expect(animation).toMatch(/var\(--motion-base\)/);
    expect(animation).toMatch(/var\(--ease-emphasized\)/);
    const frames = keyframeBody(indexCss, 'responsive-surface-panel-enter');
    const from = frames.match(/from\s*\{([^}]*)\}/)?.[1];
    const to = frames.match(/to\s*\{([^}]*)\}/)?.[1];
    expect(from).toMatch(/opacity:\s*0/);
    expect(from).toMatch(/transform:\s*scale\(0\.98\)/);
    expect(to).toMatch(/opacity:\s*1/);
    expect(to).toMatch(/transform:\s*scale\(1\)/);
  });

  test('collapses under reduced motion', () => {
    const bodies = reducedMotionBodies(indexCss);
    const covering = bodies.find((body) =>
      body.includes('.responsive-surface-panel'),
    );
    expect(covering).toBeDefined();
    expect(covering).toMatch(/animation:\s*none/);
  });
});

describe('station#753 item 5: press micro-feedback', () => {
  test('.button--primary presses to scale(0.97) on the instant token', () => {
    const bodies = rulesFor(indexCss, '.button--primary:active:not(:disabled)');
    const declarations = bodies.flatMap((body) => body.split(';'));
    expect(declarations.some((d) => /transform:\s*scale\(0\.97\)/.test(d))).toBe(
      true,
    );
    const transition = declarations.find((d) => /^\s*transition\s*:/.test(d));
    expect(transition).toBeDefined();
    expect(transition).toMatch(/var\(--motion-instant\)/);
  });

  test('the composer send control presses the same way', () => {
    const bodies = rulesFor(chatCss, '.chat-input__send-btn:active:not(:disabled)');
    const declarations = bodies.flatMap((body) => body.split(';'));
    expect(declarations.some((d) => /transform:\s*scale\(0\.97\)/.test(d))).toBe(
      true,
    );
    const transition = declarations.find((d) => /^\s*transition\s*:/.test(d));
    expect(transition).toBeDefined();
    expect(transition).toMatch(/var\(--motion-instant\)/);
  });

  test('the shared release transition is faster than the base scale', () => {
    // The release (":active" no longer matching) reads `.button--primary`'s
    // own transition — must be `--motion-fast`, not the generic `.button`
    // base's `--motion-base`, or the press would feel slower coming off than
    // going down.
    const bodies = rulesFor(indexCss, '.button--primary');
    const transition = bodies
      .flatMap((body) => body.split(';'))
      .find(
        (d) => /^\s*transition\s*:/.test(d) || /transform\s+var\(--motion-/.test(d),
      );
    expect(transition).toBeDefined();
    expect(transition).toMatch(/transform\s+var\(--motion-fast\)/);
  });
});
