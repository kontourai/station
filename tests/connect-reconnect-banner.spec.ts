import { expect, type Page, test } from '@playwright/test';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const RECOVERED_URL = 'https://recovered.example.test';

const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
});

async function seedConnection(page: Page) {
  const credential = process.env.STATION_E2E_HOST_CREDENTIAL;
  if (!credential) {
    throw new Error('Reconnect coverage requires the runner host credential');
  }
  await page.addInitScript((hostCredential) => {
    const now = Date.now();
    window.localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          profileVersion: 4,
          id: 'c1',
          name: 'Dev Server',
          url: window.location.origin,
          credentialRef: {
            credentialVersion: 1,
            kind: 'connection',
            id: 'c1',
          },
          credentialState: 'saved',
          lastConnected: now,
          lastSuccessAt: now,
        },
      ]),
    );
    window.localStorage.setItem('station-connect-connections-active', 'c1');
    window.localStorage.setItem(
      'station-connect-connections-credentials',
      JSON.stringify({ 'connection:c1': hostCredential }),
    );
    window.localStorage.setItem('station:onboarding-setup-dismissed', '1');
  }, credential);
}

async function installTransport(
  page: Page,
  state: {
    healthy: boolean;
    bootId: string;
    inFlight: number;
    maxInFlight: number;
  },
) {
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        environmentId: ENVIRONMENT_ID,
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
      }),
    }),
  );
  // `OnboardingGate` gates first paint on its own `/api/system/status` query
  // (react-query, `retry: 2` with up to a ~2s+4s exponential backoff) —
  // separate from the compatibility-aware reachability probe this suite
  // drives through `/api/system/identity` below. Leaving it unmocked meant
  // this test depended on the REAL live Station instance answering
  // `/api/system/status` fast and without a transient failure. Isolated,
  // against an idle server, it always did; run in parallel with the rest of
  // the e2e suite hammering the same one live instance, an occasional slow
  // or dropped first response pushed the retry backoff past this test's
  // fixed assertion timeouts — the actual "passes isolated, fails in
  // parallel" cause (archive#985), not a leaked-state race. The status this gate
  // needs is always "ready" for every scenario this file drives (the
  // backend really is up throughout; only the compatibility probe below
  // simulates unreachability), so mock it the same way every other e2e spec
  // in this suite already does instead of depending on real server timing.
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: STATUS_READY,
    }),
  );
  await page.route('**/api/system/identity', async (route) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 40));
    state.inFlight -= 1;
    if (!state.healthy) {
      await route.abort('connectionrefused');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ bootId: state.bootId }),
    });
  });
}

