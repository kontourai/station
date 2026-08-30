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
 * keyframe direction, the stagger's per-child delay ladder and its 6-cap
 * (children 7+ start WITH row 6, not at zero), and that every construct with
 * a DELAY (the one thing the global `prefers-reduced-motion` reset in
 * tokens.css does not zero) explicitly zeroes it.
 *
 * (Item 4, the route-outlet-content skeleton->content fade, was reviewed out
 * of the branch — the nested opacity animation COMPOSED with `route-enter`'s
 * own opacity curve rather than resolving ahead of it, making content
 * visibly LATER, not sooner. `route-enter` alone is item 4's fade for this
 * app: the Suspense boundary sits outside `.route-transition`, so a
 * skeleton->content reveal and a route entrance always remount together.)
 */

/** An `animation-delay` declaration for EXACTLY `ms` — not a substring match,
 * which `'100ms'.includes('0ms')` would pass vacuously. */
function exactDelayMs(declaration: string | undefined, ms: number): boolean {
  if (!declaration) return false;
  return new RegExp(`^\\s*animation-delay:\\s*${ms}ms\\s*$`).test(declaration);
}

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

describe('station#753 item 2: list entrance stagger', () => {
  test('the base rule carries no explicit delay (child 1 relies on the shorthand reset)', () => {
    // `nth-child(1)` deliberately has no rule of its own: the `animation`
    // shorthand on `.entrance-stagger > *` already resets `animation-delay`
    // to its initial 0s, so a dedicated `nth-child(1) { animation-delay: 0ms }`
    // would be a no-op. Assert that reset lives on the shorthand rather than
    // asserting a per-child rule that no longer exists.
    const base = rulesFor(splitPaneCss, '.entrance-stagger > *')
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(base).toBeDefined();
    expect(base).toMatch(/var\(--motion-base\)/);
    expect(base).toMatch(/var\(--ease-out\)/);
    expect(base).not.toMatch(/animation-delay/);
    const dedicatedRuleForChild1 = rulesFor(
      splitPaneCss,
      '.entrance-stagger > *:nth-child(1)',
    );
    expect(dedicatedRuleForChild1).toEqual([]);
  });

  test('steps children 2-5 20ms apart, on token duration/easing', () => {
    for (let n = 2; n <= 5; n++) {
      const bodies = rulesFor(
        splitPaneCss,
        `.entrance-stagger > *:nth-child(${n})`,
      );
      const delay = bodies
        .flatMap((body) => body.split(';'))
        .find((declaration) => /^\s*animation-delay\s*:/.test(declaration));
      expect(
        exactDelayMs(delay, (n - 1) * 20),
        `nth-child(${n}) expected exactly ${(n - 1) * 20}ms, got: ${delay}`,
      ).toBe(true);
    }
  });

  test("row 6 and every row after it start together, at row 6's delay", () => {
    // Children 7+ used to get a ZERO delay, which finished them BEFORE rows
    // 4-6 and opened a visible ~150ms hole in the middle of the list. They
    // now share row 6's 100ms delay instead, so the whole initial viewport
    // arrives in one continuous sweep — "late rows never lag behind data"
    // still holds: nothing here delays past row 6, it just stops treating
    // row 7+ as later than row 6.
    const sixAndBeyond = rulesFor(
      splitPaneCss,
      '.entrance-stagger > *:nth-child(6)',
    );
    const sixDelay = sixAndBeyond
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation-delay\s*:/.test(declaration));
    expect(exactDelayMs(sixDelay, 100), `row 6: ${sixDelay}`).toBe(true);

    const capped = rulesFor(
      splitPaneCss,
      '.entrance-stagger > *:nth-child(n + 7)',
    );
    const cappedDelay = capped
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation-delay\s*:/.test(declaration));
    expect(exactDelayMs(cappedDelay, 100), `row 7+: ${cappedDelay}`).toBe(true);
  });

  test('backwards fill-mode, not forwards — the end frame already equals the natural state', () => {
    const base = rulesFor(splitPaneCss, '.entrance-stagger > *')
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(base).toBeDefined();
    expect(base).toMatch(/\bbackwards\b/);
    expect(base).not.toMatch(/\bforwards\b/);
    expect(base).not.toMatch(/\bboth\b/);
  });

  test('the entrance-stagger-item keyframe fades and settles from 4px', () => {
    const frames = keyframeBody(splitPaneCss, 'entrance-stagger-item');
    const from = frames.match(/from\s*\{([^}]*)\}/)?.[1];
    const to = frames.match(/to\s*\{([^}]*)\}/)?.[1];
    expect(
      from,
      'entrance-stagger-item must declare a from{} frame',
    ).toBeDefined();
    expect(from).toMatch(/opacity:\s*0/);
    expect(from).toMatch(/transform:\s*translateY\(4px\)/);
    expect(to, 'entrance-stagger-item must declare a to{} frame').toBeDefined();
    expect(to).toMatch(/opacity:\s*1/);
    expect(to).toMatch(/transform:\s*translateY\(0\)/);
  });

  test('reduced motion zeroes BOTH the animation and every child delay', () => {
    const bodies = reducedMotionBodies(splitPaneCss);
    const covering = bodies.filter((body) =>
      body.includes('.entrance-stagger'),
    );
    expect(covering.length).toBeGreaterThan(0);
    const joined = covering.join('\n');
    expect(joined).toMatch(
      /\.entrance-stagger > \*\s*\{[^}]*animation:\s*none/,
    );
    // The global tokens.css reset zeroes animation-DURATION, never
    // animation-DELAY (motion.md is explicit that anything with delays must
    // zero them itself) — this must state it for every child position, not
    // just the base rule, or a still-mounted row 2-6 would sit invisible for
    // its un-zeroed delay before its (now instant) animation ever starts.
    expect(joined).toMatch(/animation-delay:\s*0ms/);
  });
});

