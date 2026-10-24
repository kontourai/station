import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isDockOwnedViewType,
  isMobileDockFullscreen,
} from '../components/chat-dock/mobile-chrome';
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

describe('the maximized bottom dock fills the available row', () => {
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
});

describe('overlapping chrome has an explicit interaction order', () => {
  it('keeps notifications above the chat dock', () => {
    // The token order itself is owned by layer-tokens.test.ts ("keeps the
    // declared layer order true"); this pins which layer each surface uses.
    const index = read('index.css');
    const notifications = read(NOTIFICATION_CSS);

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

  it('counts the top safe area once for the full-screen mobile dock', () => {
    // The toolbar is the only element that carries padding-top: var(--safe-top).
    // Hiding it must not put the eyebrow and title under the status bar on
    // edge-to-edge Android (archive#2287) — and it must not count the inset
    // twice either. The dock itself starts below the inset (its `top` adds
    // `--app-toolbar-total-height`, reduced to `--safe-top` in this mode), so
    // a header that ALSO pads by it leaves a status-bar-tall empty band. The
    // geometry is proven by the browser journey in
    // tests/mobile-chat-composer.spec.ts; this pins the two declarations it
    // measures.
    expect(css).toMatch(
      /\.app__main--mobile-dock-fullscreen\s*\{[^}]*--app-toolbar-total-height:\s*var\(--safe-top\)/,
    );
    const [maximized] = ruleBodies(css, '.app__main > .chat-dock.is-maximized');
    expect(maximized, 'mobile maximized dock rule not found').toBeDefined();
    expect(maximized).toMatch(/top:\s*calc\([^;]*--app-toolbar-total-height/);

    const [body] = ruleBodies(css, '.chat-dock__mobile-header');
    expect(body, '.chat-dock__mobile-header rule not found').toBeDefined();
    const padding = /(^|[;{\s])padding:\s*([^;]+);/.exec(body)?.[2];
    expect(padding, 'the header must declare its own padding').toBeDefined();
    expect(padding).not.toContain('--safe-top');
    expect(
      ruleBodies(
        css,
        '.app__main--mobile-dock-fullscreen > .chat-dock .chat-dock__mobile-header',
      ).join(''),
    ).not.toContain('--safe-top');
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

  /** Every rule body in `block` whose selector mentions `className`. The
   *  lookahead keeps `.app-toolbar__conn-state` from matching its own
   *  `--alert` modifier, and spans selector lists, so the one combined
   *  suppression rule and split rules both read. */
  function blockRulesFor(block: string, className: string): string[] {
    const pattern = new RegExp(
      `${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])[^{}]*\\{([^}]*)\\}`,
      'g',
    );
    return [...block.matchAll(pattern)].map((match) => match[1]);
  }

  it('keeps connection text out of the dot-only mobile header', () => {
    // Runtime name and gesture behavior are exercised by HeaderActions and
    // the narrow gallery; this guards the stylesheet's text suppression.
    const block = shellMobileBlock(chatCss);
    for (const part of [
      '.app-toolbar__conn-name',
      '.app-toolbar__conn-state',
      '.app-toolbar__conn-label',
    ]) {
      const bodies = blockRulesFor(block, part);
      expect(
        bodies.length,
        `${part} must keep a mobile rule (the full text stays out of the narrow header)`,
      ).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).toMatch(/display:\s*none/);
      }
    }
  });

  it('keeps the status-dot control at the 44px touch-target floor', () => {
    const block = shellMobileBlock(chatCss);
    const [floor] = ruleBodies(block, '\n  .app-toolbar__icon-btn');
    expect(floor, 'the mobile icon-btn floor must stay').toBeDefined();
    expect(floor).toMatch(/min-width:\s*44px/);
    expect(floor).toMatch(/min-height:\s*44px/);
    const [connection] = blockRulesFor(block, '.app-toolbar__conn');
    expect(connection).toMatch(/width:\s*44px/);

    const headerActions = read('components/header/HeaderActions.tsx');
    expect(headerActions).toMatch(
      /app-toolbar__icon-btn app-toolbar__conn app-toolbar__conn--/,
    );
  });

  it('keeps the label bounds where the words still show', () => {
    // The desktop premise the mobile suppression leans on: the full identity,
    // short healthy label, and reserved state slot are bounded where they render.
    const [name] = ruleBodies(chatCss, '\n.app-toolbar__conn-name');
    expect(name).toMatch(/max-width:\s*\d+px/);
    const [label] = ruleBodies(chatCss, '\n.app-toolbar__conn-label');
    expect(label).toMatch(/max-width:\s*\d+px/);
    const [state] = ruleBodies(chatCss, '\n.app-toolbar__conn-state');
    expect(state).toMatch(/min-width:\s*\d+px/);
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

    expect(dock).toMatch(
      /isMobile\s*\?\s*\(\s*<ChatDockMobileHeader[\s\S]*?\)\s*:\s*\(\s*<ChatDockHeader/,
    );
    expect(desktopHeader).not.toContain('useIsMobile');
    expect(desktopHeader).not.toContain('onMobileDragPointerDown');
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
      /isDockOwnedView:[\s\S]*?isDockOwnedViewType\(resolveViewFromPath\(pathname\)\.type\)/,
    );
  });
});

describe('mobile navigation layer ownership', () => {
  it('keeps the drawer above notices and the dock but below notifications and dialogs', () => {
    // Where navigation sits in the token scale is owned by
    // layer-tokens.test.ts ("keeps the declared layer order true"); this pins
    // that the drawer and its backdrop use that layer.
    const sidebar = read('components/project-sidebar/ProjectSidebar.css');
    expect(sidebar).toMatch(
      /\.sidebar--expanded\s*\{[^}]*z-index:\s*var\(--layer-navigation\)/s,
    );
    expect(sidebar).toMatch(
      /\.sidebar-backdrop\s*\{[^}]*z-index:\s*calc\(var\(--layer-navigation\)\s*-\s*1\)/s,
    );
  });
});
