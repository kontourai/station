/**
 * @vitest-environment jsdom
 *
 * The selected list row's text clears WCAG AA in every theme and channel.
 *
 * The row used to be a SOLID accent fill painted with --text-on-accent. The
 * layout only owns the row's name and subtitle; everything a consumer renders
 * inside them keeps its own colour, chosen for the panel. Measured with axe in
 * the running Activity list: 1.17:1 (light) and 1.38:1 (dark) for the status
 * line on the fill.
 *
 * jsdom computes no cascade, so — following
 * `SplitPaneLayout.railName.overflow.test.tsx` — this renders the real
 * `SplitPaneLayout` with real consumer row content, puts that markup into a
 * real Chromium page carrying the cascade-resolved `index.css` plus the
 * co-located stylesheets those rows import, and runs axe-core's own
 * `color-contrast` rule over the selected rows only.
 *
 * Row content, and why each is here:
 * - Agents: the real `buildAgentsViewItems` rows (agent icon, engine chip +
 *   readiness pill badges, tone-coloured).
 * - Activity: a row in the shape `SessionsView` renders today — the agent
 *   icon, `.activity-row-meta` with the real `StatusGlyph`, its state word, a
 *   failure detail and the agent/project/origin segments — plus the trailing
 *   time and the row-actions trigger. SessionsView's own row builder is not
 *   exported, so this is a fixture of its markup, not a call into it.
 * - A plain name + subtitle row, the shape the other consumers use.
 *
 * The agent icon, as a user sees it (#3093). `AgentIcon` draws one of two
 * things, both on its own opaque tile inside the row's opaque icon slot:
 * - an engine with a bundled brand mark (Station, Codex, ...) gets an inline
 *   SVG, loaded lazily, with no text in it;
 * - an engine without one (a custom ACP engine) gets its initials on a
 *   seeded hue swatch — text, which axe rates here like any other.
 * The fixture waits for the brand marks to load before it captures the
 * markup and carries `BrandIcon.css`, so neither is an empty grey tile.
 * The marks are logos beside the agent's name, and what they are drawn
 * with and on belongs to the icon, so their legibility in general is not
 * rated here. What this file owns is what selecting the row does to them.
 * Selection reaches a mark in one deliberate way: the selected row
 * re-points --text-muted (SplitPaneLayout.css), and OpenCode's mark fills
 * one shape with it. So each page checks that a selected row's mark sits
 * on an opaque tile and is painted exactly as the same mark in an
 * unselected row, except shapes whose fill reads a token the selected row
 * re-points (read from the live rule); those must still clear non-text
 * 3:1 against the tile.
 *
 * Anti-inert guards: each page asserts the selected rows exist and that axe
 * PASSED colour-contrast on text inside them (so a renamed class or a rule
 * axe could not evaluate is a failure, not a silent green), that nothing was
 * left `incomplete` except symbol-only status glyphs, which 1.4.3 (text)
 * does not cover, that axe rated every agent-icon initials node drawn in a
 * selected row, and that every selected brand mark was drawn and found its
 * unselected twin. Glyph non-text contrast, and brand-mark contrast other
 * than a re-pointed fill, are NOT measured here.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

import { AgentIcon } from '../components/icons/AgentIcon';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { StatusGlyph } from '../components/status/StatusGlyph';
import type { AgentData } from '../contexts/AgentsContext';
import { buildAgentsViewItems } from '../views/agent-editor/agentsViewHelpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const requireFromHere = createRequire(import.meta.url);
const AXE_PATH = requireFromHere.resolve('axe-core/axe.min.js');

const CSS_PATHS = [
  resolve(HERE, '../index.css'),
  resolve(HERE, '../components/SplitPaneLayout.css'),
  resolve(HERE, '../components/AgentReadinessCell.css'),
  resolve(HERE, '../components/badges/EngineChip.css'),
  resolve(HERE, '../components/icons/BrandIcon.css'),
  resolve(HERE, '../components/status/StatusGlyph.css'),
  resolve(HERE, '../views/activity/ActivityRowMenu.css'),
  resolve(HERE, '../views/SessionsView.css'),
];

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

const AGENTS = [
  {
    slug: 'station',
    name: 'Station',
    engineId: 'station',
    engineDisplayName: 'Station',
    provenance: { origin: 'builtin' },
  },
  {
    slug: 'reviewer',
    name: 'Code Reviewer',
    engineId: 'codex',
    engineDisplayName: 'Codex',
    provenance: { origin: 'builtin' },
    available: false,
    unavailableReason: 'no enabled LLM provider connection is configured.',
    unavailableFix: { kind: 'models' },
  },
  // A user's agent on a custom ACP engine: no brand mark, so its icon is
  // initials ("RN") on a seeded hue swatch.
  {
    slug: 'release-notes',
    name: 'Release Notes',
    engineId: 'acp',
    engineConnectionType: 'acp',
    connectionName: 'Gemini CLI',
  },
  // OpenCode's mark has a shape filled with --text-muted, a token the
  // selected row re-points: the one mark selection is meant to change.
  {
    slug: 'ui-tidier',
    name: 'UI Tidier',
    engineId: 'opencode',
  },
] as unknown as AgentData[];

async function railMarkup(
  items: Parameters<typeof SplitPaneLayout>[0]['items'],
  selectedId: string,
): Promise<string> {
  const { container, unmount } = render(
    <SplitPaneLayout
      label="fixture"
      title="Fixture"
      items={items}
      selectedId={selectedId}
      onSelect={() => {}}
      onSearch={() => {}}
    >
      <div>detail</div>
    </SplitPaneLayout>,
  );
  const left = container.querySelector('.split-pane__left');
  if (!left) throw new Error('the rail did not render');
  // A brand mark is a lazy chunk: captured before it resolves, the tile is
  // an empty box. Wait for every mark the rail asked for to be drawn.
  await waitFor(() => {
    const undrawn = Array.from(
      left.querySelectorAll('.brand-icon[data-brand-key]'),
    ).filter((icon) => !icon.querySelector('svg, img'));
    if (undrawn.length > 0)
      throw new Error(
        `brand marks never drew: ${undrawn
          .map((icon) => icon.getAttribute('data-brand-key'))
          .join(', ')}`,
      );
  });
  const html = left.outerHTML;
  unmount();
  return html;
}

async function fixtureRails(): Promise<string[]> {
  const agentItems = buildAgentsViewItems(
    AGENTS,
    { onChat: () => {}, onFix: () => {} },
    { readinessKnown: true },
  );
  const sessionRow = (
    id: string,
    state: 'Running' | 'Failed' | 'Completed' | 'Needs attention',
    agent: AgentData,
  ) => ({
    id,
    name: `SLOW refactor the chart module (${state})`,
    // The avatar SessionsView renders: a brand mark or initials, by engine.
    icon: <AgentIcon agent={agent} size="small" />,
    // Kept short on purpose: the row clamps this line to two, and text the
    // clamp clips is text axe cannot judge. It must fit under any platform's
    // fallback font, so the audit measures every node on every runner.
    subtitle: (
      <span className="activity-row-meta">
        <span className="activity-row-meta__state">
          <StatusGlyph state={state} /> <span>{state}</span>
        </span>
        {' · '}
        <span className="activity-row-meta__detail">HTTP 500</span>
        {' · '}
        <span data-segment="agent">{agent.name}</span>
      </span>
    ),
    trailing: (
      <div className="activity-row__actions responsive-surface-actions">
        <time className="activity-row__time" aria-hidden="true">
          1m ago
        </time>
        <button
          type="button"
          className="activity-row-menu__trigger"
          aria-label="More actions"
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
    ),
    group: { id: 'run', label: 'Run · 3 delegated sessions' },
  });
  // Both icon kinds, each in a selected and an unselected row of every rail.
  const sessionItems = [
    sessionRow('running', 'Running', AGENTS[1]!),
    sessionRow('failed', 'Failed', AGENTS[2]!),
    sessionRow('completed', 'Completed', AGENTS[1]!),
    sessionRow('attention', 'Needs attention', AGENTS[2]!),
  ];
  const plainItems = [
    {
      id: 'plain',
      name: 'A skill',
      subtitle: 'Workspace · 3 files',
      // Text that sets no colour of its own, so it inherits the row's: the
      // one node here that measures `.split-pane__item--selected`'s `color`
      // (agent icons set their own), and the one a scan taken mid-transition
      // gets wrong (#3074).
      icon: <span>SK</span>,
    },
    { id: 'other', name: 'Another skill', subtitle: 'Registry' },
  ];
  const rails: string[] = [];
  for (const item of agentItems)
    rails.push(await railMarkup(agentItems, item.id));
  for (const item of sessionItems)
    rails.push(await railMarkup(sessionItems, item.id));
  rails.push(await railMarkup(plainItems, 'plain'));
  return rails;
}

function fixtureHtml(rails: string[]): string {
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0;background:var(--bg-primary);color:var(--text-primary)">
    ${rails
      .map(
        (rail) =>
          `<div class="split-pane" style="display:flex;width:900px;height:auto"><div style="width:320px;display:flex">${rail}</div></div>`,
      )
      .join('\n')}
  </body>
</html>`;
}

/** Every theme × channel the app ships a distinct accent for. */
const PRESETS: Array<{ theme: 'light' | 'dark'; channel: string }> = [
  'release',
  'beta',
  'nightly',
  'dev',
].flatMap((channel) =>
  (['light', 'dark'] as const).map((theme) => ({ theme, channel })),
);

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'a selected split-pane row keeps AA text contrast',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let html: string;

    beforeAll(async () => {
      browser = await chromium.launch();
      html = fixtureHtml(await fixtureRails());
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function audit(
      preset: (typeof PRESETS)[number],
      hover: boolean,
    ): Promise<{
      selectedRows: number;
      passedPerRow: number[];
      violations: string[];
      incomplete: string[];
      marksCompared: number;
      repaintedMarks: string[];
      repointedTokens: string[];
      initialsRated: number;
      initialsDrawn: number;
    }> {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 2400 },
      });
      try {
        await page.setContent(html);
        // Loaded before the preset is stamped, so that the settle wait below
        // is all that separates the stamp from the scan.
        await page.addScriptTag({ path: AXE_PATH });
        await page.evaluate(({ theme, channel }) => {
          const root = document.documentElement;
          root.setAttribute('data-theme', theme);
          if (channel === 'dev') root.classList.add('is-dev-build');
          else if (channel !== 'release')
            root.setAttribute('data-app-channel', channel);
        }, preset);
        const selectedRows = await page
          .locator('.split-pane__item--selected')
          .count();
        if (hover) {
          // One hovered selected row per audit is enough to prove the hover
          // rule keeps the selected treatment; axe reads the live state.
          await page.locator('.split-pane__item--selected').nth(3).hover();
        }
        // The page parses unstamped (dark defaults), so stamping the preset
        // starts the rows' own `transition: color`, and the hover starts
        // their `background` one. Scanned before those end, axe reads the
        // previous theme's text colour, or a blend, on the new surface
        // (#3074). Measure the settled state: wait for everything the page
        // is running to finish, except a looping animation, which never does
        // (the rule `tests/helpers/accessibility.ts` uses).
        await page.evaluate(async () => {
          for (;;) {
            const running = document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === 'running' &&
                  animation.effect?.getTiming().iterations !== Infinity,
              );
            if (running.length === 0) return;
            await Promise.allSettled(
              running.map((animation) => animation.finished),
            );
          }
        });
        const result = await page.evaluate(async () => {
          const axe = (
            window as unknown as {
              axe: {
                run: (
                  context: unknown,
                  options: unknown,
                ) => Promise<{
                  violations: Array<{
                    nodes: Array<{ target: string[]; failureSummary?: string }>;
                  }>;
                  incomplete: Array<{
                    nodes: Array<{ target: string[]; failureSummary?: string }>;
                  }>;
                  passes: Array<{ nodes: Array<{ target: string[] }> }>;
                }>;
              };
            }
          ).axe;
          const run = await axe.run(
            { include: [['.split-pane__item--selected']] },
            { runOnly: { type: 'rule', values: ['color-contrast'] } },
          );
          const describe = (
            groups: Array<{
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>,
          ) =>
            groups.flatMap((group) =>
              group.nodes.map(
                (node) =>
                  `${node.target.join(' ')}: ${node.failureSummary ?? ''}`,
              ),
            );
          return {
            violations: describe(run.violations),
            // A StatusGlyph is a symbol (●, ✓) with an aria-label; axe files
            // symbol-only text as "incomplete" because 1.4.3 does not apply
            // to it. Anything else it could not decide is a failure here.
            incomplete: describe(
              run.incomplete.map((group) => ({
                ...group,
                nodes: group.nodes.filter((node) => {
                  const element =
                    node.target.length === 1
                      ? document.querySelector(node.target[0]!)
                      : null;
                  return !(
                    element?.matches('.status-glyph[role="img"]') &&
                    /^[^\p{L}\p{N}]+$/u.test(element.textContent?.trim() ?? '')
                  );
                }),
              })),
            ),
            // Passes counted per selected row, not in total: a total lets
            // well-covered rows hide one axe rated nothing in.
            passedPerRow: Array.from(
              document.querySelectorAll('.split-pane__item--selected'),
              (row) =>
                run.passes
                  .flatMap((group) => group.nodes)
                  .filter((node) =>
                    row.contains(document.querySelector(node.target[0])),
                  ).length,
            ),
            // Agent-icon initials axe PASSED in selected rows: without this,
            // an icon that stopped drawing initials would just be one fewer
            // node, hidden by the per-row floor.
            initialsRated: run.passes
              .flatMap((group) => group.nodes)
              .filter((node) =>
                document
                  .querySelector(node.target[0])
                  ?.matches(
                    '.split-pane__item--selected .brand-icon__initials',
                  ),
              ).length,
          };
        });
        // A selected row's brand mark against the same mark in an unselected
        // row: the slot, the tile and every painted shape.
        const marks = await page.evaluate(() => {
          // Tokens the selected row re-points for its whole subtree, read
          // from the live `.split-pane__item--selected` rule
          // (SplitPaneLayout.css re-points --text-muted, on purpose, to
          // keep the faintest text step at AA on the tint).
          const styleRules: CSSStyleRule[] = [];
          const collect = (rules: CSSRuleList) => {
            for (const rule of rules) {
              if (rule instanceof CSSStyleRule) styleRules.push(rule);
              if ('cssRules' in rule)
                collect((rule as CSSGroupingRule).cssRules);
            }
          };
          for (const sheet of document.styleSheets) collect(sheet.cssRules);
          const repointed = styleRules
            .filter(
              (rule) => rule.selectorText === '.split-pane__item--selected',
            )
            .flatMap((rule) =>
              Array.from(rule.style).filter((name) => name.startsWith('--')),
            );
          // A shape whose own fill reads a re-pointed token is meant to
          // change when the row is selected.
          const readsRepointed = (shape: Element) =>
            styleRules.some(
              (rule) =>
                // Token test first: only fill rules reach `matches`.
                repointed.some((token) =>
                  rule.style.getPropertyValue('fill').includes(`var(${token})`),
                ) && shape.matches(rule.selectorText),
            );
          const canvas = document.createElement('canvas').getContext('2d')!;
          const luminance = (color: string) => {
            canvas.clearRect(0, 0, 1, 1);
            canvas.fillStyle = color;
            canvas.fillRect(0, 0, 1, 1);
            const [r, g, b] = Array.from(
              canvas.getImageData(0, 0, 1, 1).data.slice(0, 3),
              (byte) => {
                const c = byte / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              },
            );
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          const contrast = (a: string, b: string) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (hi! + 0.05) / (lo! + 0.05);
          };
          const shapesOf = (icon: Element) =>
            Array.from(icon.querySelectorAll('svg rect, svg path'));
          const paint = (icon: Element) => {
            const slot = icon.closest('.split-pane__item-icon');
            return JSON.stringify({
              slot: slot && getComputedStyle(slot).backgroundColor,
              tile: getComputedStyle(icon).backgroundColor,
              border: getComputedStyle(icon).borderTopColor,
              shapes: shapesOf(icon).map((shape) =>
                readsRepointed(shape)
                  ? 're-pointed by the selected row'
                  : getComputedStyle(shape).fill,
              ),
              images: Array.from(icon.querySelectorAll('img'), (image) => {
                const style = getComputedStyle(image);
                const box = image.getBoundingClientRect();
                return [style.opacity, style.visibility, box.width, box.height];
              }),
            });
          };
          const repainted: string[] = [];
          let compared = 0;
          for (const icon of document.querySelectorAll(
            '.split-pane__item--selected .brand-icon[data-brand-key]',
          )) {
            const key = icon.getAttribute('data-brand-key');
            const twin = document.querySelector(
              `.split-pane__item:not(.split-pane__item--selected) .brand-icon[data-brand-key="${key}"]`,
            );
            if (!twin) {
              repainted.push(`${key}: no unselected row draws this mark`);
              continue;
            }
            if (!icon.querySelector('svg rect, svg path, img')) {
              // An empty tile matches an empty twin; that is not a mark.
              repainted.push(`${key}: the mark was not drawn`);
              continue;
            }
            // The tile is what a mark is drawn on. If it is see-through (or
            // `BrandIcon.css` is missing from the page) the row's selection
            // tint shows through, and an equal twin no longer means an
            // unchanged mark.
            const tile = getComputedStyle(icon).backgroundColor;
            // rgba(r, g, b, a) or color(srgb r g b / a); rgb() is opaque.
            const alpha = /^rgba\(.*,\s*([\d.]+)\)$|\/\s*([\d.]+)\)$/.exec(
              tile,
            );
            if (alpha && Number(alpha[1] ?? alpha[2]) < 1) {
              repainted.push(`${key}: the mark's tile is not opaque (${tile})`);
              continue;
            }
            compared += 1;
            const selected = paint(icon);
            const unselected = paint(twin);
            if (selected !== unselected)
              repainted.push(
                `${key}: selected ${selected} vs unselected ${unselected}`,
              );
            // A re-pointed fill may change, but not below non-text 3:1
            // against its tile (1.4.11).
            for (const shape of shapesOf(icon).filter(readsRepointed)) {
              const fill = getComputedStyle(shape).fill;
              const ratio = contrast(fill, tile);
              if (ratio < 3)
                repainted.push(
                  `${key}: re-pointed fill ${fill} is ${ratio.toFixed(2)}:1 on its tile ${tile}`,
                );
            }
          }
          return { compared, repainted, repointed };
        });
        // The selected rows' drawn initials, to hold axe's count against.
        const initialsDrawn = await page
          .locator('.split-pane__item--selected .brand-icon__initials')
          .count();
        return {
          selectedRows,
          passedPerRow: result.passedPerRow,
          violations: result.violations,
          incomplete: result.incomplete,
          marksCompared: marks.compared,
          repaintedMarks: marks.repainted,
          repointedTokens: marks.repointed,
          initialsRated: result.initialsRated,
          initialsDrawn,
        };
      } finally {
        await page.close();
      }
    }

    test.each(PRESETS)(
      '$channel channel, $theme theme: every text node in a selected row is AA',
      async (preset) => {
        const {
          selectedRows,
          passedPerRow,
          violations,
          incomplete,
          marksCompared,
          repaintedMarks,
          repointedTokens,
          initialsRated,
          initialsDrawn,
        } = await audit(preset, false);
        // 4 Agents rails + 4 Activity rails + 1 plain rail.
        expect(selectedRows).toBe(9);
        // Violations first, so a contrast regression reports the contrast.
        expect(violations).toEqual([]);
        expect(incomplete).toEqual([]);
        expect(repaintedMarks).toEqual([]);
        // Every selected mark either counts here or lands in repaintedMarks.
        expect(marksCompared).toBeGreaterThan(0);
        // Read from the live rule; without it the OpenCode mark's muted
        // shape would be compared as if selection could not touch it.
        expect(repointedTokens).toContain('--text-muted');
        // Every initials node drawn in a selected row was rated by axe.
        expect(initialsDrawn).toBeGreaterThan(0);
        expect(initialsRated).toBe(initialsDrawn);
        expect(passedPerRow).toHaveLength(selectedRows);
        // Every row has at least a name and a second text node (subtitle or
        // badge); a row with fewer passes is one axe was not looking at.
        expect(Math.min(...passedPerRow)).toBeGreaterThanOrEqual(2);
      },
    );

    test.each(PRESETS.filter((preset) => preset.channel === 'release'))(
      'release channel, $theme theme: a hovered selected row stays AA',
      async (preset) => {
        const {
          passedPerRow,
          violations,
          incomplete,
          marksCompared,
          repaintedMarks,
          initialsRated,
          initialsDrawn,
        } = await audit(preset, true);
        expect(violations).toEqual([]);
        expect(incomplete).toEqual([]);
        expect(repaintedMarks).toEqual([]);
        expect(marksCompared).toBeGreaterThan(0);
        expect(initialsDrawn).toBeGreaterThan(0);
        expect(initialsRated).toBe(initialsDrawn);
        expect(Math.min(...passedPerRow)).toBeGreaterThanOrEqual(2);
      },
    );
  },
);

test.skipIf(chromiumAvailable)(
  'SplitPaneLayout selected-row contrast — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so this could ' +
        'not be measured — a missing precondition, not a passing check. ' +
        'Install it with `npm run install:playwright` and re-run.',
    );
  },
);