describe('station#753 item 3: dialog open transition', () => {
  test('.responsive-surface-panel opens without shrinking interactive hit boxes', () => {
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
    expect(from).toMatch(/transform:\s*translateY\(4px\)/);
    expect(from).not.toMatch(/scale\(/);
    expect(to).toMatch(/opacity:\s*1/);
    expect(to).toMatch(/transform:\s*translateY\(0\)/);
    expect(to).not.toMatch(/scale\(/);
  });

  test('collapses under reduced motion via the global tokens.css reset', () => {
    // This animation carries no delay, so it needs no page-local
    // reduced-motion block (mobile-css-ratchet counts those): the global
    // reset in tokens.css collapses duration and iteration for it. Pin the
    // preconditions of that derivation: no delay on the panel animation, and
    // the global reset still covering both properties.
    const panel = rulesFor(indexCss, '.responsive-surface-panel').join('\n');
    expect(panel).not.toMatch(/animation-delay/);
    const tokensCss = read('tokens.css');
    const globalReset = reducedMotionBodies(tokensCss).join('\n');
    expect(globalReset).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(globalReset).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(reducedMotionBodies(indexCss).join('\n')).not.toContain(
      '.responsive-surface-panel',
    );
  });
});

describe('station#753 item 5: press micro-feedback', () => {
  test('.button--primary presses to scale(0.97) on the instant token', () => {
    const bodies = rulesFor(indexCss, '.button--primary:active:not(:disabled)');
    const declarations = bodies.flatMap((body) => body.split(';'));
    expect(
      declarations.some((d) => /transform:\s*scale\(0\.97\)/.test(d)),
    ).toBe(true);
    const transition = declarations.find((d) => /^\s*transition\s*:/.test(d));
    expect(transition).toBeDefined();
    expect(transition).toMatch(/var\(--motion-instant\)/);
  });

  test('the composer send control presses the same way', () => {
    const bodies = rulesFor(
      chatCss,
      '.chat-input__send-btn:active:not(:disabled)',
    );
    const declarations = bodies.flatMap((body) => body.split(';'));
    expect(
      declarations.some((d) => /transform:\s*scale\(0\.97\)/.test(d)),
    ).toBe(true);
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
        (d) =>
          /^\s*transition\s*:/.test(d) || /transform\s+var\(--motion-/.test(d),
      );
    expect(transition).toBeDefined();
    expect(transition).toMatch(/transform\s+var\(--motion-fast\)/);
  });
});
