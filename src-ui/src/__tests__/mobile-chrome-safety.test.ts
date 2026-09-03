import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ACTIVITY_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { describe, expect, it, vi } from 'vitest';
import {
  isDockOwnedViewType,
  isMobileDockFullscreen,
  MOBILE_DOCK_OCCUPANT_PICKER_QUERY,
  shouldMaximizeAfterDockingAsOnlyContent,
  shouldMaximizeOnOccupantChoice,
} from '../components/chat-dock/mobile-chrome';
import {
  ambientDockOccupantRouteViewType,
  chooseAmbientOccupant,
} from '../workspace-panes/ambientDockOccupants';
import { ruleBodiesFor } from './helpers/css-rules';

/**
 * Shell chrome sits outside the flow of any view, so nothing else can correct
 * its geometry. On an edge-to-edge Android webview the banner slot's fixed
 * height clipped the tail of stacked notices (archive#2213).
 *
 * These are CSS-shaped assertions for the same reason the toolbar's are: the
 * geometry is authored in stylesheets, and jsdom does not lay them out.
 */

const UI_SRC = join(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(UI_SRC, relativePath), 'utf-8');
}

/** The shell's mobile breakpoint, defined in index.css. */
const SHELL_MOBILE_QUERY =
  '@media (max-width: 768px), (max-height: 540px) and (pointer: coarse)';

const BANNER_CSS = 'components/notifications/BannerHost.css';
const NOTIFICATION_CSS = 'components/notifications/NotificationContainer.css';

function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'g',
  );
  for (const match of css.matchAll(pattern)) bodies.push(match[1]);
  return bodies;
}

