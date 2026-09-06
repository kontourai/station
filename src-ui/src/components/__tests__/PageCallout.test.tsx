/** @vitest-environment jsdom */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  dedupePageCallouts,
  PageCallout,
  PageCalloutStack,
} from '../PageCallout';

const HERE = dirname(fileURLToPath(import.meta.url));
const readCss = (relative: string) =>
  readFileSync(resolve(HERE, relative), 'utf8');

describe('PageCallout', () => {
  test('names its region, carries its identity, and keeps title above body', () => {
    render(
      <PageCallout
        calloutId="first-run-setup"
        ariaLabel="Finish setting up Station"
        title="Finish setting up Station"
        action={<button type="button">Set up Station</button>}
      >
        Two minutes.
      </PageCallout>,
    );

    const callout = screen.getByLabelText('Finish setting up Station');
    expect(callout.getAttribute('data-callout-id')).toBe('first-run-setup');
    expect(callout.className).toContain('page-callout--info');
    // The title is a <p>, not a heading: a callout renders above its page's
    // own <h1>, where a heading either outranks it or lands out of order.
    expect(callout.querySelector('.page-callout__title')?.tagName).toBe('P');
    expect(callout.textContent).toContain('Two minutes.');
    expect(screen.getByRole('button', { name: 'Set up Station' })).toBeTruthy();
  });

  test.each([
    ['info', 'page-callout--info'],
    ['warning', 'page-callout--warning'],
    ['error', 'page-callout--error'],
    ['blocked', 'page-callout--blocked'],
  ] as const)('renders the %s tone of the banner scale', (tone, expected) => {
    render(
      <PageCallout calloutId={`c-${tone}`} ariaLabel={`c ${tone}`} tone={tone}>
        body
      </PageCallout>,
    );
    expect(screen.getByLabelText(`c ${tone}`).className).toContain(expected);
  });
});

describe('the tone scale is shared with banners, not copied', () => {
  // A structural rule, proved structurally: the only observable difference
  // between "both files resolve one custom property" and "both files happen
  // to spell the same `color-mix` today" is in the stylesheets themselves,
  // and jsdom cannot compute `color-mix` to tell them apart. What this
  // forbids is a page callout growing its own literal for a tone the banner
  // host already defines — which is exactly how the three cards C4 replaced
  // ended up with three different borders.
  const calloutCss = readCss('../PageCallout.css');
  const bannerCss = readCss('../notifications/BannerHost.css');
  const rootCss = readCss('../../index.css');

  test.each(['info', 'warning', 'error'])(
    'the --tone-border-%s property is declared once, at the root',
    (tone) => {
      const declarations = rootCss.match(
        new RegExp(`--tone-border-${tone}\\s*:`, 'g'),
      );
      expect(
        declarations,
        `--tone-border-${tone} is not declared`,
      ).toHaveLength(1);
    },
  );

  test('both surfaces read the tone properties rather than their own colours', () => {
    for (const tone of ['info', 'warning', 'error']) {
      expect(
        calloutCss.includes(`var(--tone-border-${tone})`),
        `PageCallout.css does not resolve --tone-border-${tone}`,
      ).toBe(true);
      expect(
        bannerCss.includes(`var(--tone-border-${tone})`),
        `BannerHost.css does not resolve --tone-border-${tone}`,
      ).toBe(true);
    }
    // The reverse direction: a tone border written as a literal in either
    // file is a second scale, whatever it currently evaluates to.
    for (const [name, css] of [
      ['PageCallout.css', calloutCss],
      ['BannerHost.css', bannerCss],
    ] as const) {
      expect(
        /border(-color)?:[^;]*color-mix\([^;]*--(warning-text|error-text|accent-primary)/.test(
          css,
        ),
        `${name} still writes a tone border colour of its own`,
      ).toBe(false);
    }
  });
});

describe('the cards C4 replaced leave nothing behind', () => {
  /**
   * The defect this exists for, found in review: `HomeView.css` deleted
   * `.starter-work-card` and its `--loading > .skeleton-block` rule, and two
   * OTHER Home cards were still rendering that class — so on a completed home
   * with developer tools on they silently lost their border, their radius and
   * their row layout, and the skeleton-collapse fix came back. A deleted rule
   * with a live consumer is invisible to every per-component test, because
   * each one still renders exactly what its author wrote.
   *
   * A structural rule, checked structurally: no source names a class no
   * stylesheet defines. Comment lines are excluded — the primitive's own CSS
   * explains which rules it carried over by name.
   */
  const RETIRED = [
    'starter-work-card',
    'first-run-home-card',
    'project-page__chat-cta',
  ];

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
    });
  }

  test.each(RETIRED)('nothing renders or styles %s any more', (name) => {
    // CLASS uses only. `data-testid="starter-work-card"` and friends are
    // deliberately unchanged — the browser journeys find these surfaces by
    // them, and a test id is not a style.
    const styled = new RegExp(`\\.${name}(?![\\w-])`);
    const applied = new RegExp(`(className|class)\\s*=[^=]*?${name}(?![\\w-])`);
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(HERE, '../..'))) {
      // Tests still name these classes, on purpose: they are what proves the
      // migration happened.
      if (file.includes('__tests__')) continue;
      const isStylesheet = file.endsWith('.css');
      for (const [index, line] of readFileSync(file, 'utf8')
        .split('\n')
        .entries()) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        )
          continue;
        if (isStylesheet ? styled.test(line) : applied.test(line))
          offenders.push(`${file.split('/src-ui/')[1]}:${index + 1}`);
      }
    }
    expect(
      offenders,
      `${name} was deleted from the stylesheets but is still applied here`,
    ).toEqual([]);
  });
});

describe('a stack is dedupable', () => {
  test('shows one callout per id, in the order it was given them', () => {
    render(
      <PageCalloutStack>
        <PageCallout calloutId="starter-work" ariaLabel="first">
          first
        </PageCallout>
        <PageCallout calloutId="other" ariaLabel="other">
          other
        </PageCallout>
        <PageCallout calloutId="starter-work" ariaLabel="second">
          second
        </PageCallout>
      </PageCalloutStack>,
    );

    expect(
      document.querySelectorAll('[data-callout-id="starter-work"]'),
      'the same callout rendered twice in one stack',
    ).toHaveLength(1);
    expect(screen.getByLabelText('first')).toBeTruthy();
    expect(screen.queryByLabelText('second')).toBeNull();
    expect(screen.getByLabelText('other')).toBeTruthy();
  });

  test('passes through everything that is not an identified callout', () => {
    // A stack holds whatever the page puts in it. Home's own stack is handed
    // two COMPONENTS, each of which may or may not render a callout, and
    // dropping either of those would take the surface off the page.
    const child = <div data-testid="not-a-callout">x</div>;
    const kept = dedupePageCallouts([child, null, child, undefined]);
    expect(kept).toEqual([child, null, child, undefined]);
  });
});
