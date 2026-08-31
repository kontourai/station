/**
 * E2E: dialog return-focus, in a real browser (archive#1206).
 *
 * WHY THIS EXISTS AND NOT ANOTHER UNIT TEST. `isConnected` answers "is it in
 * the document", not "can it take focus". jsdom performs no layout: it reports
 * `.focus()` on a `display: none` element as successful, sets `activeElement`
 * to it, and every assertion downstream agrees. In a browser that call is a
 * silent no-op, `activeElement` stays `<body>` — the exact archive#1126
 * outcome the fallback exists to prevent — and the `tabindex="-1"` the walk
 * wrote is left behind on a hidden node. The gap is structurally invisible to
 * the vitest suite, so it is proven here or it is not proven.
 *
 * The subject is the real `ResponsiveDialogSurface` and the real
 * `@kontourai/station-shared/return-focus`, bundled from source with esbuild and mounted in
 * Chromium — the same technique `mcp-ui-host-security.spec.ts` uses to run
 * real source inside a page. Only the surrounding page is synthetic, so the
 * focus semantics under test (a hidden element refusing focus, focus falling
 * to `<body>`, a second dialog holding focus) are the browser's own.
 *
 * The harness passes `historyMode="none"`: `setContent` leaves the page on
 * `about:blank`, where `history.pushState` throws, and the dialog-history
 * entry is orthogonal to focus restoration.
 */
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Scenario =
  | 'collapsing'
  | 'inert'
  | 'follow-up'
  | 'survivor'
  | 'nested'
  | 'connect-modal';

