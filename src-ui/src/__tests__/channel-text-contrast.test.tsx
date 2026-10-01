/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { contrastRatio } from '@kontourai/ui/contrast';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

/**
 * #2905: the release channels paint their brand as TEXT — the sidebar channel
 * badge and the kit's `.eyebrow` in the Readiness and Trust panels — and the
 * panels' "Why" and "Evidence" links paint an accent colour on raised rows.
 * This renders the real components, puts their markup in Chromium under the
 * real stylesheets, and measures each text colour against the background it
 * actually sits on, for every channel in both modes. The rule-level check of
 * the channel values lives in `branding-role-cascade.test.ts`; this one
 * catches a surface the rules do not model (the raised rows, a hover fill).
 *
 * The chat-dock resize grips are measured too, as non-text UI (3:1): on hover
 * and keyboard focus they sit on a brand tint, so a brand retint moves them.
 */

const readinessState = {
  data: undefined as unknown,
  isLoading: false,
  isPlaceholderData: false,
  error: null,
};
const bundlesState = {
  data: undefined as unknown,
  isLoading: false,
  isPlaceholderData: false,
  error: null,
};
const reportState = {
  data: undefined as unknown,
  isLoading: false,
  isPlaceholderData: false,
  error: null,
};

vi.mock('@kontourai/station-sdk', () => ({
  useReadinessQuery: () => readinessState,
  useRefreshReadinessMutation: () => ({
    mutate: () => {},
    isPending: false,
    error: null,
  }),
  useTrustBundlesQuery: () => bundlesState,
  useTrustReportQuery: () => reportState,
}));

import { ChatDockResizeHandle } from '../components/chat-dock/ChatDockResizeHandle';
import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';
import { ReadinessPanel } from '../components/readiness/ReadinessPanel';
import { TrustPanel } from '../components/trust/TrustPanel';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

const AA_TEXT = 4.5;
/** WCAG 1.4.11 non-text contrast, for the resize grips. */
const NON_TEXT = 3;

/**
 * Page-side measuring helpers, installed once per page. `backdrop` composites
 * each ancestor's fill, nearest first, until an opaque one; a background
 * image would make the measurement meaningless, so it is refused.
 */
const MEASURE_HELPERS = `
window.__contrast = (() => {
  const probe = document.createElement('canvas').getContext('2d');
  const rgba = (value) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const hex = ([r, g, b]) =>
    '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map(
      (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha,
    ).concat(alpha);
  };
  const backdropRgba = (element) => {
    let color = [0, 0, 0, 0];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none')
        throw new Error('background image behind ' + node.className);
      color = over(color, rgba(style.backgroundColor));
      if (color[3] >= 0.999) return color;
    }
    throw new Error('no opaque backdrop for ' + element.className);
  };
  return { rgba, hex, over, backdrop: (element) => hex(backdropRgba(element)), backdropRgba };
})();
`;

type Mode = 'dark' | 'light';
type Channel = 'release' | 'dev' | 'beta' | 'nightly';

/** Which token the surface is meant to paint, so a class that stops matching
 * (the text falling back to the inherited body colour) cannot pass silently. */
type Role = 'brand' | 'action';

const BADGE = 'sidebar channel badge';

const TARGETS: ReadonlyArray<{ name: string; selector: string; role: Role }> = [
  {
    name: BADGE,
    selector: '.sidebar__channel-badge',
    role: 'brand',
  },
  {
    name: 'readiness eyebrow',
    selector: '.readiness-panel__eyebrow',
    role: 'brand',
  },
  {
    name: 'readiness why link',
    selector: '.readiness-panel__why',
    role: 'action',
  },
  { name: 'trust eyebrow', selector: '.trust-panel__eyebrow', role: 'brand' },
  {
    name: 'trust evidence toggle',
    selector: '.trust-panel__claim-toggle',
    role: 'action',
  },
];

