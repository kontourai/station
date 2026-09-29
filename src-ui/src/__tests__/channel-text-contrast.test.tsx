/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { hexContrast } from '../lib/branding-theme';

/**
 * #2905: the release channels paint their brand as TEXT — the sidebar channel
 * badge and the kit's `.eyebrow` in the Readiness and Trust panels — and the
 * panels' "Why" and "Evidence" links paint an accent colour on raised rows.
 * This renders the real components, puts their markup in Chromium under the
 * real stylesheets, and measures each text colour against the background it
 * actually sits on, for every channel in both modes. The rule-level check of
 * the channel values lives in `branding-role-cascade.test.ts`; this one
 * catches a surface the rules do not model (the raised rows, a hover fill).
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

import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';
import { ReadinessPanel } from '../components/readiness/ReadinessPanel';
import { TrustPanel } from '../components/trust/TrustPanel';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

/** Same shim as branding-role-cascade.test.ts: the roles @kontourai/ui 1.14 adds. */
const VENDOR_ROLES_SHIM = `
:root { --k-action: #5ce0c6; --k-action-contrast: #06080b; --k-focus: #5ce0c6; --k-focus-ring: var(--k-focus); }
[data-theme="light"] { --k-action: #0e7c64; --k-action-contrast: #ffffff; --k-focus: #0e7c64; --k-focus-ring: var(--k-focus); }
`;

const AA_TEXT = 4.5;

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
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function sample(
    mode: Mode,
    channel: Channel,
    vendorRoles: boolean,
  ): Promise<Sample[]> {
    const page = await browser.newPage();
    try {
      const shim = vendorRoles ? `<style>${VENDOR_ROLES_SHIM}</style>` : '';
      await page.setContent(
        `<!doctype html><html data-theme="${mode}"><head>${shim}<style>${css}</style></head><body>${markup}</body></html>`,
      );
      await page.evaluate((channel) => {
        const root = document.documentElement;
        if (channel === 'dev') root.classList.add('is-dev-build');
        else if (channel !== 'release') root.dataset.appChannel = channel;
      }, channel);

      const read = (state: string) =>
        page.evaluate(
          ({ targets, state }) => {
            const rootStyle = getComputedStyle(document.documentElement);
            const token = (name: string) =>
              rootStyle.getPropertyValue(name).trim();
            // Resolve any CSS colour (including color-mix output) to rgba.
            const probe = document.createElement('canvas').getContext('2d')!;
            const rgba = (value: string): [number, number, number, number] => {
              probe.clearRect(0, 0, 1, 1);
              probe.fillStyle = '#000';
              probe.fillStyle = value;
              probe.fillRect(0, 0, 1, 1);
              const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
              return [r, g, b, a / 255];
            };
            const hex = ([r, g, b]: number[]) =>
              `#${[r, g, b]
                .map((n) => Math.round(n).toString(16).padStart(2, '0'))
                .join('')}`;
            // The painted backdrop: composite each ancestor's fill, nearest
            // first, until an opaque one. A background image would make the
            // measurement meaningless, so it is refused, not ignored.
            const backdrop = (element: Element): string => {
              let color = [0, 0, 0, 0];
              for (
                let node: Element | null = element;
                node;
                node = node.parentElement
              ) {
                const style = getComputedStyle(node);
                if (style.backgroundImage !== 'none')
                  throw new Error(
                    `background image behind text: ${node.className}`,
                  );
                const [r, g, b, a] = rgba(style.backgroundColor);
                const alpha = color[3] + a * (1 - color[3]);
                if (alpha > 0)
                  color = [0, 1, 2].map(
                    (i) =>
                      (color[i] * color[3] +
                        [r, g, b][i] * a * (1 - color[3])) /
                      alpha,
                  );
                color[3] = alpha;
                if (alpha >= 0.999) return hex(color);
              }
              throw new Error(`no opaque backdrop for ${element.className}`);
            };
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
      (['dark', 'light'] as const).flatMap((mode) =>
        [false, true].map(
          (vendorRoles) => [channel, mode, vendorRoles] as const,
        ),
      ),
  );

  test.each(cases)(
    'the %s channel in %s mode (vendor roles: %s) paints readable text',
    async (channel, mode, vendorRoles) => {
      const samples = await sample(mode, channel, vendorRoles);
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
          ratio: Number(hexContrast(entry.color, entry.background).toFixed(2)),
        }))
        .filter((entry) => entry.ratio < AA_TEXT);
      expect(failing).toEqual([]);
    },
  );
});