const HARNESS_SOURCE = `
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResponsiveDialogSurface } from './src-ui/src/components/ResponsiveDialogSurface';
import { ConnectionStore } from './packages/connect/src/core/ConnectionStore';
import { ConnectionsProvider } from './packages/connect/src/react/ConnectionsContext';
import { ConnectionManagerModalContent } from './packages/connect/src/react/ConnectionManagerModalContent';

/**
 * archive#1206 gap 2, the real shape: deleting the last row of a section that
 * then collapses. The section stays in the document, so it is the nearest
 * surviving ancestor, and it cannot hold focus.
 */
function CollapsingSection() {
  const [rows, setRows] = useState(['only-row']);
  const [confirming, setConfirming] = useState(false);
  return (
    <main id="page">
      <h1>Connections</h1>
      <section id="section" style={rows.length === 0 ? { display: 'none' } : undefined}>
        {rows.map((row) => (
          <div key={row} id="row">
            <button id="trigger" type="button" onClick={() => setConfirming(true)}>
              Delete row
            </button>
          </div>
        ))}
      </section>
      {confirming && (
        <ResponsiveDialogSurface
          ariaLabel="Confirm delete"
          historyMode="none"
          initialFocusPolicy="always"
          onClose={() => setConfirming(false)}
        >
          <button
            id="confirm"
            type="button"
            onClick={() => {
              setRows([]);
              setConfirming(false);
            }}
          >
            Confirm
          </button>
        </ResponsiveDialogSurface>
      )}
    </main>
  );
}

/**
 * archive#1206 gap 2, the half no structural pre-check can see. An \`inert\`
 * ancestor has a perfectly ordinary computed style — \`display: block\`,
 * \`visibility: visible\` — and still refuses focus. Only asking the browser
 * "did that focus() actually land?" catches it. Real shape: a dialog inerts the
 * background it covers (\`ConnectionManagerModalContent\` does exactly this) and
 * the deleted trigger's surviving ancestor is inside that background.
 */
function InertSurvivor() {
  const [rows, setRows] = useState(['only-row']);
  const [confirming, setConfirming] = useState(false);
  return (
    <main id="page">
      {/* Inert once emptied — the trigger has to be clickable before that. */}
      <section id="section" inert={rows.length === 0}>
        {rows.map((row) => (
          <div key={row} id="row">
            <button id="trigger" type="button" onClick={() => setConfirming(true)}>
              Delete row
            </button>
          </div>
        ))}
      </section>
      {confirming && (
        <ResponsiveDialogSurface
          ariaLabel="Confirm delete"
          historyMode="none"
          initialFocusPolicy="always"
          onClose={() => setConfirming(false)}
        >
          <button
            id="confirm"
            type="button"
            onClick={() => {
              setRows([]);
              setConfirming(false);
            }}
          >
            Confirm
          </button>
        </ResponsiveDialogSurface>
      )}
    </main>
  );
}

/** archive#1206 gap 1: the confirm removes its own trigger and opens a follow-up dialog. */
function FollowUpDialog() {
  const [rows, setRows] = useState(['only-row']);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renameRef = useRef(null);
  return (
    <main id="page">
      <div id="list">
        {rows.map((row) => (
          <div key={row} id="row">
            <button id="trigger" type="button" onClick={() => setConfirming(true)}>
              Delete row
            </button>
          </div>
        ))}
      </div>
      {confirming && (
        <ResponsiveDialogSurface
          ariaLabel="Confirm delete"
          historyMode="none"
          initialFocusPolicy="always"
          onClose={() => setConfirming(false)}
        >
          <button
            id="confirm"
            type="button"
            onClick={() => {
              setRows([]);
              setConfirming(false);
              setRenaming(true);
            }}
          >
            Confirm
          </button>
        </ResponsiveDialogSurface>
      )}
      {renaming && (
        <ResponsiveDialogSurface
          ariaLabel="Rename what is left"
          historyMode="none"
          initialFocusPolicy="always"
          initialFocusRef={renameRef}
          onClose={() => setRenaming(false)}
        >
          <input id="rename" ref={renameRef} aria-label="New name" />
        </ResponsiveDialogSurface>
      )}
    </main>
  );
}

/** Control: the trigger survives, so the fallback must never be reached. */
function SurvivingTrigger() {
  const [open, setOpen] = useState(false);
  return (
    <main id="page">
      <div id="list">
        <div id="row">
          <button id="trigger" type="button" onClick={() => setOpen(true)}>
            Open
          </button>
        </div>
      </div>
      {open && (
        <ResponsiveDialogSurface
          ariaLabel="Details"
          historyMode="none"
          initialFocusPolicy="always"
          onClose={() => setOpen(false)}
        >
          <button id="confirm" type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </ResponsiveDialogSurface>
      )}
    </main>
  );
}

/**
 * The stacked case gap 1's guard must NOT break. An inner dialog opened from
 * inside an outer one closes while the outer stays open: focus belongs back on
 * the inner trigger, which lives inside the outer panel. The cheap mitigation
 * archive#1206 floated — "skip when the target sits outside the topmost open overlay"
 * — fails here if it is read as "bail whenever any dialog is open", and every
 * other case in this file still passes when it is. This is the case that tells
 * the two apart.
 */
function NestedDialogs() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <main id="page">
      <div id="list">
        <button id="trigger" type="button" onClick={() => setOuter(true)}>
          Open outer
        </button>
      </div>
      {outer && (
        <ResponsiveDialogSurface
          ariaLabel="Outer"
          historyMode="none"
          initialFocusPolicy="always"
          onClose={() => setOuter(false)}
        >
          <div id="outer-body">
            <button id="inner-trigger" type="button" onClick={() => setInner(true)}>
              Open inner
            </button>
          </div>
        </ResponsiveDialogSurface>
      )}
      {inner && (
        <ResponsiveDialogSurface
          ariaLabel="Inner"
          historyMode="none"
          initialFocusPolicy="always"
          onClose={() => setInner(false)}
        >
          <button id="inner-close" type="button" onClick={() => setInner(false)}>
            Close inner
          </button>
        </ResponsiveDialogSurface>
      )}
    </main>
  );
}

/**
 * archive#1245: the real \`ConnectionManagerModalContent\`, from
 * \`packages/connect\`, restoring focus through the module that now lives in
 * \`@kontourai/station-shared\`.
 *
 * This is the site the module boundary hid — the package could not import the
 * app's copy, so it kept the archive#1126 defect through two sweeps. The scenario is
 * shaped like the host that makes it reachable: \`OnboardingGate\` renders this
 * modal from its unreachable-host screen, and connecting unmounts that whole
 * screen, trigger included.
 *
 * The surviving ancestor is left \`inert\`, which is the discriminator no jsdom
 * test can be: an inert element's computed style is entirely ordinary, so the
 * structural pre-check passes it and only "did the focus actually land?"
 * rejects it. jsdom implements neither, and reports the focus as successful.
 *
 * \`#section\` is nested inside \`#shell\` on purpose. The modal inerts every
 * branch outside its own overlay on mount and restores each one on unmount, so
 * an inert survivor that is a *sibling* of the overlay would simply be
 * un-inerted by that restore and prove nothing. \`#shell\` is the sibling it
 * manages; \`#section\` is below it and stays inert.
 */
function ConnectModalHost() {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const store = useRef(null);
  if (!store.current) {
    const values = {};
    store.current = new ConnectionStore({
      storage: {
        get: (key) => (key in values ? values[key] : null),
        set: (key, value) => { values[key] = value; },
        remove: (key) => { delete values[key]; },
      },
    });
  }
  return (
    <main id="page">
      <div id="shell">
        <section id="section" inert={connected}>
          {!connected && (
            <div id="row">
              <button id="trigger" type="button" onClick={() => setOpen(true)}>
                Manage Stations
              </button>
            </div>
          )}
        </section>
      </div>
      {open && (
        <ConnectionsProvider store={store.current}>
          <ConnectionManagerModalContent
            onClose={() => {
              setOpen(false);
              setConnected(true);
            }}
            checkHealth={async () => false}
          />
        </ConnectionsProvider>
      )}
    </main>
  );
}

const scenarios = {
  collapsing: CollapsingSection,
  inert: InertSurvivor,
  'follow-up': FollowUpDialog,
  survivor: SurvivingTrigger,
  nested: NestedDialogs,
  'connect-modal': ConnectModalHost,
};

const Scenario = scenarios[window.__scenario];
createRoot(document.getElementById('root')).render(<Scenario />);
`;