function renderSurfaces(): string {
  readinessState.data = {
    configured: true,
    generatedAt: '2026-06-12T00:00:00.000Z',
    overall: 'not-ready',
    requirements: [
      {
        id: 'evidence-check:npm-test',
        kind: 'evidence-check',
        label: 'npm test',
        status: 'satisfied',
        summary: 'Evidence checks passed',
        claimIds: [],
      },
    ],
    counts: {
      satisfied: 1,
      missing: 0,
      stale: 0,
      failing: 0,
      advisory: 0,
      recheckable: 0,
      accepted: 0,
    },
    trustReport: null,
  };
  bundlesState.data = [
    {
      id: 'bundle',
      fileName: 'bundle.json',
      path: '/ws/.station/trust-bundles/bundle.json',
      source: 'workspace',
      modifiedAt: '2026-06-12T01:00:00.000Z',
      valid: true,
      claimCount: 1,
      claimsByStatus: { verified: 1 },
      transparencyGapCount: 0,
    },
  ];
  reportState.data = {
    id: 'bundle',
    path: '/ws/.station/trust-bundles/bundle.json',
    source: 'workspace',
    modifiedAt: '2026-06-12T01:00:00.000Z',
    valid: true,
    report: {
      id: 'report-1',
      generatedAt: '2026-06-12T01:00:00.000Z',
      claims: [
        {
          id: 'claim-1',
          status: 'verified',
          claimType: 'review-outcome',
          fieldOrBehavior: 'candidate',
          subjectId: 'entry',
        },
      ],
      evidence: [],
      transparencyGaps: [],
      summary: { totalClaims: 1, byStatus: { verified: 1 } },
    },
  };

  const sidebar = render(
    <ProjectSidebarHeader
      appName="Station"
      homeLabel="Station"
      channelBadge="Nightly"
      collapsed={false}
      isMobile={false}
      onCloseMobile={() => {}}
      onGoHome={() => {}}
      onToggleCollapse={() => {}}
    />,
  );
  const readiness = render(<ReadinessPanel projectSlug="p" />);
  const trust = render(<TrustPanel projectSlug="p" />);
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  // The sidebar header sits directly on `.sidebar` in ProjectSidebar.
  const html = `<div class="sidebar">${sidebar.container.innerHTML}</div>${readiness.container.innerHTML}${trust.container.innerHTML}`;
  cleanup();
  return html;
}

/**
 * The two chat-dock resize handles: the real bottom-dock `<hr>` (its grip is
 * an `::after`) and the side-panel button as DockShell renders it. Each sits
 * in a `.chat-dock`, which supplies the surface behind the handle; the inline
 * styles only place the two docks apart on the page.
 */
function renderGrips(): string {
  const bottom = render(
    <ChatDockResizeHandle
      mode="desktop-free"
      snap="half"
      currentHeight={240}
      toolbarHeight={48}
      collapsedHeight={38}
      onSnap={() => {}}
      onCommitHeight={() => {}}
      onLiveHeight={() => {}}
      onDragStateChange={() => {}}
    />,
  );
  const html = `<div class="chat-dock" style="height:200px;right:320px">${bottom.container.innerHTML}</div><div class="chat-dock" style="top:0;bottom:auto;left:auto;right:0;width:300px;height:200px"><button type="button" tabindex="-1" class="chat-dock__resize-handle chat-dock__resize-handle--horizontal" aria-label="Resize panel"><span class="chat-dock__resize-grip chat-dock__resize-grip--vertical"></span></button></div>`;
  cleanup();
  return html;
}

/** The grips fade between states; measure the state, not a frame of the fade. */
const SETTLED = '*, *::after { transition: none !important; }';

interface GripSample {
  grip: string;
  state: string;
  focused: boolean;
  fill: string;
  background: string;
}

interface Sample {
  target: string;
  state: string;
  color: string;
  background: string;
  expected: string;
}

