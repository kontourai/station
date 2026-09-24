/**
 * The shared `Toggle` track, measured against the surfaces it sits on (#2441).
 *
 * The off-state track used to be a `--border-primary` fill: well under the
 * 3:1 non-text minimum (WCAG 1.4.11) against every panel, and on/off differed
 * mainly by colour. #2425 fixed that for one switch in the Browser pane; #2441
 * folded the fix into the shared component. This spec is what makes the claim
 * falsifiable, and it has to run in a real browser: the property is a
 * computed colour after the cascade, custom properties and both theme blocks
 * have resolved, which jsdom does not compute.
 *
 * What is measured, per theme, backdrop, size, state and pointer (at rest
 * and hovered):
 * - off: the track's outline ring (an inset box-shadow) against the backdrop;
 * - on: the track's own fill against the backdrop;
 * - and that the thumb actually moves, so the states differ by more than
 *   colour.
 *
 * The measurement copies the track's paint onto a text probe in the same
 * backdrop and reuses `tests/helpers/color-contrast.ts`, so colour parsing
 * (`rgb()` vs `color(srgb …)`) and compositing have ONE implementation.
 *
 * Anti-inert guards: a renamed class or an unresolved token leaves the track
 * unpainted, which would otherwise measure as "no ring" or "transparent" and
 * either throw nowhere or compare the backdrop with itself. Each probe first
 * asserts the paint it is about to measure exists.
 *
 * Harness: the real `Toggle`, `SettingsToggle` and `BrowserAgentSettingsPanel`
 * source bundled with esbuild, and the real `src-ui/src/index.css` (which pulls
 * in both token layers) bundled alongside it — the same technique as
 * `banner-stack-bound.spec.ts`. No live instance or server.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import { contrastRatio } from './helpers/color-contrast';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const THEMES = ['light', 'dark'] as const;

/**
 * Surfaces a Toggle renders on: the page, panels, raised panels, modals
 * (JobFormModal), and the elevated/hover fills of settings rows and menus.
 */
const BACKDROPS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-modal',
  '--bg-elevated',
  '--bg-hover',
];

/** WCAG 1.4.11 non-text contrast. */
const NON_TEXT_MIN = 3;

const HARNESS_SOURCE = `
import './src-ui/src/index.css';
import './src-ui/src/views/page-layout.css';
import './src-ui/src/views/SettingsView.css';
import './src-ui/src/workspace-panes/browser-pane/BrowserPane.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toggle } from './src-ui/src/components/Toggle';
import { SettingsToggle } from './src-ui/src/views/settings/feature-toggle';
import { PageRow } from './src-ui/src/components/PageRow';
import { BrowserAgentSettingsPanel } from './src-ui/src/workspace-panes/browser-pane/BrowserAgentSettingsPanel';

function Row({ label, initial, size }) {
  const [checked, setChecked] = useState(initial);
  return (
    <div data-testid={'row-' + label} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 8 }}>
      <Toggle checked={checked} onChange={setChecked} label={label} size={size} />
      <span>{label}</span>
    </div>
  );
}

function Feature({ label, initial }) {
  const [checked, setChecked] = useState(initial);
  return (
    <SettingsToggle
      className="settings__feature-toggle"
      checked={checked}
      label={label}
      onChange={() => setChecked((v) => !v)}
    >
      <div>
        <div className="settings__toggle-name">Voice input</div>
        <div className="settings__toggle-detail">Dictate messages with the microphone.</div>
      </div>
    </SettingsToggle>
  );
}

// Settings, registry-row, ApprovalGuardianEditor and FeaturePreviewsSection
// all place a Toggle as a PageRow control.
function PageRowToggle({ label, initial }) {
  const [checked, setChecked] = useState(initial);
  return (
    <PageRow
      title={label}
      description="A setting row whose control is the shared switch."
      control={<Toggle checked={checked} onChange={setChecked} label={label} />}
    />
  );
}

let browserEvaluate = false;
const api = {
  settings: async () => ({ browserEvaluate }),
  setBrowserEvaluate: async (_slug, next) => {
    browserEvaluate = next;
    return { browserEvaluate };
  },
};

function Gallery() {
  return (
    <div>
      <Row label="md off" initial={false} size="md" />
      <Row label="md on" initial={true} size="md" />
      <Row label="sm off" initial={false} size="sm" />
      <Row label="sm on" initial={true} size="sm" />
      <Feature label="Feature off" initial={false} />
      <Feature label="Feature on" initial={true} />
      <PageRowToggle label="Row off" initial={false} />
      <PageRowToggle label="Row on" initial={true} />
      <div className="browser-pane" style={{ height: 'auto' }}>
        <BrowserAgentSettingsPanel apiBase="" api={api} projectSlug="alpha" />
      </div>
    </div>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><Gallery /></QueryClientProvider>,
);
`;

