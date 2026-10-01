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
 * - Agents: the real `buildAgentsViewItems` rows (engine chip + readiness
 *   pill badges, tone-coloured).
 * - Activity: a delegated-run member row in the shape `SessionsView` renders
 *   today — `.session-member-status` with the real `StatusGlyph`, spans that
 *   read `--text-muted`, and `.session-origin-history` — plus the real
 *   `SessionProjectPill` trailing control. SessionsView's own row builder is
 *   not exported, so this is a fixture of its markup, not a call into it.
 * - A plain name + subtitle row, the shape the other consumers use.
 *
 * Anti-inert guards: each page asserts the selected rows exist and that axe
 * PASSED colour-contrast on text inside them (so a renamed class or a rule
 * axe could not evaluate is a failure, not a silent green), and that nothing
 * was left `incomplete` except symbol-only status glyphs, which 1.4.3 (text)
 * does not cover. Glyph non-text contrast is NOT measured here.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
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

import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { SessionProjectPill } from '../components/session/SessionProjectPill';
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
  resolve(HERE, '../components/status/StatusGlyph.css'),
  resolve(HERE, '../components/session/SessionProjectPill.css'),
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
] as unknown as AgentData[];

function railMarkup(
  items: Parameters<typeof SplitPaneLayout>[0]['items'],
  selectedId: string,
): string {
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
  const html = left.outerHTML;
  unmount();
  return html;
}

function fixtureRails(): string[] {
  const agentItems = buildAgentsViewItems(
    AGENTS,
    { onChat: () => {}, onFix: () => {} },
    { readinessKnown: true },
  );
  const sessionRow = (
    id: string,
    state: 'Running' | 'Failed' | 'Completed' | 'Needs attention',
  ) => ({
    id,
    name: `SLOW refactor the chart module (${state})`,
    icon: <span>RP</span>,
    subtitle: (
      <>
        <span className="session-member-status">
          <span className="session-member-status__identity">
            <StatusGlyph state={state} />
            <span>Code Reviewer · fixture-model</span>
          </span>
          <span>Last progress 1m ago</span>
          <span style={{ color: 'var(--text-muted)' }}>
            Provider returned HTTP 500
          </span>
        </span>
        <span className="session-origin-history">
          Also driven from another origin
        </span>
      </>
    ),
    trailing: (
      <SessionProjectPill
        label="demo"
        filterKey="demo"
        active={false}
        onToggle={() => {}}
      />
    ),
    group: { id: 'run', label: 'Run · 3 delegated sessions' },
  });
  const sessionItems = [
    sessionRow('running', 'Running'),
    sessionRow('failed', 'Failed'),
    sessionRow('completed', 'Completed'),
    sessionRow('attention', 'Needs attention'),
  ];
  const plainItems = [
    { id: 'plain', name: 'A skill', subtitle: 'Workspace · 3 files' },
    { id: 'other', name: 'Another skill', subtitle: 'Registry' },
  ];
  return [
    ...agentItems.map((item) => railMarkup(agentItems, item.id)),
    ...sessionItems.map((item) => railMarkup(sessionItems, item.id)),
    railMarkup(plainItems, 'plain'),
  ];
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
      html = fixtureHtml(fixtureRails());
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
      passedInSelected: number;
      violations: string[];
      incomplete: string[];
    }> {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 2400 },
      });
      try {
        await page.setContent(
          html.replace(
            '<html>',
            `<html data-theme="${preset.theme}"${preset.channel === 'dev' ? ' class="is-dev-build"' : preset.channel === 'release' ? '' : ` data-app-channel="${preset.channel}"`}>`,
          ),
        );
        await page.addScriptTag({ path: AXE_PATH });
        const selectedRows = await page
          .locator('.split-pane__item--selected')
          .count();
        if (hover) {
          // One hovered selected row per audit is enough to prove the hover
          // rule keeps the selected treatment; axe reads the live state.
          await page.locator('.split-pane__item--selected').nth(3).hover();
        }
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
            passed: run.passes.reduce(
              (total, group) => total + group.nodes.length,
              0,
            ),
          };
        });
        return {
          selectedRows,
          passedInSelected: result.passed,
          violations: result.violations,
          incomplete: result.incomplete,
        };
      } finally {
        await page.close();
      }
    }

    test.each(PRESETS)(
      '$channel channel, $theme theme: every text node in a selected row is AA',
      async (preset) => {
        const { selectedRows, passedInSelected, violations, incomplete } =
          await audit(preset, false);
        // 2 Agents rails + 4 Activity rails + 1 plain rail.
        expect(selectedRows).toBe(7);
        // Name, subtitle spans, badges: far more than one text node per row
        // must have been measured, or axe was looking at nothing.
        expect(passedInSelected).toBeGreaterThanOrEqual(selectedRows * 2);
        expect(violations).toEqual([]);
        expect(incomplete).toEqual([]);
      },
    );

    test.each(PRESETS.filter((preset) => preset.channel === 'release'))(
      'release channel, $theme theme: a hovered selected row stays AA',
      async (preset) => {
        const { violations, incomplete } = await audit(preset, true);
        expect(violations).toEqual([]);
        expect(incomplete).toEqual([]);
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
