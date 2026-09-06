import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * #1374 (a): with a surface in `left` AND another in `right` — possible since
 * #928 slice iii/#1564 stopped `placeSurface` clearing the sibling side — the
 * banner overlay must step aside from BOTH docks at once, each side
 * independently of whether the other is expanded or collapsed.
 *
 * Nothing had to change for that: the four inset rules set `left` and `right`
 * separately and each keys only on its own side, so a real engine applies all
 * of them together. Executed evidence (headless Chromium over the real
 * `index.css` + `BannerHost.css`, 1280x800, fine pointer) for the six
 * two-side combinations:
 *
 *   both expanded (l=320 r=260)  -> left 320px  right 260px
 *   both, left collapsed          -> left  36px  right 260px
 *   both, right collapsed         -> left 320px  right  36px
 *   both collapsed                -> left  36px  right  36px
 *   left only / right only        -> that side inset, the other 0px
 *
 * and the `.app__main` grid tracks agreed with the insets in every case.
 * This file is what keeps that true, and it is a SOURCE SCAN, not a render:
 * jsdom evaluates no `:has()` and lays nothing out, so `getComputedStyle`
 * here would prove nothing. What it therefore pins is the STRUCTURE that
 * makes the rules compose — each rule declares one side's inset and only
 * that side's, and keys on one side's presence and only that — plus the
 * lockstep with the dock grid that `BannerHost.css`'s own comment demands.
 * It does not claim a pixel; the browser proof is the probe above and
 * `tests/connect-reconnect-banner.spec.ts`.
 *
 * `mobile-chrome-safety.test.ts` already pins that the four rules exist and
 * inset SOMETHING; this pins that they inset the right thing, one side each.
 */

const UI_SRC = join(__dirname, '..');
const bannerCss = readFileSync(
  join(UI_SRC, 'components/notifications/BannerHost.css'),
  'utf8',
);
const indexCss = readFileSync(join(UI_SRC, 'index.css'), 'utf8');

/** The shell's desktop breakpoint; two side regions exist only above it. */
const DESKTOP_QUERY =
  '@media (min-width: 769px) and (not ((max-height: 540px) and (pointer: coarse)))';

const stripComments = (css: string) => css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');

interface Rule {
  selector: string;
  body: string;
  /** Offset of the rule's `{` in the ORIGINAL source, for ordering claims. */
  at: number;
}

function rules(css: string): Rule[] {
  const found: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = normalize(stripComments(match[1]));
    // An at-rule prelude is not a selector list.
    if (selector.startsWith('@') || selector === '') continue;
    found.push({
      selector,
      body: match[2],
      at: (match.index ?? 0) + match[1].length,
    });
  }
  return found;
}

function declarations(body: string): { property: string; value: string }[] {
  return stripComments(body)
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return {
        property: entry.slice(0, colon).trim(),
        value: normalize(entry.slice(colon + 1)),
      };
    });
}

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

const bannerRules = rules(bannerCss);

function bannerInsetRule(selector: string): Rule {
  const matched = bannerRules.filter((rule) => rule.selector === selector);
  expect(matched, `expected exactly one \`${selector}\` rule`).toHaveLength(1);
  return matched[0] as Rule;
}

const expandedSelector = (side: Side) =>
  `.app__main:has(> [data-region="${side}"]) > .banner-host`;
const collapsedSelector = (side: Side) =>
  `.app__main:has(> [data-region="${side}"].is-collapsed) > .banner-host`;