let harnessScript = '';

/**
 * A throwaway localhost origin for the `connect-modal` scenario only (the
 * same pattern `csp-shell.spec.ts` uses for its own server): real localhost
 * is a secure context (unlike a bare `about:blank` page — see `mount`
 * below) and carries no CSP, unlike the real app shell. The other scenarios
 * stay on `about:blank`, which their `historyMode="none"` choice depends on
 * (see the file docstring).
 */
let blankOriginServer: http.Server;
let blankOrigin = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: HARNESS_SOURCE,
      resolveDir: REPO_ROOT,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    write: false,
    platform: 'browser',
  });
  harnessScript = result.outputFiles[0].text;
  // A bundle that silently resolved to nothing would make every assertion
  // below vacuous.
  expect(harnessScript).toContain('responsive-surface-panel');
  expect(harnessScript).toContain('station-connect-modal-panel');

  blankOriginServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise<void>((resolveListen) =>
    blankOriginServer.listen(0, '127.0.0.1', resolveListen),
  );
  const address = blankOriginServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  blankOrigin = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolveClose) =>
    blankOriginServer.close(() => resolveClose()),
  );
});

async function mount(page: Page, scenario: Scenario) {
  if (scenario === 'connect-modal') {
    // The real `ConnectionsProvider` this scenario mounts calls
    // `crypto.randomUUID()` unguarded on its first render. That needs a
    // secure context, and a fresh page's `about:blank` (what every other
    // scenario mounts on, below) is not one in Chromium — no opener means
    // `window.isSecureContext` is false there, so the call throws and the
    // modal it renders never appears. The real app is always served from
    // `localhost` or `https`, both secure, so land on a throwaway localhost
    // origin first (`blankOrigin`, set up in `beforeAll`) rather than the
    // actual app shell: that shell's CSP deliberately never exposes its
    // nonce to page code (see the comment on `uiRequestHandler` in
    // `packages/cli/src/commands/lifecycle.ts`), so there is no nonce this
    // harness could legitimately reuse to inject its own script.
    await page.goto(blankOrigin);
  }
  await page.setContent('<div id="root"></div>');
  await page.evaluate((name) => {
    (window as unknown as { __scenario: string }).__scenario = name;
  }, scenario);
  await page.addScriptTag({ content: harnessScript });
  await expect(page.locator('#trigger')).toBeVisible();
}

/** What actually holds focus, plus the residue the walk leaves behind. */
function readFocusState(page: Page) {
  return page.evaluate(() => ({
    activeId: document.activeElement?.id ?? '',
    activeTag: document.activeElement?.tagName ?? '',
    sectionTabIndex: document
      .querySelector('#section')
      ?.getAttribute('tabindex'),
    listTabIndex: document.querySelector('#list')?.getAttribute('tabindex'),
  }));
}