test.describe('compatibility-aware reconnect', () => {
  test.beforeEach(async ({ page }) => {
    await seedConnection(page);
  });

  test('deduplicates probes and recovers without reloading', async ({
    page,
  }) => {
    const state = {
      healthy: true,
      bootId: 'boot-1',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible();

    // #530: recovery owns only the offline banner. The load-induced
    // resource-posture alert may be present concurrently without becoming this
    // test's subject. Injecting it from the start makes the strict-mode red
    // deterministic; production reaches the same collision after recovery
    // re-resolves resource posture.
    await page.evaluate(() => {
      const concurrentAlert = document.createElement('div');
      concurrentAlert.setAttribute('role', 'alert');
      concurrentAlert.dataset.bannerId = 'test:concurrent-alert';
      concurrentAlert.textContent = 'Concurrent host notice';
      document.body.append(concurrentAlert);
    });

    state.healthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const banner = page.locator(
      '[role="alert"][data-banner-id="chrome:connection:offline"]',
    );
    await expect(banner).toContainText("Can't reach Dev Server");
    // archive#3297: the banner is one line now, and the caveats live behind
    // its disclosure. They are still reachable, and still say the same thing
    // — the change is that a phone no longer wears the whole paragraph.
    await expect(banner).not.toContainText('will not be queued');
    await banner.getByRole('button', { name: 'Details' }).click();
    await expect(banner).toContainText('read-only');
    await expect(banner).toContainText('will not be queued');
    expect(state.maxInFlight).toBe(1);

    state.healthy = true;
    state.bootId = 'boot-2';
    // A probe already in flight when the server flips healthy can complete
    // first and hide the banner on its own — removing the very button this
    // clicks. Both paths prove the same contract (recovery without a reload),
    // and the assertions that carry this test's substance — one probe at a
    // time, and the new boot id adopted — hold either way. So click when the
    // button is still there and accept an already-recovered banner otherwise,
    // rather than racing the poll and failing ~60% of the time.
    await banner
      .getByRole('button', { name: 'Try now' })
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    await expect(banner).toBeHidden();
    await expect(
      page
        // archive#3311 made the connection control self-describing: its
        // accessible name now carries the state and the connection identity
        // ("Manage Stations — Connected · <name>"), so this matches by prefix.
        // The bare string is still the control’s `title` (archive#3297).
        .getByRole('button', { name: /^Manage Stations/ })
        .getByLabel('connected'),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const profiles = JSON.parse(
            localStorage.getItem('station-connect-connections') ?? '[]',
          ) as Array<{ lastBootId?: string }>;
          return profiles[0]?.lastBootId;
        }),
      )
      .toBe('boot-2');
  });

  test('keeps the reconnect action reachable on a phone viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = {
      healthy: true,
      bootId: 'boot-mobile',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible();
    state.healthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const banner = page.locator(
      '[role="alert"][data-banner-id="chrome:connection:offline"]',
    );
    await expect(banner).toBeVisible();
    const bannerBox = await banner.boundingBox();
    const actionBox = await banner
      .getByRole('button', { name: 'Try now' })
      .boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(bannerBox!.x).toBeGreaterThanOrEqual(0);
    expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(390);
    expect(actionBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(844);
  });

  for (const placement of ['bottom', 'right'] as const) {
    test(`overlays the desktop reconnect banner below the toolbar without reflowing content in ${placement} dock placement`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      const state = {
        healthy: true,
        bootId: `boot-desktop-${placement}`,
        inFlight: 0,
        maxInFlight: 0,
      };
      await installTransport(page, state);
      await page.goto(`/?dockSlotPlacement=${placement}`);
      await expect(page.locator('.app__main')).toHaveClass(
        new RegExp(`app__main--dock-${placement}`),
      );
      await expect(
        page.getByRole('heading', { name: 'What do you want to work on?' }),
      ).toBeVisible();

      state.healthy = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));

      const toolbar = page.locator('.app-toolbar');
      const banner = page.locator(
        '[role="alert"][data-banner-id="chrome:connection:offline"]',
      );
      const mainContent = page.locator('.main-content');
      await expect(banner).toBeVisible();
      await expect
        .poll(async () => {
          const [toolbarBox, bannerBox] = await Promise.all([
            toolbar.boundingBox(),
            banner.boundingBox(),
          ]);
          if (!toolbarBox || !bannerBox) return Number.NEGATIVE_INFINITY;
          return bannerBox.y - (toolbarBox.y + toolbarBox.height);
        })
        .toBeGreaterThanOrEqual(-1);

      const [toolbarBox, bannerBox, mainContentBox] = await Promise.all([
        toolbar.boundingBox(),
        banner.boundingBox(),
        mainContent.boundingBox(),
      ]);
      expect(toolbarBox).not.toBeNull();
      expect(bannerBox).not.toBeNull();
      expect(mainContentBox).not.toBeNull();

      const toolbarBottom = toolbarBox!.y + toolbarBox!.height;
      // archive#3308 contract: the banner is an overlay. It must start below
      // the toolbar's interactive controls (archive#2343) — and the content must NOT
      // have been pushed down to make room for it: `.main-content` still
      // starts at the toolbar's bottom edge, with the banner hovering above
      // it.
      expect(bannerBox!.y).toBeGreaterThanOrEqual(toolbarBottom - 1);
      expect(mainContentBox!.y).toBeLessThanOrEqual(toolbarBottom + 1);
    });
  }

  /**
   * Who owns the pixels of a control, sampled across its hit target rather than
   * at its center alone. Bounding-box math is what let the dock occlusion
   * through: every box was on-screen and the right size while another surface
   * owned the pixels. Midline samples (not corners) because the dismiss control
   * is a 44px circle — its bounding-box corners are outside its own hit region
   * by design.
   */
  async function hitTargetOwners(
    page: Page,
    box: { x: number; y: number; width: number; height: number },
  ): Promise<string[]> {
    const inset = 3;
    const midY = box.y + box.height / 2;
    const samples: [number, number][] = [
      [box.x + inset, midY],
      [box.x + box.width / 2, midY],
      [box.x + box.width - inset, midY],
    ];
    return page.evaluate(
      (points) =>
        points.map(([x, y]) => {
          const element = document.elementFromPoint(x, y);
          if (!element) return 'none';
          if (element.closest('.banner-host')) return 'banner-host';
          const className =
            typeof element.className === 'string' ? element.className : '';
          return `${element.tagName.toLowerCase()}${className ? `.${className.trim().split(/\s+/).join('.')}` : ''}`;
        }),
      samples,
    );
  }

  /**
   * Drag the bottom dock's resize handle as far up as it goes. The default
   * 300px dock clears an expanded banner stack at 900px tall, so the geometry
   * that occludes only appears once the user has actually made the dock big —
   * a real pointer drag, not a style poke, because `--dock-slot-size` is
   * published by the drag handler and the CSS bound reads it.
   */
  async function dragBottomDockToMaxHeight(page: Page): Promise<number> {
    const handle = page.locator('.chat-dock__resize-handle').first();
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box, 'resize handle has no box').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    // Past the clamp on purpose: the app pins it at `innerHeight - 150`, and
    // asking for more proves the test is measuring the app's own ceiling
    // rather than a number this file invented.
    await page.mouse.move(box!.x + box!.width / 2, 20, { steps: 12 });
    await page.mouse.up();
    return page.evaluate(() =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--dock-slot-size',
        ),
      ),
    );
  }

  /**
   * archive#3308: the overlay is a sibling of `.chat-dock` in the
   * same stacking context, and the dock owns the higher named layer — so a
   * banner spanning the whole shell put its own controls underneath an active
   * workspace surface. A blocking pairing/credential banner that cannot be
   * read or acted on is worse than the reflow the overlay replaced.
   *
   * Every dock MODE is covered, not just the side docks: a bottom dock takes
   * the row under the content instead of a column beside it, so it needs a
   * block-size bound rather than a left/right inset — a different mechanism
   * than the inset one. The fixture is two
   * REAL banners (the offline notice plus a real update notice) with the stack
   * expanded, because that is the shape whose lower half reaches the dock.
   */
  for (const dock of [
    { mode: 'right', name: 'collapsed', query: 'dockSlotPlacement=right' },
    { mode: 'right', name: 'open', query: 'dockSlotPlacement=right&dock=open' },
    {
      mode: 'right',
      name: 'maximized',
      query: 'dockSlotPlacement=right&dock=open&maximize=true',
    },
    { mode: 'left', name: 'collapsed', query: 'dockSlotPlacement=left' },
    { mode: 'left', name: 'open', query: 'dockSlotPlacement=left&dock=open' },
    { mode: 'bottom', name: 'collapsed', query: 'dockSlotPlacement=bottom' },
    {
      mode: 'bottom',
      name: 'open',
      query: 'dockSlotPlacement=bottom&dock=open',
      resize: true,
    },
    {
      mode: 'bottom',
      name: 'maximized',
      query: 'dockSlotPlacement=bottom&dock=open&maximize=true',
    },
  ] as const) {
    const markers = {
      collapsed: { present: [/is-collapsed/], absent: [/is-maximized/] },
      open: { present: [], absent: [/is-collapsed/, /is-maximized/] },
      maximized: { present: [/is-maximized/], absent: [/is-collapsed/] },
    }[dock.name] as { present: RegExp[]; absent: RegExp[] };

    test(`keeps every banner control hit-testable with a ${dock.name} ${dock.mode} dock`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const state = {
        healthy: true,
        bootId: `boot-dock-${dock.mode}-${dock.name}`,
        inFlight: 0,
        maxInFlight: 0,
      };
      await installTransport(page, state);
      // A second REAL banner. `chrome:update:available` is the info band, so
      // it sorts below the connection notice and becomes the hidden one the
      // collapsed cap describes — and the one an expanded stack renders low
      // enough to meet a bottom dock.
      await page.route('**/api/system/core-update', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            updateAvailable: true,
            currentVersion: '1.0.0',
            latestVersion: '1.1.0',
            remoteHash: 'e2e-dock-occlusion',
          }),
        }),
      );
      await page.goto(`/?${dock.query}`);

      await expect(page.locator('.app__main')).toHaveClass(
        new RegExp(`app__main--dock-${dock.mode}`),
      );
      const chatDock = page.locator('.app__main > .chat-dock');
      await expect(chatDock).toBeVisible();
      // Fail loudly if the URL params did not actually reach the dock state
      // under test — a silently-collapsed dock would pass every assertion
      // below while proving nothing about the state named in the title.
      for (const marker of markers.present) {
        await expect(chatDock).toHaveClass(marker);
      }
      for (const marker of markers.absent) {
        await expect(chatDock).not.toHaveClass(marker);
      }

      state.healthy = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));

      const banner = page.locator(
        '[role="alert"][data-banner-id="chrome:connection:offline"]',
      );
      await expect(banner).toBeVisible();

      if (dock.resize) {
        const height = await dragBottomDockToMaxHeight(page);
        // `clampDockHeight` pins at `innerHeight - 150`; anything materially
        // short of it means the drag did not take and the case below would be
        // measuring the default dock instead of a big one.
        expect(height, 'dock did not resize').toBeGreaterThanOrEqual(700);
      }

      // Expand the stack: collapsed, only the front banner renders, and the
      // bottom half of the overlay — the part a bottom dock reaches — does not
      // exist to be occluded.
      const cap = page.getByTestId('banner-stack-cap');
      await expect(cap).toBeVisible();
      await cap.click();
      await expect(page.locator('.banner-host')).toHaveAttribute(
        'data-expanded',
        'true',
      );
      // More than one, not exactly two: which chrome banners a fresh home
      // presents is not this spec's subject, and pinning the count made it
      // fail on a home that legitimately had a third.
      expect(
        await page.locator('.banner-host__item').count(),
        'expanding did not reveal the hidden banners',
      ).toBeGreaterThan(1);

      // Every interactive control in the overlay, not a hand-picked pair: the
      // control that gets occluded first is the LAST one, and naming controls
      // individually is how a spec ends up proving the top of the stack only.
      const controls = page.locator(
        '.banner-host button, .banner-host a[href]',
      );
      const total = await controls.count();
      expect(total, 'no banner controls found').toBeGreaterThanOrEqual(4);
      // An occlusion failure is unreadable without the two rects and the
      // bound that was supposed to keep them apart, so carry them into every
      // failure message rather than leaving the next reader to re-derive them.
      const geometry = await page.evaluate(() => {
        const host = document.querySelector('.banner-host');
        const dock = document.querySelector('.chat-dock');
        const style = host ? getComputedStyle(host) : null;
        const rect = (node: Element | null) => {
          if (!node) return null;
          const box = node.getBoundingClientRect();
          return { top: Math.round(box.top), bottom: Math.round(box.bottom) };
        };
        return {
          host: rect(host),
          dock: rect(dock),
          dockClass: dock?.className.replace(/\s+/g, ' ').trim(),
          hostMaxHeight: style?.maxHeight,
          hostZIndex: style?.zIndex,
          dockZIndex: dock ? getComputedStyle(dock).zIndex : null,
          dockHeightVar: getComputedStyle(
            document.documentElement,
          ).getPropertyValue('--dock-slot-size'),
        };
      });
      for (let index = 0; index < total; index += 1) {
        const control = controls.nth(index);
        const label =
          (await control.getAttribute('aria-label')) ??
          (await control.textContent()) ??
          `control ${index}`;
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box, `${label} has no box`).not.toBeNull();
        const owners = await hitTargetOwners(page, box!);
        expect(
          owners,
          `"${label.trim()}" pixels are owned by another surface in the ${dock.name} ${dock.mode} dock. ${JSON.stringify(
            { control: { top: Math.round(box!.y) }, ...geometry },
          )}`,
        ).toEqual(['banner-host', 'banner-host', 'banner-host']);
        // elementFromPoint answers "who paints here"; the trial click answers
        // "would a real click land", which is the claim that actually matters.
        await control.click({ trial: true, timeout: 3_000 });
      }
    });
  }

  test('keeps every banner control hit-testable over a fullscreen mobile chat', async ({
    page,
  }) => {
    // Mobile chat fullscreen hides the toolbar, so the overlay's top collapses
    // to the safe-area inset and the banner newly paints over the fullscreen
    // chat's own header. The pointer-events reasoning says this is acceptable;
    // this measures it: every banner control
    // must own its pixels and take a trial click over the maximized dock.
    await page.setViewportSize({ width: 390, height: 844 });
    const state = {
      healthy: true,
      bootId: 'boot-dock-mobile-fullscreen',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.route('**/api/system/core-update', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          updateAvailable: true,
          currentVersion: '1.0.0',
          latestVersion: '1.1.0',
          remoteHash: 'e2e-dock-occlusion-mobile',
        }),
      }),
    );
    await page.goto('/?dock=open&maximize=true');

    // Fail loudly if this URL stops producing the fullscreen state — every
    // assertion below would otherwise pass against ordinary mobile chrome
    // while proving nothing about the state named in the title.
    await expect(page.locator('.app__main')).toHaveClass(
      /app__main--mobile-chat-fullscreen/,
    );
    const chatDock = page.locator('.app__main > .chat-dock');
    await expect(chatDock).toBeVisible();
    await expect(chatDock).toHaveClass(/is-maximized/);

    state.healthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    const banner = page.locator(
      '[role="alert"][data-banner-id="chrome:connection:offline"]',
    );
    await expect(banner).toBeVisible();

    const cap = page.getByTestId('banner-stack-cap');
    await expect(cap).toBeVisible();
    await cap.click();
    await expect(page.locator('.banner-host')).toHaveAttribute(
      'data-expanded',
      'true',
    );

    const controls = page.locator('.banner-host button, .banner-host a[href]');
    const total = await controls.count();
    expect(total, 'no banner controls found').toBeGreaterThanOrEqual(4);
    for (let index = 0; index < total; index += 1) {
      const control = controls.nth(index);
      const label =
        (await control.getAttribute('aria-label')) ??
        (await control.textContent()) ??
        `control ${index}`;
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      const owners = await hitTargetOwners(page, box!);
      expect(
        owners,
        `"${label.trim()}" pixels are owned by another surface over the fullscreen mobile chat`,
      ).toEqual(['banner-host', 'banner-host', 'banner-host']);
      await control.click({ trial: true, timeout: 3_000 });
    }
  });

  test('leaves the blocking error after a new connection succeeds on mobile', async ({
    page,
  }) => {
    // archive#3766: `.app-toolbar__actions` has one owner for its flex
    // behaviour now (`components/chat/chat.css`), so a news-carrying
    // connection chip can no longer shrink the action cluster into nothing at
    // 390 — `More actions`, the only mobile route to Connections, stays
    // hit-testable while the offline banner is up.
    await page.setViewportSize({ width: 390, height: 844 });
    let recoveredStatusRequests = 0;
    let primaryHealthy = true;

    await page.route(`${RECOVERED_URL}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      }),
    );
    await page.route('**/.well-known/station/v1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: E2E_STATION_COMPATIBILITY,
        }),
      }),
    );
    await page.route('**/api/system/status', async (route) => {
      if (new URL(route.request().url()).origin === RECOVERED_URL) {
        recoveredStatusRequests += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      });
    });
    // Readiness keeps the shell usable; compatibility identity is the
    // connection-health probe that owns the offline banner.
    await page.route('**/api/system/identity', async (route) => {
      if (
        new URL(route.request().url()).origin !== RECOVERED_URL &&
        !primaryHealthy
      ) {
        await route.abort('connectionrefused');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bootId: 'recovered-boot' }),
      });
    });

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible();
    primaryHealthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const banner = page.locator(
      '[role="alert"][data-banner-id="chrome:connection:offline"]',
    );
    await expect(banner).toContainText("Can't reach Dev Server");

    // archive#3766: "the banner never covers the toolbar" as a MEASUREMENT,
    // not a comment. Every toolbar action control's own centre must hit-test
    // to itself. The regression this replaces satisfied every other check —
    // all four controls were in the accessibility tree, reported visible,
    // enabled and stable, and a full 44x44 — while the toolbar had wrapped to
    // a second row underneath the offline banner and `More actions` resolved
    // to `.banner-host__collapse`.
    const occluded = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.app-toolbar__actions button'),
      )
        .filter((control) => {
          // Mobile hides the secondary actions outright; a zero-box element
          // has no centre to test and is not a control anyone can reach.
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((control) => {
          const rect = control.getBoundingClientRect();
          const owner = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return owner && control.contains(owner)
            ? null
            : `${control.getAttribute('aria-label') ?? control.textContent} -> ${
                (owner as HTMLElement | null)?.className ?? 'nothing'
              }`;
        })
        .filter((entry): entry is string => entry !== null),
    );
    expect(occluded, 'toolbar controls covered by another surface').toEqual([]);
    await page
      .getByRole('button', { name: 'More actions' })
      .click({ timeout: 5_000 });
    await page
      .getByRole('button', { name: 'Connections', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add a Station address' })
      .click();
    await page.getByPlaceholder('Name (optional)').fill('Recovered Station');
    await page
      .getByPlaceholder('https://station.example.ts.net')
      .fill(RECOVERED_URL);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => recoveredStatusRequests).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Close Station manager' }).click();

    await expect(page.getByRole('button', { name: 'Toggle menu' })).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(banner).toBeHidden();
    expect(recoveredStatusRequests).toBeGreaterThanOrEqual(2);
  });
});