let harnessScript = '';
let harnessStyles = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HARNESS_SOURCE, resolveDir: REPO_ROOT, loader: 'tsx' },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // Fonts and favicons do not affect any colour measured here. Root-absolute
    // ones are served by the app, and the vendor's relative font files are
    // emptied rather than inlined.
    external: ['/fonts/*', '/favicon-*'],
    loader: { '.woff2': 'empty', '.woff': 'empty' },
    write: false,
    outdir: 'toggle-contrast-harness',
    platform: 'browser',
    logLevel: 'silent',
  });
  for (const file of result.outputFiles) {
    if (file.path.endsWith('.js')) harnessScript = file.text;
    if (file.path.endsWith('.css')) harnessStyles = file.text;
  }
  expect(harnessScript.length, 'harness JS bundled').toBeGreaterThan(0);
  expect(
    harnessStyles,
    'the real Toggle.css must be in the bundled stylesheet',
  ).toContain('.station-toggle__thumb');
});

async function mount(page: Page, theme: (typeof THEMES)[number]) {
  await page.setContent(
    `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0"><div id="host" style="padding:16px;color:var(--text-primary)"><div id="root"></div><span data-testid="paint-probe">Probe</span></div></body></html>`,
  );
  await page.addStyleTag({ content: harnessStyles });
  // A reading taken mid-transition reports the previous state's colour.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; }',
  });
  await page.addScriptTag({ content: harnessScript });
  await expect(page.getByRole('switch', { name: 'md off' })).toBeVisible();
  await expect(
    page.getByRole('switch', {
      name: "Let agents run JavaScript in this Project's pages",
    }),
  ).toBeVisible();
}

async function setBackdrop(page: Page, token: string) {
  await page.evaluate((value) => {
    const host = document.getElementById('host') as HTMLElement;
    host.style.background = `var(${value})`;
  }, token);
}

/**
 * Measure one switch's track against the surface actually behind it.
 *
 * The track is the switch itself for `Toggle`, or the `.station-toggle` span
 * inside the row-sized switch button for the Settings feature rows. Its paint
 * is its outline ring (an inset box-shadow) when it has one, otherwise its
 * fill — read the same way for both states, so a regression to the old filled
 * off-track is measured as a fill rather than silently skipped.
 *
 * Both sides are composited on a canvas (which parses every CSS colour form
 * the browser does) before measuring, because the shared helper ignores a
 * foreground's alpha: `--border-primary` is a translucent tint, and measured
 * as opaque the old off-track read as a strong dark line and passed. The
 * backdrop is the track's OWN ancestor chain — a row button or pane panel
 * that paints its own surface is what the track is seen against, not the
 * page. The opaque results go on the probe (text colour and own background)
 * so `contrastRatio` does the luminance maths.
 *
 * Returns null when the track paints nothing, which the caller turns into an
 * anti-inert failure.
 */
