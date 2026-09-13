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

/**
 * The classes C4 deleted, and every shape that still applies one.
 *
 * A BARE TOKEN inside any string literal, not a `className=` attribute: Biome
 * wraps a long class list onto its own lines, so the shape `StarterWorkCard`
 * itself used —
 *
 *   className={[
 *     'starter-work-card',
 *   ].join(' ')}
 *
 * has the attribute and the class on different lines, and an attribute-anchored
 * pattern sees neither. The same blindness covers `clsx('starter-work-card')`,
 * a `const CARD = 'starter-work-card'` indirection, and a ternary — the first
 * version of this used `[^=]*?` between the attribute and the name, which a
 * `===` inside the ternary terminates.
 *
 * Element and modifier forms count too (`__title`, `--loading`, `-btn`): the
 * rules that styled them are just as gone.
 *
 * `data-testid` is NOT a class. The browser journeys find these surfaces by
 * `data-testid="starter-work-card"` and friends, deliberately unchanged, so a
 * line carrying one is skipped whole.
 */
const RETIRED_CALLOUT_CLASSES = [
  'starter-work-card',
  'first-run-home-card',
  'project-page__chat-cta',
] as const;

const RETIRED_TOKEN = `(?<![\\w-])(?:${RETIRED_CALLOUT_CLASSES.join('|')})[\\w-]*`;
/** A bare token inside a string literal, wherever the literal sits. */
const APPLIED_IN_SOURCE = new RegExp(`['"\`][^'"\`]*${RETIRED_TOKEN}`);
/** A selector, including its element and modifier forms. */
const DECLARED_IN_CSS = new RegExp(`\\.${RETIRED_TOKEN}`);

function retiredCalloutClassOnLine(
  line: string,
  kind: 'source' | 'css',
): boolean {
  const trimmed = line.trim();
  // Whole-line comments only: the primitive's own source and stylesheet
  // explain by name which rules they carried over.
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  )
    return false;
  if (kind === 'source' && line.includes('data-testid=')) return false;
  return kind === 'css'
    ? DECLARED_IN_CSS.test(line)
    : APPLIED_IN_SOURCE.test(line);
}

describe('the retired-class matcher sees the shapes that actually occur', () => {
  // The matcher is the whole guard, and a guard whose rejection path has
  // never run is unproven — so it is fed the shapes before it is pointed at
  // the tree.
  test.each([
    ['a single-line attribute', `<div className="starter-work-card">`],
    [
      'a Biome-wrapped class array (the shape this card really used)',
      `    'starter-work-card',`,
    ],
    ['a helper call', `className={clsx('starter-work-card', x)}`],
    ['a const indirection', `const CARD = 'starter-work-card';`],
    [
      'a ternary whose condition contains ===',
      `className={mode === 'a' ? 'starter-work-card' : ''}`,
    ],
    // Backticks as the delimiter; the interpolation a real one would carry
    // is left out because it is a `${` inside a plain string here, which the
    // repo's own lint rule reads as a mistake.
    ['a template literal', 'className={`starter-work-card`}'],
    ['an element form', `<p className="starter-work-card__title">`],
    ['a modifier form', `className="starter-work-card--loading"`],
    ['the project CTA button form', `className="project-page__chat-cta-btn"`],
    ['the first-run card body', `className="first-run-home-card__body"`],
  ])('catches %s', (_label, line) => {
    expect(retiredCalloutClassOnLine(line, 'source')).toBe(true);
  });

  test.each([
    ['a test id', `<div data-testid="starter-work-card">`],
    [
      'a test id beside a live class',
      `<div data-testid="starter-work-card" className="page-callout">`,
    ],
    ['a line comment', `// starter-work-card is gone`],
    ['a block comment body', ` * .starter-work-card--loading, which found it`],
    ['an unrelated class', `className="page-callout page-callout--info"`],
    ['a longer unrelated token', `className="x-starter-work-cardigan"`],
  ])('does not catch %s', (_label, line) => {
    expect(retiredCalloutClassOnLine(line, 'source')).toBe(false);
  });

  test.each([
    ['a base selector', `.starter-work-card {`],
    ['an element selector', `.starter-work-card__title {`],
    ['a modifier selector', `.starter-work-card--loading > .skeleton-block {`],
    ['a nested selector', `  .project-page__chat-cta-text strong {`],
    ['a media-query body', `  .project-page__chat-cta {`],
  ])('catches %s in a stylesheet', (_label, line) => {
    expect(retiredCalloutClassOnLine(line, 'css')).toBe(true);
  });

  test('does not catch a stylesheet comment naming a carried-over rule', () => {
    expect(
      retiredCalloutClassOnLine(
        ' * `.starter-work-card--loading`, which found it).',
        'css',
      ),
    ).toBe(false);
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
   */
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
    });
  }

  test('nothing applies or declares a class C4 deleted', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(HERE, '../..'))) {
      // Tests still name these classes, on purpose: they are what proves the
      // migration happened, and the fixtures above are made of them.
      if (file.includes('__tests__')) continue;
      const kind = file.endsWith('.css') ? 'css' : 'source';
      for (const [index, line] of readFileSync(file, 'utf8')
        .split('\n')
        .entries()) {
        if (retiredCalloutClassOnLine(line, kind))
          offenders.push(`${file.split('/src-ui/')[1]}:${index + 1}`);
      }
    }
    expect(
      offenders,
      'a class C4 deleted from the stylesheets is still applied here',
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