describe('the banner steps aside from both side regions at once (#1374)', () => {
  test('the side inset rules are exactly the four expected, and no other', () => {
    // A fifth rule keying on a side would be a second answer to "how far in
    // does the overlay start" — the shape that made these insets one branch
    // or the other before the per-region variables existed.
    const sideRules = bannerRules.filter(
      (rule) =>
        rule.selector.includes('.banner-host') &&
        /data-region="(?:left|right)"/.test(rule.selector),
    );
    expect(sideRules.map((rule) => rule.selector).sort()).toEqual(
      [...SIDES.map(expandedSelector), ...SIDES.map(collapsedSelector)].sort(),
    );
  });

  test.each(SIDES)(
    'the %s inset declares that side alone, from that side alone',
    (side) => {
      for (const rule of [
        bannerInsetRule(expandedSelector(side)),
        bannerInsetRule(collapsedSelector(side)),
      ]) {
        // One declaration, and it is this side's. A `left: 0` living in the
        // right rule (or a `z-index` reset, or an `inset:` shorthand) would
        // clobber the other side's inset the moment both are occupied —
        // which is exactly and only the two-side defect.
        expect(
          declarations(rule.body).map(({ property }) => property),
          rule.selector,
        ).toEqual([side]);
        // And it keys on this side's presence alone: a selector naming the
        // other side would make the inset conditional on what the other
        // region happens to hold.
        expect(rule.selector, rule.selector).not.toContain(
          `data-region="${other(side)}"`,
        );
      }
    },
  );

  test.each(SIDES)(
    'the %s inset reads its own region variable, and the collapsed rail wins',
    (side) => {
      const expanded = bannerInsetRule(expandedSelector(side));
      const collapsed = bannerInsetRule(collapsedSelector(side));
      expect(declarations(expanded.body)[0]?.value).toContain(
        `var(--region-${side}-size,`,
      );
      expect(declarations(collapsed.body)[0]?.value).toBe('36px');
      // Same specificity class, so source order decides: the collapsed rail
      // must come last or a collapsed side would keep the expanded width.
      // (`:has()` takes the specificity of its most specific argument, and
      // `[data-region].is-collapsed` outranks `[data-region]` besides.)
      expect(collapsed.at).toBeGreaterThan(expanded.at);
    },
  );

  test('the side insets live in the desktop block, where two sides exist', () => {
    // Below the breakpoint every side placement folds to bottom
    // (useIsMobile.ts `availablePlacements`), so at most one shell mounts
    // and there is no column to inset into.
    const desktop = bannerCss.indexOf(DESKTOP_QUERY);
    expect(desktop).toBeGreaterThan(-1);
    for (const side of SIDES) {
      expect(bannerInsetRule(expandedSelector(side)).at).toBeGreaterThan(
        desktop,
      );
      expect(bannerInsetRule(collapsedSelector(side)).at).toBeGreaterThan(
        desktop,
      );
    }
  });

  test.each(SIDES)(
    "the %s inset stays in lockstep with that side's dock grid track",
    (side) => {
      // BannerHost.css's own comment requires this ("Keep the widths in
      // lockstep with the dock grid in index.css"), and nothing checked it:
      // the overlay and the track are two statements of one width, and a
      // drift between them is a banner that starts inside or short of the
      // dock. Compared as expressions, so the two move together whatever
      // the fallback chain becomes.
      // Whitespace-free, because a long value is wrapped by the formatter in
      // one file and not the other; the expression is what must match.
      const expression = (value: string | undefined) =>
        value?.replace(/\s+/g, '');
      const track = (selector: string) => {
        const matched = rules(indexCss).filter(
          (rule) => rule.selector === selector,
        );
        expect(matched, `expected exactly one \`${selector}\``).toHaveLength(1);
        const declaration = declarations(matched[0]?.body ?? '').find(
          ({ property }) => property === `--region-${side}-track`,
        );
        expect(
          declaration,
          `${selector} must set --region-${side}-track`,
        ).toBeDefined();
        return declaration?.value;
      };
      expect(
        expression(track(`.app__main:has(> [data-region="${side}"])`)),
      ).toBe(
        expression(
          declarations(bannerInsetRule(expandedSelector(side)).body)[0]?.value,
        ),
      );
      expect(
        expression(
          track(`.app__main:has(> [data-region="${side}"].is-collapsed)`),
        ),
      ).toBe(
        expression(
          declarations(bannerInsetRule(collapsedSelector(side)).body)[0]?.value,
        ),
      );
    },
  );
});