async function measureTrack(
  page: Page,
  name: string,
): Promise<{ paint: string; ratio: number } | null> {
  const paint = await page.getByRole('switch', { name }).evaluate((el) => {
    const track = el.matches('.station-toggle')
      ? el
      : el.querySelector('.station-toggle');
    if (!track) return null;
    const style = getComputedStyle(track);
    const ring = /^((?:rgba?|color)\([^)]*\))/.exec(style.boxShadow ?? '');
    if (ring) return ring[1];
    const bg = style.backgroundColor;
    return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? null : bg;
  });
  if (paint === null) return null;
  await page.getByRole('switch', { name }).evaluate(compositeOntoProbe, paint);
  return { paint, ratio: await contrastRatio(page.getByTestId('paint-probe')) };
}

/**
 * Put the track's composited backdrop and composited paint on the probe as
 * opaque colours. Runs in the page; must not close over module scope.
 */
function compositeOntoProbe(el: Element, paint: string): void {
  const track = el.matches('.station-toggle')
    ? el
    : (el.querySelector('.station-toggle') as Element);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const paintOver = (colour: string) => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
  };
  const read = () => {
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  // The browser canvas behind an unpainted document is white.
  paintOver('#fff');
  const chain: Element[] = [];
  for (let node = track.parentElement; node; node = node.parentElement) {
    chain.unshift(node);
  }
  for (const node of chain) paintOver(getComputedStyle(node).backgroundColor);
  const backdrop = read();
  paintOver(paint);
  const probe = document.querySelector(
    '[data-testid="paint-probe"]',
  ) as HTMLElement;
  probe.style.background = backdrop;
  probe.style.color = read();
}

/**
 * Measure one switch's track against the current backdrop and assert 3:1.
 * Returns the reading for the annotation.
 */
async function assertTrackContrast(
  page: Page,
  {
    theme,
    backdrop,
    name,
    pointer,
  }: {
    theme: string;
    backdrop: string;
    name: string;
    pointer: 'rest' | 'hover';
  },
): Promise<string> {
  if (pointer === 'hover') {
    await page.getByRole('switch', { name }).hover();
  } else {
    await page.mouse.move(0, 0);
  }
  const measured = await measureTrack(page, name);
  expect(
    measured,
    `${name} (${pointer}) in ${theme} on ${backdrop}: the track paints nothing to measure — the rule stopped matching or its token is undefined`,
  ).not.toBeNull();
  const { paint, ratio } = measured as { paint: string; ratio: number };
  expect(
    ratio,
    `${name} track (${pointer}) on ${backdrop} in ${theme} theme (WCAG 1.4.11 non-text, paint ${paint})`,
  ).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  return `${theme} ${backdrop} ${name} ${pointer}: ${paint} ${ratio.toFixed(2)}:1`;
}

const BROWSER_PANE_SWITCH = "Let agents run JavaScript in this Project's pages";

/**
 * The four bare shapes; the Settings feature rows, whose track is a span
 * inside a row-sized switch button that paints its own surface; two PageRow
 * controls; and the Browser pane's switch in its real pane markup and
 * stylesheet — the consumer #2425 fixed locally, so the one most likely to be
 * broken by a pane rule outranking the shared one.
 */
const SWITCHES = [
  'md off',
  'md on',
  'sm off',
  'sm on',
  'Feature off',
  'Feature on',
  'Row off',
  'Row on',
  BROWSER_PANE_SWITCH,
] as const;