describe('the connection banner slot bounds without reserving', () => {
  it('overlays below the toolbar instead of occupying a layout row (station#3308)', () => {
    // Contract change from the in-flow rail: the host is absolutely
    // positioned, so presenting a banner never reflows `.main-content`, and
    // its top offset starts below the toolbar's interactive controls
    // (`--app-toolbar-total-height` carries the safe-area inset and drops to
    // it when the toolbar is hidden), so collapsed banners cannot cover them
    // (#2343).
    const [host] = ruleBodies(read(BANNER_CSS), '.banner-host');
    expect(host).toMatch(/position:\s*absolute/);
    expect(host).toMatch(/top:\s*var\(--app-toolbar-total-height/);
    expect(host).toMatch(/z-index:\s*var\(--layer-notice\)/);
    expect(host).toMatch(/pointer-events:\s*none/);
  });

  it('keeps the overlay out of the chat dock in every side-dock state', () => {
    // The overlay and `.chat-dock` are siblings in one stacking context and
    // the dock owns the higher named layer, so a full-width overlay put its
    // own controls underneath it. Browser proof lives in
    // tests/connect-reconnect-banner.spec.ts; this only guards deletion.
    const css = read(BANNER_CSS);
    for (const rule of [
      '.app__main:has(> [data-region="right"]) > .banner-host',
      '.app__main:has(> [data-region="right"].is-collapsed) > .banner-host',
      '.app__main:has(> [data-region="left"]) > .banner-host',
      '.app__main:has(> [data-region="left"].is-collapsed) > .banner-host',
    ]) {
      const [body] = ruleBodies(css, rule);
      expect(body, `missing rule: ${rule}`).toBeDefined();
      expect(body).toMatch(
        /(left|right):\s*(var\(--region-(left|right)-size|36px)/,
      );
    }
    // Maximized is the active full work surface. Its occupant header/search
    // must remain reachable, so ordinary notices return below the dock.
    const [maximized] = ruleBodies(
      css,
      '.app__main:has(> .chat-dock.is-maximized) > .banner-host',
    );
    expect(maximized).toBeDefined();
    expect(maximized).toMatch(/z-index:\s*var\(--layer-notice\)/);
    expect(maximized).not.toMatch(/var\(--layer-dock\)/);
    expect(maximized).toMatch(/left:\s*0/);
    expect(maximized).toMatch(/right:\s*0/);

    // Critical chrome is the narrow exception: blocking pairing/credential
    // states and explicitly critical sources must remain discoverable while
    // the dock is maximized. Ordinary hosts do not match this selector.
    const [critical] = ruleBodiesFor(
      css,
      '.app__main:has(> .chat-dock.is-maximized) > .banner-host.banner-host--critical-chrome',
    );
    expect(critical).toBeDefined();
    expect(critical).toMatch(/z-index:\s*auto/);
    const [criticalCard] = ruleBodiesFor(
      css,
      '.app__main:has(> .chat-dock.is-maximized) > .banner-host.banner-host--critical-chrome :is(.banner-host__item--critical-chrome, .banner-host__cap--critical-chrome)',
    );
    expect(criticalCard).toBeDefined();
    expect(criticalCard).toMatch(
      /z-index:\s*calc\(var\(--layer-dock\)\s*\+\s*1\)/,
    );
  });

  it('gives a maximized bottom dock one full remaining viewport row', () => {
    const css = read('index.css');
    const [main] = ruleBodies(
      css,
      '.app__main:has(> [data-region="bottom"].is-maximized)',
    );
    expect(main).toBeDefined();
    expect(main).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);

    const [dock] = ruleBodies(
      css,
      '.app__main > [data-region="bottom"].is-maximized',
    );
    expect(dock).toBeDefined();
    expect(dock).toMatch(/grid-row:\s*2\s*;/);
    expect(dock).not.toMatch(/grid-row:\s*2\s*\/\s*-1/);
  });

  it('outranks a bottom-sheet dock, where no column exists to inset into', () => {
    // The side-dock insets have nothing to bite on when the dock spans the
    // full width under the content — a bottom dock on desktop, and EVERY dock
    // mode on mobile — and the resize handle leaves no reliable band above it
    // either (854px of 900, measured live). Browser proof for the desktop half
    // lives in tests/connect-reconnect-banner.spec.ts; this guards deletion.
    const css = read(BANNER_CSS);
    for (const rule of [
      '.app__main:has(> [data-region="bottom"]) > .banner-host',
      '.app__main > .banner-host',
    ]) {
      const [body] = ruleBodies(css, rule);
      expect(body, `missing rule: ${rule}`).toBeDefined();
      expect(body).toMatch(/z-index:\s*calc\(var\(--layer-dock\)\s*\+\s*1\)/);
    }
    // The escalation must stay paired with a size cap, or "outranks the dock"
    // becomes "owns the screen". archive#3432: the bound lives on the inner
    // `.banner-host__stack`, not on `.banner-host` itself — see the next test
    // for why. Precisely: this bounds `.banner-host__stack` (the scrollable
    // card list), not the host's own box — the host also carries the cap
    // button plus the host's own gap/padding outside that bound (measured
    // live at 1440x900 with 10 banners: stack 432px vs host 488px). That
    // headroom is deliberate — the cap is a fixed, non-scrolling control, not
    // more of the pile-up this cap exists to bound — so what this guards is
    // narrower than "the host never grows past X": it is "the scrollable
    // stack itself never grows unbounded".
    const [expanded] = ruleBodies(
      css,
      '.banner-host--expanded .banner-host__stack',
    );
    expect(expanded).toMatch(/max-height:\s*min\(/);
    const [slot] = ruleBodies(
      css,
      '.banner-host--connection-slot .banner-host__stack',
    );
    expect(slot).toMatch(/max-height:\s*\d+vh/);
  });

  it("declares the expanded stack's bound/scroll CSS (real scrolling is proven in tests/banner-stack-bound.spec.ts)", () => {
    // jsdom performs no layout, so this can only confirm the CSS TEXT
    // declares a bound and `overflow-y: auto` — never that `scrollHeight`
    // actually exceeds `clientHeight` or that a wheel event moves
    // `scrollTop`. archive#3432 shipped with exactly this gap: `.banner-host`
    // is a flex column, so a bound declared on the ANCESTOR made flex
    // children shrink to fit it instead of overflowing, and this assertion
    // (then scoped to `.banner-host--expanded` itself) stayed green
    // throughout — it was never false, just never sufficient. The bound now
    // lives on `.banner-host__stack`, a dedicated inner wrapper, with
    // `.banner-host__item` pinned to `flex-shrink: 0` so overflow is real;
    // tests/banner-stack-bound.spec.ts is what actually proves it scrolls, in
    // a real browser, for both this state and the collapsed band.
    const [expanded] = ruleBodies(
      read(BANNER_CSS),
      '.banner-host--expanded .banner-host__stack',
    );
    expect(expanded).toMatch(/max-height:\s*min\(\d+dvh/);
    expect(expanded).toMatch(/overflow-y:\s*auto/);
  });

  it('grants pointer-events only to a genuinely scrollable stack, and never to the host itself (station#3432 round 2)', () => {
    // The mode rules above (`--connection-slot`/`--expanded`) declare the
    // bound but must NOT declare `pointer-events` themselves — that opt-in is
    // conditional in `BannerHost.tsx`, derived from a real
    // `scrollHeight`/`clientHeight` comparison, because a bounded stack with
    // nothing to scroll (the common case) must stay click-through. A prior
    // build made this unconditional here and swallowed clicks over the whole
    // card area even when there was nothing to scroll (a real regression of
    // #3308's "transparent unless there's a real control" property).
    const css = read(BANNER_CSS);
    for (const rule of [
      '.banner-host--connection-slot .banner-host__stack',
      '.banner-host--expanded .banner-host__stack',
    ]) {
      const [body] = ruleBodies(css, rule);
      expect(body, `missing rule: ${rule}`).toBeDefined();
      expect(body).not.toMatch(/pointer-events:/);
    }
    const [scrollable] = ruleBodies(css, '.banner-host__stack--scrollable');
    expect(scrollable).toMatch(/pointer-events:\s*auto/);

    // And the host's OWN box must never take pointer events, in any mode —
    // matching `BannerHost.tsx`'s docblock ("the host stays pointer-events:
    // none... in every state"). A rule "targets the host's own box" when
    // its rightmost simple selector (after any combinator — `> .banner-host`
    // inside the dock `:has` rules counts) is `.banner-host` or
    // `.banner-host--<modifier>`; `.banner-host--connection-slot
    // .banner-host__stack` does NOT (its rightmost selector is the inner
    // `__stack`, a genuine descendant), so it is correctly excluded.
    const ruleBlockPattern = /([^{}]+)\{([^{}]*)\}/g;
    const hostOnlyPattern = /^\.banner-host(?:--[\w-]+)?$/;
    let matched = 0;
    for (const match of css.matchAll(ruleBlockPattern)) {
      const [, rawSelectors, body] = match;
      for (const selector of rawSelectors.split(',')) {
        const rightmost = selector.trim().split(/\s+/).filter(Boolean).pop();
        if (!rightmost || !hostOnlyPattern.test(rightmost)) continue;
        matched += 1;
        expect(
          body,
          `${selector.trim()} must never grant pointer-events: auto on the host's own box`,
        ).not.toMatch(/pointer-events:\s*auto/);
      }
    }
    expect(matched).toBeGreaterThan(0);
  });

  it('keeps the stack cap tappable with a severity tint per tone', () => {
    const css = read(BANNER_CSS);
    const [cap] = ruleBodies(css, '.banner-host__cap');
    expect(cap).toMatch(/pointer-events:\s*auto/);
    expect(cap).toMatch(/min-height:\s*44px/);
    // Theme-token colors only: the cap must read in both themes.
    expect(cap).toMatch(/background:\s*var\(--bg-secondary\)/);
    expect(cap).toMatch(/color:\s*var\(--text-secondary\)/);
    for (const tone of ['warning', 'error', 'blocked', 'info']) {
      expect(css).toContain(`.banner-host__cap--${tone}`);
    }
  });

  it('declares no height floor of any kind', () => {
    // A floor is indistinguishable from a blank rail when the store is empty,
    // which pushed content down by 104px on mobile (archive#2268). Both a
    // fixed `height` and a `min-height` reintroduce that.
    const bodies = ruleBodies(
      read(BANNER_CSS),
      '.banner-host--connection-slot .banner-host__stack',
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/(^|[;{\s])height:/);
      expect(body).not.toMatch(/min-height:/);
    }
  });

  it('keeps a viewport cap so a pile-up cannot own the screen', () => {
    const [base] = ruleBodies(
      read(BANNER_CSS),
      '.banner-host--connection-slot .banner-host__stack',
    );
    expect(base).toMatch(/max-height:\s*\d+vh/);
    expect(base).toMatch(/overflow-y:\s*auto/);
  });

  it('renders separated severity cards in the priority-ordered stack', () => {
    const css = read(BANNER_CSS);
    const [host] = ruleBodies(css, '.banner-host');
    const [item] = ruleBodies(css, '.banner-host__item');
    expect(host).toMatch(/gap:\s*\d+px/);
    expect(item).toMatch(/border-left-width:\s*\d+px/);
    expect(item).toMatch(/border-radius:\s*\d+px/);
    expect(item).toMatch(/pointer-events:\s*none/);
    const [passiveDescendants] = ruleBodies(css, '.banner-host__item-inner *');
    expect(passiveDescendants).toMatch(/pointer-events:\s*none/);
    for (const selector of [
      '.banner-host__action',
      '.banner-host__dismiss',
      // The per-banner collapse control is a real control in the same
      // `pointer-events: none` subtree, so it is held to the same rule.
      '.banner-host__collapse',
    ]) {
      const [control] = ruleBodies(css, selector);
      expect(control).toMatch(/pointer-events:\s*auto/);
    }
    for (const tone of ['warning', 'error', 'blocked', 'info']) {
      expect(css).toContain(`.banner-host__item--${tone}`);
    }
  });

  it('keeps vertical scrolling available while dismissible notices track horizontal touch', () => {
    const [dismissible] = ruleBodies(
      read(BANNER_CSS),
      '.banner-host__item--dismissible',
    );
    expect(dismissible).toMatch(/touch-action:\s*pan-y/);
  });

  it('slides notices in without fading readable text through low contrast', () => {
    const css = read(BANNER_CSS);
    const keyframes = css.slice(css.indexOf('@keyframes banner-host-enter'));
    expect(keyframes).toContain('transform: translateY(-8px)');
    expect(keyframes).not.toContain('opacity:');
  });
});

describe('overlapping chrome has an explicit interaction order', () => {
  it('keeps banners below the chat dock and notifications above it', () => {
    const tokens = read('tokens.css');
    const index = read('index.css');
    const notifications = read(NOTIFICATION_CSS);

    const layerValue = (name: string): number => {
      const value = new RegExp(`--layer-${name}:\\s*(\\d+)`).exec(tokens)?.[1];
      expect(value, `--layer-${name} must be numeric`).toBeDefined();
      return Number(value);
    };

    expect(layerValue('notice')).toBeLessThan(layerValue('dock'));
    expect(layerValue('dock')).toBeLessThan(layerValue('floating-action'));
    expect(layerValue('floating-action')).toBeLessThan(
      layerValue('notification'),
    );
    expect(layerValue('notification')).toBeLessThan(layerValue('dialog'));

    // ruleBodiesFor, not ruleBodies: `.chat-dock` carries its geometry across
    // several rule blocks (base + placement/state modifiers), so a reader
    // that only checks the FIRST `.chat-dock {` block can miss a z-index
    // declared in a later one and report a missing layer on a dock that has
    // one. (Before archive#4460, a non-chat occupant's OWN `.dock-slot`
    // element shared this placement through `:is(.chat-dock, .dock-slot)`;
    // every occupant now renders through the one shared `.chat-dock` root,
    // so that fork is gone — this scan still needs every block, not that one.)
    const dockBodies = ruleBodiesFor(index, '.chat-dock');
    expect(
      dockBodies.some((body) => /z-index:\s*var\(--layer-dock\)/.test(body)),
      'the chat dock must be placed on --layer-dock by some rule that targets it',
    ).toBe(true);
    const [container] = ruleBodies(notifications, '.notification-container');
    expect(container).toMatch(/z-index:\s*var\(--layer-notification\)/);
  });
});

describe('shell chrome shares one mobile breakpoint', () => {
  it('adapts the banner host at the shell breakpoint, not its own', () => {
    const css = read(BANNER_CSS);
    const queries = [...css.matchAll(/@media[^{]+/g)].map((m) =>
      m[0].trim().replace(/\s+/g, ' '),
    );
    const widthQueries = queries.filter((q) => q.includes('max-width'));
    expect(widthQueries.length).toBeGreaterThan(0);
    for (const query of widthQueries) expect(query).toBe(SHELL_MOBILE_QUERY);
  });

  it('matches the breakpoint index.css actually defines', () => {
    expect(read('index.css').replace(/\s+/g, ' ')).toContain(
      SHELL_MOBILE_QUERY,
    );
  });
});

describe('the toolbar replacement carries the inset the toolbar owned', () => {
  const css = read('index.css');

  it('still hides the app toolbar in full-screen mobile dock', () => {
    // The premise of the assertion below. If this stops being true, the
    // requirement changes rather than disappears.
    expect(css).toMatch(
      /\.app__main--mobile-dock-fullscreen\s*>\s*\.app-toolbar\s*\{[^}]*display:\s*none/,
    );
  });

  it('insets only the full-screen mobile dock header by the top safe area', () => {
    // The toolbar is the only element that carries padding-top: var(--safe-top).
    // Hiding it without moving the inset to whatever replaces it puts the
    // eyebrow and title under the status bar on edge-to-edge Android
    // (archive#2287).
    const [body] = ruleBodies(css, '.chat-dock__mobile-header');
    expect(body, '.chat-dock__mobile-header rule not found').toBeDefined();
    const padding = /(^|[;{\s])padding:\s*([^;]+);/.exec(body)?.[2];
    expect(padding, 'the header must declare its own padding').toBeDefined();
    expect(padding).not.toContain('--safe-top');

    const [fullscreenBody] = ruleBodies(
      css,
      '.app__main--mobile-dock-fullscreen > .chat-dock .chat-dock__mobile-header',
    );
    expect(fullscreenBody).toContain('--safe-top');
  });

  it('pads a workspace tab strip if fullscreen chrome is ever applied to it', () => {
    const [body] = ruleBodies(
      css,
      '.app__main--mobile-dock-fullscreen .workspace-tabs__header',
    );
    expect(body).toMatch(/padding-top:\s*var\(--safe-top\)/);
  });

  it('pads a PageFrame route header the same way (station#541)', () => {
    // A framed route (Connections, Settings, ...) publishes its eyebrow/
    // title through `.page-frame__header`, not `.workspace-tabs__header` —
    // a different route family, the same missing-inset defect: with the
    // toolbar hidden nothing else accounts for the status-bar inset before
    // it. Layered on top of the header's own padding, not a replacement —
    // `padding-top` alone, so the base horizontal/bottom padding survives.
    //
    // Review round 2: this rule now lives IN page-frame.css itself (a
    // mobile-css-ratchet PRIMITIVE_ALLOWLIST entry — it renders every page
    // header, so it already owns this header's one mobile treatment),
    // beside the base padding it layers onto, rather than in index.css.
    const pageFrameCss = read('components/page-frame/page-frame.css');
    const bodies = ruleBodies(
      pageFrameCss,
      '.app__main--mobile-dock-fullscreen .page-frame__header',
    );
    expect(
      bodies.length,
      '.page-frame__header fullscreen rule (both breakpoints) not found',
    ).toBe(2);
    // The 641-768px rule adds the inset to page-frame.css's 2rem base...
    expect(bodies[0]).toMatch(
      /padding-top:\s*calc\(var\(--safe-top\)\s*\+\s*2rem\)/,
    );
    // ...and the <=640px rule (declared AFTER it, so the tie between two
    // identical-specificity selectors resolves by source order) adds it to
    // page-frame.css's narrower 1.5rem base instead.
    expect(bodies[1]).toMatch(
      /padding-top:\s*calc\(var\(--safe-top\)\s*\+\s*1\.5rem\)/,
    );
  });

  it('anchors a mobile dock to the visible viewport bottom', () => {
    const [body] = ruleBodies(css, '.app__main > .chat-dock');
    expect(body).toContain('--chat-visual-viewport-bottom');
  });
});

describe('the mobile collapsed-dock header height matches the shared header (station#524)', () => {
  const css = read('index.css');
  const chatCss = read('components/chat/chat.css');

  /**
   * `useDockShellChrome.ts`'s `collapsedHeight` reads this token via
   * `getComputedStyle(...).getPropertyValue()` + `parseInt` — a custom
   * property's computed value is the unparsed token text, so `calc()`/
   * `var()` inside it parse to `NaN` there (documented next to
   * `--app-toolbar-total-height` in `lib/toolbarGeometry.ts`). It must stay
   * a bare literal, never a live expression, however it is derived.
   */
  it('is a literal, not a calc() JS cannot read', () => {
    expect(css).toMatch(/--chat-dock-header-height:\s*53px;/);
    expect(css).not.toMatch(/--chat-dock-header-height:\s*calc\(/);
  });

  /**
   * The value itself: Home/Activity's collapsed bar is `ChatDockHeader`'s
   * `.chat-dock__header` (not Chat's own `.chat-dock__mobile-header`). Its
   * real mobile box is the 44px touch floor on its tallest control
   * (`.chat-dock__icon-btn`/`.chat-dock__maximize-btn`) plus its own
   * mobile `padding: var(--space-2) var(--space-3)` (both vertical sides
   * `--space-2`) plus its 1px `border-bottom` — 44 + 4 + 4 + 1 = 53. The
   * old `52px` was 1px short, and `.chat-dock.is-collapsed` sets
   * `overflow: hidden`, so that header's own bottom border/padding clipped.
   */
  it('sums to the real box: control min-height + 2x --space-2 padding + border-bottom width', () => {
    // review round 2 (L1): every number below is EXTRACTED from the CSS
    // text the assertions already matched against, not restated as a
    // literal — a hardcoded `44 + 2 * 4 + 1` would stay green even if any
    // one of those numbers drifted from what the stylesheets actually say.

    const spaceTwoMatch = /--space-2:\s*(\d+)px;/.exec(read('tokens.css'));
    expect(spaceTwoMatch, '--space-2 token not found').not.toBeNull();
    const spaceTwo = Number(spaceTwoMatch?.[1]);

    const headerRules = ruleBodiesFor(chatCss, '.chat-dock__header');
    const paddingBody = headerRules.find((body) =>
      /padding:\s*var\(--space-2\)\s+var\(--space-3\)/.test(body),
    );
    expect(
      paddingBody,
      '.chat-dock__header mobile padding rule not found',
    ).toBeDefined();

    const maximizeBtnRules = ruleBodiesFor(chatCss, '.chat-dock__maximize-btn');
    const controlBody = maximizeBtnRules.find((body) =>
      /min-height:\s*(\d+)px/.test(body),
    );
    expect(
      controlBody,
      '.chat-dock__maximize-btn 44px mobile floor not found',
    ).toBeDefined();
    const controlHeight = Number(
      /min-height:\s*(\d+)px/.exec(controlBody ?? '')?.[1],
    );

    // Base rule (index.css): border-bottom on `.chat-dock__header`.
    const [baseHeaderBody] = ruleBodiesFor(css, '.chat-dock__header');
    const borderMatch = /border-bottom:\s*(\d+)px solid/.exec(
      baseHeaderBody ?? '',
    );
    expect(
      borderMatch,
      '.chat-dock__header border-bottom not found',
    ).not.toBeNull();
    const borderWidth = Number(borderMatch?.[1]);

    // The token this whole derivation exists to justify. Two declarations
    // exist (the desktop default near the top of the file, and this
    // mobile override inside the responsive block) — the LAST one in
    // source order is the mobile-scoped value (cascade order), which is
    // the one this box math is about.
    const headerHeightMatches = [
      ...css.matchAll(/--chat-dock-header-height:\s*(\d+)px;/g),
    ];
    expect(
      headerHeightMatches.length,
      '--chat-dock-header-height literal not found',
    ).toBeGreaterThan(0);
    const recordedHeaderHeight = Number(
      headerHeightMatches[headerHeightMatches.length - 1][1],
    );

    expect(controlHeight + 2 * spaceTwo + borderWidth).toBe(
      recordedHeaderHeight,
    );
  });
});

describe('the toolbar connection chip fits the mobile action cluster', () => {
  const chatCss = read('components/chat/chat.css');

  /** The one mobile block in chat.css, by the shell breakpoint. */
  function shellMobileBlock(css: string): string {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let start = css.indexOf(SHELL_MOBILE_QUERY);
    while (start >= 0) {
      const open = css.indexOf('{', start);
      if (open < 0)
        throw new Error('shell mobile media opener missing in chat.css');
      let depth = 1;
      let end = open + 1;
      while (end < css.length && depth) {
        if (css[end] === '{') depth++;
        else if (css[end] === '}') depth--;
        end++;
      }
      if (depth !== 0)
        throw new Error('unterminated shell mobile block in chat.css');
      const block = css.slice(open + 1, end - 1);
      if (block.includes('.app-toolbar__action--secondary')) return block;
      start = css.indexOf(SHELL_MOBILE_QUERY, end);
    }
    throw new Error(
      'shell mobile block containing action--secondary not found in chat.css',
    );
  }

  it('shows the state text on mobile only when it carries news', () => {
    // archive#3311's mobile contract is dot-only while healthy. Nothing else
    // asserts it: deleting these two selectors changes no rendered markup, so
    // every component test stays green while the chip regrows a permanent
    // "Connected" label in a cluster with no room for it.
    const block = shellMobileBlock(chatCss);
    const [hidden] = ruleBodies(
      block,
      '.app-toolbar__conn--connected .app-toolbar__conn-state,\n  .app-toolbar__conn--idle .app-toolbar__conn-state',
    );
    expect(
      hidden,
      'the --connected/--idle state-text suppression must stay in the mobile block',
    ).toBeDefined();
    expect(hidden).toMatch(/display:\s*none/);
  });

  it('caps the state text that does survive, like the identity beside it', () => {
    // The state text is the only growable element in a `flex-shrink: 0`
    // cluster of three 44px controls. Today's longest copy fits (measured at
    // 110px against a 320px viewport), so this bounds a future/scaled string
    // rather than fixing a live overflow.
    const block = shellMobileBlock(chatCss);
    // `.app-toolbar__conn-state` is also the tail of the compound
    // `--connected`/`--idle` selectors above, so match it standalone.
    const [state] = ruleBodies(block, '\n  .app-toolbar__conn-state');
    expect(state, '.app-toolbar__conn-state has no mobile rule').toBeDefined();
    expect(state).toMatch(/max-width:\s*\d+px/);
    expect(state).toMatch(/text-overflow:\s*ellipsis/);

    // The cap it mirrors, for the premise.
    const [name] = ruleBodies(chatCss, '\n.app-toolbar__conn-name');
    expect(name).toMatch(/max-width:\s*\d+px/);
  });

  it('drops the identity and the bundled-server note on mobile', () => {
    const block = shellMobileBlock(chatCss);
    const [dropped] = ruleBodies(
      block,
      '.app-toolbar__conn-name,\n  .app-toolbar__conn-note',
    );
    expect(dropped).toMatch(/display:\s*none/);
  });
});

describe('mobile chat chrome has one header owner', () => {
  it('treats every maximized mobile dock as the same bottom sheet', () => {
    expect(
      isMobileDockFullscreen({
        isMobile: true,
        isDockOpen: true,
        isDockMaximized: true,
        isDockOwnedView: true,
      }),
    ).toBe(true);
    expect(
      isMobileDockFullscreen({
        isMobile: true,
        isDockOpen: false,
        isDockMaximized: true,
        isDockOwnedView: true,
      }),
    ).toBe(false);
  });

  it('keeps the toolbar for a visible layout despite stale dock maximization', () => {
    expect(
      isMobileDockFullscreen({
        isMobile: true,
        isDockOpen: true,
        isDockMaximized: true,
        isDockOwnedView: false,
      }),
    ).toBe(false);
  });

  it('keeps mobile-only controls out of the desktop header', () => {
    const dock = read('components/chat-dock/ChatDock.tsx');
    const desktopHeader = read('components/chat-dock/ChatDockHeader.tsx');
    const chatCss = read('components/chat/chat.css');

    expect(dock).toMatch(
      /isMobile\s*\?\s*\(\s*<ChatDockMobileHeader[\s\S]*?\)\s*:\s*\(\s*<ChatDockHeader/,
    );
    expect(desktopHeader).not.toContain('useIsMobile');
    expect(desktopHeader).not.toContain('onMobileDragPointerDown');
    expect(desktopHeader).not.toContain('chat-dock__mobile-task-trigger');
    expect(desktopHeader).not.toContain('chat-dock__restore-label');
    expect(chatCss).not.toContain('chat-dock__mobile-task-trigger');
    expect(read('index.css')).not.toContain('chat-dock__restore-label');
  });

  it('render-gates the mobile occupant picker at the 481px identity boundary', () => {
    const mobileHeader = read('components/chat-dock/ChatDockMobileHeader.tsx');
    const picker = read('workspace-panes/DockOccupantPicker.tsx');
    const css = read('index.css');

    expect(MOBILE_DOCK_OCCUPANT_PICKER_QUERY).toBe('(min-width: 481px)');
    expect(mobileHeader).toContain('useMobileDockOccupantPicker()');
    expect(mobileHeader).toContain('mobileDragPassthrough: true');
    expect(picker).toContain('data-dock-drag-passthrough=');
    expect(
      ruleBodiesFor(css, '.chat-dock__mobile-occupant-picker').every(
        (body) => !/display:\s*none/.test(body),
      ),
      'the picker must be DOM-absent below 481px, not merely CSS-hidden',
    ).toBe(true);
  });
});

describe('the mobile dock-and-empty contract derivation (station#520)', () => {
  it('maximizes only mobile + a request the admission check actually docked', () => {
    expect(shouldMaximizeAfterDockingAsOnlyContent(true, true)).toBe(true);
    expect(
      shouldMaximizeAfterDockingAsOnlyContent(false, true),
      'desktop already has room beside the dock',
    ).toBe(false);
    expect(
      shouldMaximizeAfterDockingAsOnlyContent(true, false),
      'a REFUSED dock request must never force Full over nothing',
    ).toBe(false);
    expect(shouldMaximizeAfterDockingAsOnlyContent(false, false)).toBe(false);
  });

  /** review round 2, M3: `DockOccupantPicker`'s onChoose seam. */
  it('shouldMaximizeOnOccupantChoice matches only mobile + picked-pane-is-current-route', () => {
    expect(shouldMaximizeOnOccupantChoice(true, 'home', 'home')).toBe(true);
    expect(
      shouldMaximizeOnOccupantChoice(false, 'home', 'home'),
      'desktop already has room beside the dock',
    ).toBe(false);
    expect(
      shouldMaximizeOnOccupantChoice(true, 'settings', 'home'),
      'the main area is already showing something else — nothing stranded',
    ).toBe(false);
    expect(
      shouldMaximizeOnOccupantChoice(true, 'home', null),
      'Chat has no route of its own (null) and never matches',
    ).toBe(false);
  });

  it('ambientDockOccupantRouteViewType maps Home to its route and Chat to null; Activity is a region surface, not a routed occupant (#928)', () => {
    expect(
      ambientDockOccupantRouteViewType(WORKSPACE_HOME_PANE_DESCRIPTOR),
    ).toBe('home');
    expect(
      ambientDockOccupantRouteViewType(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR),
    ).toBeNull();
    expect(
      ambientDockOccupantRouteViewType(WORKSPACE_CHAT_PANE_DESCRIPTOR),
    ).toBeNull();
  });

  it('chooseAmbientOccupant dispatches through the maximizing action when the live route would be stranded', () => {
    const onChoose = vi.fn();
    const onChooseAsOnlyContent = vi.fn();

    chooseAmbientOccupant({
      isMobile: true,
      pathname: '/',
      descriptor: WORKSPACE_HOME_PANE_DESCRIPTOR,
      instance: WORKSPACE_HOME_PANE_INSTANCE,
      onChoose,
      onChooseAsOnlyContent,
    });

    expect(onChooseAsOnlyContent).toHaveBeenCalledOnce();
    expect(onChooseAsOnlyContent).toHaveBeenCalledWith(
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_INSTANCE,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('chooseAmbientOccupant keeps ordinary choices on the plain action', () => {
    const onChoose = vi.fn();
    const onChooseAsOnlyContent = vi.fn();

    chooseAmbientOccupant({
      isMobile: true,
      pathname: '/settings',
      descriptor: WORKSPACE_HOME_PANE_DESCRIPTOR,
      instance: WORKSPACE_HOME_PANE_INSTANCE,
      onChoose,
      onChooseAsOnlyContent,
    });

    expect(onChoose).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith(
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_INSTANCE,
    );
    expect(onChooseAsOnlyContent).not.toHaveBeenCalled();
  });
});

describe('dock-owned view classification (#2636, station#4460)', () => {
  it('layout and workspace-pane views are never dock-owned; others are', () => {
    expect(isDockOwnedViewType('layout')).toBe(false);
    expect(isDockOwnedViewType('workspace-pane')).toBe(false);
    expect(isDockOwnedViewType('home')).toBe(true);
    expect(isDockOwnedViewType('settings')).toBe(true);
    expect(isDockOwnedViewType('activity')).toBe(true);
  });

  it('both isDockOwnedView call sites derive through the one shared predicate', () => {
    // If either caller re-derives ad hoc, the two toggles drift — the exact
    // double/zero drawer-toggle failure mobile-chrome.ts documents.
    const app = read('App.tsx');
    const dock = read('components/chat-dock/ChatDock.tsx');
    expect(app).toMatch(/isDockOwnedView:\s*isDockOwnedViewType\(/);
    expect(dock).toMatch(
      /isDockOwnedView:\s*isFullscreenPlacement \|\|\s*isDockOwnedViewType\(/,
    );
  });
});

describe('mobile navigation layer ownership', () => {
  it('keeps the drawer above notices and the dock but below notifications and dialogs', () => {
    const tokens = read('tokens.css');
    expect(tokens).toMatch(
      /--layer-notice:\s*9000;[\s\S]*--layer-dock:\s*9200;[\s\S]*--layer-navigation:\s*9350;[\s\S]*--layer-notification:\s*9400;[\s\S]*--layer-dialog:\s*10000;/,
    );

    const sidebar = read('components/project-sidebar/ProjectSidebar.css');
    expect(sidebar).toMatch(
      /\.sidebar--expanded\s*\{[^}]*z-index:\s*var\(--layer-navigation\)/s,
    );
    expect(sidebar).toMatch(
      /\.sidebar-backdrop\s*\{[^}]*z-index:\s*calc\(var\(--layer-navigation\)\s*-\s*1\)/s,
    );
  });
});