test.describe('dialog return focus', () => {
  test('a collapsed surviving ancestor does not swallow focus (station#1206 gap 2)', async ({
    page,
  }) => {
    await mount(page, 'collapsing');
    await page.locator('#trigger').click();
    await page.locator('#confirm').click();
    await expect(page.locator('#row')).toHaveCount(0);

    // The section survived the delete but collapsed. `isConnected` says yes;
    // the browser refuses the focus. The walk has to try the next link.
    await expect
      .poll(async () => (await readFocusState(page)).activeId)
      .toBe('page');

    const state = await readFocusState(page);
    expect(state.activeTag).toBe('MAIN');
    // With the defect present this reads BODY — the very outcome archive#1126
    // is about.
    expect(state.activeTag).not.toBe('BODY');
    // …and no stray attribute written onto a node that refused focus.
    expect(state.sectionTabIndex).toBeNull();
  });

  /**
   * The discriminating case for the *second* half of the gap-2 fix. A
   * `display: none` survivor is caught by the structural pre-check, which jsdom
   * can also see; an `inert` survivor is not — its computed style is ordinary.
   * Only "did the focus land?" catches this one, and only a browser can answer.
   */
  test('an inert surviving ancestor does not swallow focus either (station#1206 gap 2)', async ({
    page,
  }) => {
    await mount(page, 'inert');
    await page.locator('#trigger').click();
    await page.locator('#confirm').click();
    await expect(page.locator('#row')).toHaveCount(0);

    await expect
      .poll(async () => (await readFocusState(page)).activeId)
      .toBe('page');

    const state = await readFocusState(page);
    expect(state.activeTag).not.toBe('BODY');
    expect(state.sectionTabIndex).toBeNull();
  });

  test('an open follow-up dialog keeps focus (station#1206 gap 1)', async ({
    page,
  }) => {
    await mount(page, 'follow-up');
    await page.locator('#trigger').click();
    await page.locator('#confirm').click();
    await expect(page.locator('#rename')).toBeVisible();

    await expect
      .poll(async () => (await readFocusState(page)).activeId)
      .toBe('rename');

    const state = await readFocusState(page);
    // The container behind the open dialog must not be marked focusable: the
    // attribute is the tell that the walk ran and stole focus at all.
    expect(state.listTabIndex).toBeNull();
  });

  test('a surviving trigger is still restored, untouched', async ({ page }) => {
    await mount(page, 'survivor');
    await page.locator('#trigger').click();
    await page.locator('#confirm').click();

    await expect
      .poll(async () => (await readFocusState(page)).activeId)
      .toBe('trigger');

    const state = await readFocusState(page);
    expect(state.listTabIndex).toBeNull();
    await expect(page.locator('#trigger')).not.toHaveAttribute('tabindex', /./);
  });

  /**
   * The stacked case has measured as landing correctly and was treated as an
   * improvement over base, but nothing pinned it. Gap 1's guard is the first
   * change that could plausibly take it away, so pin it here.
   */
  test('an inner dialog closing returns focus inside the outer one that stays open', async ({
    page,
  }) => {
    await mount(page, 'nested');
    await page.locator('#trigger').click();
    await expect(page.locator('#inner-trigger')).toBeVisible();
    await page.locator('#inner-trigger').click();
    await expect(page.locator('#inner-close')).toBeVisible();
    await page.locator('#inner-close').click();
    await expect(page.locator('#inner-close')).toHaveCount(0);

    // The outer dialog is still open, so focus must come back to the control
    // that opened the inner one — never to the page behind the outer panel.
    await expect(page.locator('#outer-body')).toBeVisible();
    await expect
      .poll(async () => (await readFocusState(page)).activeId)
      .toBe('inner-trigger');

    const state = await readFocusState(page);
    expect(state.listTabIndex).toBeNull();
  });

  /**
   * archive#1245. The other five scenarios drive `ResponsiveDialogSurface`;
   * this one drives the real `ConnectionManagerModalContent` out of
   * `packages/connect`, which could not import the app's copy of this fix and
   * therefore kept archive#1126 through two sweeps. It is now a consumer of
   * `@kontourai/station-shared/return-focus`, and this is the only assertion
   * that the cross-package wiring actually resolves in a real bundle rather
   * than only under vitest's aliases.
   *
   * The surviving ancestor is `inert`, which is why this cannot be a vitest
   * test: jsdom implements neither `inert` nor layout, so it would report the
   * focus as landing on `#section` and agree with itself all the way down.
   */
  test('the connect modal falls back past an inert survivor (station#1245)', async ({
    page,
  }) => {
    await mount(page, 'connect-modal');
    await page.locator('#trigger').click();
    await expect(page.locator('.station-connect-modal-panel')).toBeVisible();

    await page.getByRole('button', { name: 'Close Station manager' }).click();
    await expect(page.locator('#row')).toHaveCount(0);
    // The modal put every branch outside itself back the way it found it —
    // including `#shell`, which it inerted on mount. Anything still inert here
    // is the host's own doing, which is the point of the assertion below.
    await expect(page.locator('#shell')).not.toHaveAttribute('inert', /.*/);
    await expect(page.locator('#section')).toHaveAttribute('inert', /.*/);

    // `#section` survives the close and is the nearest surviving ancestor, so
    // a walk that trusts its own structural pre-check stops there. It is
    // inert: the browser refuses the focus and the walk has to keep going.
    await expect
      .poll(async () => (await readFocusState(page)).activeId)
      .toBe('shell');

    const state = await readFocusState(page);
    // With the defect present this reads BODY: `isConnected` is false for the
    // removed trigger and a copy with no fallback leaves focus nowhere.
    expect(state.activeTag).not.toBe('BODY');
    // …and nothing written onto the inert node that refused the focus.
    expect(state.sectionTabIndex).toBeNull();
  });
});