test.describe('shared Toggle track contrast (#2441)', () => {
  test('both states of both sizes clear 3:1 non-text contrast on every surface, both themes', async ({
    page,
  }) => {
    const readings: string[] = [];
    for (const theme of THEMES) {
      await mount(page, theme);
      for (const backdrop of BACKDROPS) {
        await setBackdrop(page, backdrop);
        for (const name of SWITCHES) {
          // At rest and under the pointer: the global `button:hover` repaints
          // every button, and a hovered ON track once lost its fill to it.
          for (const pointer of ['rest', 'hover'] as const) {
            readings.push(
              await assertTrackContrast(page, {
                theme,
                backdrop,
                name,
                pointer,
              }),
            );
          }
        }
      }
    }
    test.info().annotations.push({
      type: 'contrast',
      description: readings.join('\n'),
    });
  });

  test('on and off differ by more than colour: fill style and thumb position both change', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await mount(page, theme);
      for (const size of ['md', 'sm'] as const) {
        const off = page.getByRole('switch', { name: `${size} off` });
        const on = page.getByRole('switch', { name: `${size} on` });
        const [offFill, onFill, offRing, onRing] = await Promise.all([
          off.evaluate((el) => getComputedStyle(el).backgroundColor),
          on.evaluate((el) => getComputedStyle(el).backgroundColor),
          off.evaluate((el) => getComputedStyle(el).boxShadow),
          on.evaluate((el) => getComputedStyle(el).boxShadow),
        ]);
        // Off is an outline (no fill, a ring); on is a fill (no ring).
        expect(offFill, `${size} off track is unfilled`).toBe(
          'rgba(0, 0, 0, 0)',
        );
        expect(offRing, `${size} off track is outlined`).not.toBe('none');
        expect(onFill, `${size} on track is filled`).not.toBe(
          'rgba(0, 0, 0, 0)',
        );
        expect(onRing, `${size} on track has no outline`).toBe('none');

        const thumbOffset = (sw: typeof off) =>
          sw.evaluate((el) => {
            const thumb = el.querySelector('.station-toggle__thumb');
            const track = el.getBoundingClientRect();
            const knob = (thumb as Element).getBoundingClientRect();
            return knob.left - track.left;
          });
        const [offX, onX] = await Promise.all([
          thumbOffset(off),
          thumbOffset(on),
        ]);
        expect(
          onX - offX,
          `${size} thumb moves right when on (${offX}px → ${onX}px)`,
        ).toBeGreaterThanOrEqual(size === 'md' ? 16 : 12);
      }
    }
  });

  test('keeps its track size, so consumers laid out around it do not reflow', async ({
    page,
  }) => {
    await mount(page, 'dark');
    for (const [name, width, height] of [
      ['md off', 36, 20],
      ['md on', 36, 20],
      ['sm off', 28, 16],
      ['sm on', 28, 16],
    ] as const) {
      const box = await page.getByRole('switch', { name }).boundingBox();
      expect(box?.width, `${name} width`).toBe(width);
      expect(box?.height, `${name} height`).toBe(height);
    }
  });

  test('at 390px the Browser pane switch keeps its state word, fits, and has a 44px hit area', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of THEMES) {
      await mount(page, theme);
      const sw = page.getByRole('switch', {
        name: "Let agents run JavaScript in this Project's pages",
      });
      const word = page.locator('.browser-pane .station-toggle__state');
      await expect(word).toHaveText('Off');
      await expect(word).toHaveAttribute('aria-hidden', 'true');
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'true');
      await expect(word).toHaveText('On');
      const box = await sw.boundingBox();
      expect(box, 'switch is laid out').not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
      const hit = await sw.evaluate((el) => {
        const before = getComputedStyle(el, '::before');
        return {
          width: Number.parseFloat(before.width),
          height: Number.parseFloat(before.height),
        };
      });
      expect(hit.width, 'mobile hit area width').toBeGreaterThanOrEqual(44);
      expect(hit.height, 'mobile hit area height').toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        'no horizontal page scroll at 390px',
      ).toBe(true);
    }
  });
  /**
   * `page-layout.css` gives every PageRow control button a 44px min-height
   * below 640px. Applied to a switch, that stretched the 36x20 track into a
   * 36x44 upright oval on phones. The touch target belongs to the Toggle's
   * own `::before`, so the track must keep its size and the target must still
   * reach 44px around it.
   */
  test('at 390px a PageRow switch keeps its 36x20 track and a 44px hit area', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of THEMES) {
      await mount(page, theme);
      for (const name of ['Row off', 'Row on']) {
        const sw = page.getByRole('switch', { name });
        const box = await sw.boundingBox();
        expect(box?.width, `${name} track width at 390px`).toBe(36);
        expect(box?.height, `${name} track height at 390px`).toBe(20);
        // Hit-test the real target: points 20px out from the centre on each
        // axis land on the switch only if its ::before target reaches them.
        const hits = await sw.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          return [
            [cx, cy - 20],
            [cx, cy + 20],
            [cx - 20, cy],
            [cx + 20, cy],
          ].map(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return hit === el || el.contains(hit);
          });
        });
        expect(hits, `${name} 44px hit area around the track`).toEqual([
          true,
          true,
          true,
          true,
        ]);
      }
    }
  });
});