describe.skipIf(!chromiumAvailable)('channel colours painted as text', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let css: string;
  let markup: string;
  let gripMarkup: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    css = [
      '../index.css',
      '../components/project-sidebar/ProjectSidebar.css',
      '../components/readiness/ReadinessPanel.css',
      '../components/trust/TrustPanel.css',
    ]
      .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
      .join('\n');
    assertNoImportsSurvive(css);
    markup = renderSurfaces();
    gripMarkup = renderGrips();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function sample(
    mode: Mode,
    channel: Channel,
    inline: Record<string, string> = {},
  ): Promise<Sample[]> {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html data-theme="${mode}"><head><style>${css}</style></head><body>${markup}</body></html>`,
      );
      await page.addScriptTag({ content: MEASURE_HELPERS });
      await page.evaluate(
        ({ channel, inline }) => {
          const root = document.documentElement;
          if (channel === 'dev') root.classList.add('is-dev-build');
          else if (channel !== 'release') root.dataset.appChannel = channel;
          // How lib/branding-theme.ts applies a white-label theme.
          for (const [name, value] of Object.entries(inline))
            root.style.setProperty(name, value);
        },
        { channel, inline },
      );

      const read = (state: string) =>
        page.evaluate(
          ({ targets, state }) => {
            const rootStyle = getComputedStyle(document.documentElement);
            const token = (name: string) =>
              rootStyle.getPropertyValue(name).trim();
            const { rgba, hex, backdrop } = (
              window as unknown as {
                __contrast: {
                  rgba: (value: string) => number[];
                  hex: (color: number[]) => string;
                  backdrop: (element: Element) => string;
                };
              }
            ).__contrast;
            return targets.map(({ name, selector, role }) => {
              const element = document.querySelector(selector);
              if (!element) throw new Error(`missing ${selector}`);
              const brand = token('--k-brand');
              const expected =
                role === 'action' ? token('--k-action') || brand : brand;
              return {
                target: name,
                state,
                color: hex(rgba(getComputedStyle(element).color)),
                background: backdrop(element),
                expected: hex(rgba(expected)),
              };
            });
          },
          { targets: TARGETS, state },
        );

      const resting = await read('resting');
      // The badge sits inside the home button, which fills on hover.
      await page.hover('.sidebar__home-button');
      const hovered = (await read('hover')).filter(
        (entry) => entry.target === BADGE,
      );
      const samples = [...resting, ...hovered];
      // ProjectSidebar renders the badge only for a non-stable channel.
      return channel === 'release'
        ? samples.filter((entry) => entry.target !== BADGE)
        : samples;
    } finally {
      await page.close();
    }
  }

  const cases = (['release', 'dev', 'beta', 'nightly'] as const).flatMap(
    (channel) =>
      (['dark', 'light'] as const).map((mode) => [channel, mode] as const),
  );

  test.each(cases)(
    'the %s channel in %s mode paints readable text',
    async (channel, mode) => {
      const samples = await sample(mode, channel);
      expect(samples).toHaveLength(
        channel === 'release' ? TARGETS.length - 1 : TARGETS.length + 1,
      );
      for (const entry of samples) {
        // The surface paints the role it is meant to, so the ratio below is
        // about that role and not an inherited body colour.
        expect(entry.color, `${entry.target} (${entry.state})`).toBe(
          entry.expected,
        );
      }
      const failing = samples
        .map((entry) => ({
          ...entry,
          ratio: Number(
            contrastRatio(entry.color, entry.background).toFixed(2),
          ),
        }))
        .filter((entry) => entry.ratio < AA_TEXT);
      expect(failing).toEqual([]);
    },
  );

  // Every channel sets brand and action to one shade, so only a theme whose
  // brand and action differ shows which role each surface reads.
  test.each([
    ['dark', { brand: '#e08b2f', action: '#7983f4', onAction: '#06080b' }],
    ['light', { brand: '#98560c', action: '#4f5bd5', onAction: '#ffffff' }],
  ] as const)(
    'in %s mode, identity text follows the brand and links follow the action role',
    async (mode, theme) => {
      const samples = await sample(mode, 'release', {
        '--k-brand': theme.brand,
        '--k-action': theme.action,
        '--k-action-contrast': theme.onAction,
      });
      const painted = Object.fromEntries(
        samples.map((entry) => [entry.target, entry.color]),
      );
      expect(painted).toEqual({
        'readiness eyebrow': theme.brand,
        'readiness why link': theme.action,
        'trust eyebrow': theme.brand,
        'trust evidence toggle': theme.action,
      });
    },
  );

  // A white-label theme is applied inline on the root, so it outranks a
  // channel's stylesheet retint, including in a channel build.
  test('a white-label theme outranks the nightly retint on every surface', async () => {
    const theme = { brand: '#e08b2f', action: '#7983f4', onAction: '#06080b' };
    const samples = await sample('dark', 'nightly', {
      '--k-brand': theme.brand,
      '--k-action': theme.action,
      '--k-action-contrast': theme.onAction,
    });
    const painted = Object.fromEntries(
      samples
        .filter((entry) => entry.state === 'resting')
        .map((entry) => [entry.target, entry.color]),
    );
    expect(painted).toEqual({
      [BADGE]: theme.brand,
      'readiness eyebrow': theme.brand,
      'readiness why link': theme.action,
      'trust eyebrow': theme.brand,
      'trust evidence toggle': theme.action,
    });
  });

  async function sampleGrips(
    mode: Mode,
    channel: Channel,
  ): Promise<GripSample[]> {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      await page.setContent(
        `<!doctype html><html data-theme="${mode}"><head><style>${css}</style><style>${SETTLED}</style></head><body>${gripMarkup}</body></html>`,
      );
      await page.addScriptTag({ content: MEASURE_HELPERS });
      await page.evaluate((channel) => {
        const root = document.documentElement;
        if (channel === 'dev') root.classList.add('is-dev-build');
        else if (channel !== 'release') root.dataset.appChannel = channel;
      }, channel);

      const read = (grip: 'bottom' | 'side', state: string) =>
        page.evaluate(
          ({ grip, state }) => {
            const { rgba, hex, over, backdropRgba } = (
              window as unknown as {
                __contrast: {
                  rgba: (value: string) => number[];
                  hex: (color: number[]) => string;
                  over: (top: number[], bottom: number[]) => number[];
                  backdropRgba: (element: Element) => number[];
                };
              }
            ).__contrast;
            const handle = document.querySelector(
              grip === 'bottom'
                ? 'hr.chat-dock__resize-handle'
                : 'button.chat-dock__resize-handle',
            )!;
            const gripStyle =
              grip === 'bottom'
                ? getComputedStyle(handle, '::after')
                : getComputedStyle(handle.querySelector('span')!);
            const behind = backdropRgba(handle);
            const [r, g, b, a] = rgba(gripStyle.backgroundColor);
            // The grip's own alpha and opacity both let the backdrop through.
            const fill = over([r, g, b, a * Number(gripStyle.opacity)], behind);
            return {
              grip,
              state,
              focused: handle.matches(':focus-visible'),
              fill: hex(fill),
              background: hex(behind),
            };
          },
          { grip, state },
        );

      await page.hover('hr.chat-dock__resize-handle');
      const bottomHover = await read('bottom', 'hover');
      await page.hover('button.chat-dock__resize-handle');
      const sideHover = await read('side', 'hover');
      // Keyboard focus with the pointer away from the handle.
      await page.mouse.move(640, 700);
      await page.keyboard.press('Tab');
      const bottomFocus = await read('bottom', 'focus');
      return [bottomHover, sideHover, bottomFocus];
    } finally {
      await page.close();
    }
  }

  const gripCases = (['release', 'dev', 'beta', 'nightly'] as const).flatMap(
    (channel) =>
      (['dark', 'light'] as const).map((mode) => [channel, mode] as const),
  );

  test.each(gripCases)(
    'the %s channel in %s mode keeps the dock resize grips visible on hover and focus',
    async (channel, mode) => {
      const samples = await sampleGrips(mode, channel);
      // The focus sample is only a focus measurement if focus-visible holds.
      expect(samples.find((entry) => entry.state === 'focus')?.focused).toBe(
        true,
      );
      const failing = samples
        .map((entry) => ({
          ...entry,
          ratio: Number(contrastRatio(entry.fill, entry.background).toFixed(2)),
        }))
        .filter((entry) => entry.ratio < NON_TEXT);
      expect(failing).toEqual([]);
    },
  );
});