type ForcedTrack = {
  fill: string;
  borderStyle: string;
  borderWidth: number;
  borderColor: string;
  thumb: string;
  thumbX: number;
  width: number;
  height: number;
};

function readForcedTrack(page: Page, name: string): Promise<ForcedTrack> {
  return page.getByRole('switch', { name }).evaluate((el) => {
    const s = getComputedStyle(el);
    const thumb = el.querySelector('.station-toggle__thumb') as Element;
    const r = el.getBoundingClientRect();
    return {
      fill: s.backgroundColor,
      borderStyle: s.borderTopStyle,
      borderWidth: Number.parseFloat(s.borderTopWidth),
      borderColor: s.borderTopColor,
      thumb: getComputedStyle(thumb).backgroundColor,
      thumbX: thumb.getBoundingClientRect().left - r.left,
      width: r.width,
      height: r.height,
    };
  });
}

/** Each state keeps an edge, a thumb that differs from its fill, and its size. */
function assertForcedTrackShape(
  size: 'md' | 'sm',
  state: 'off' | 'on',
  v: ForcedTrack,
): void {
  expect(v.borderStyle, `${size} ${state} track has an edge`).toBe('solid');
  expect(v.borderWidth, `${size} ${state} edge width`).toBeGreaterThanOrEqual(
    1,
  );
  expect(v.thumb, `${size} ${state} thumb is painted`).not.toBe(v.fill);
  expect(v.width, `${size} ${state} width`).toBe(size === 'md' ? 36 : 28);
  expect(v.height, `${size} ${state} height`).toBe(size === 'md' ? 20 : 16);
}

/**
 * Forced colors (Windows High Contrast) drop box-shadow and repaint every
 * background as Canvas, so before #2441's forced-colors block the outlined
 * off track and the filled on track rendered identically.
 */
test.describe('shared Toggle under forced colors (#2441)', () => {
  test('off and on stay distinguishable and the track keeps a visible edge', async ({
    page,
  }) => {
    // Emulated on the page: a describe-level `test.use({ forcedColors })`
    // did not reach this project's context (the guard below caught it).
    await page.emulateMedia({ forcedColors: 'active' });
    for (const theme of THEMES) {
      await mount(page, theme);
      expect(
        await page.evaluate(
          () => matchMedia('(forced-colors: active)').matches,
        ),
        'forced colors are active in this context',
      ).toBe(true);
      for (const size of ['md', 'sm'] as const) {
        const off = await readForcedTrack(page, `${size} off`);
        const on = await readForcedTrack(page, `${size} on`);
        assertForcedTrackShape(size, 'off', off);
        assertForcedTrackShape(size, 'on', on);
        expect(
          off.borderColor,
          `${size} off edge differs from its fill`,
        ).not.toBe(off.fill);
        expect(on.fill, `${size} on and off fills differ`).not.toBe(off.fill);
        expect(on.thumb, `${size} on and off thumbs differ`).not.toBe(
          off.thumb,
        );
        expect(
          on.thumbX - off.thumbX,
          `${size} thumb moves when on`,
        ).toBeGreaterThanOrEqual(size === 'md' ? 16 : 12);
      }
    }
  });
});
