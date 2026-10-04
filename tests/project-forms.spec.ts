import { expect, type Locator, type Page, test } from '@playwright/test';
import { STARTER_CATALOG } from './fixtures/project-layout-catalog';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import { installVisualViewportFixture } from './helpers/visual-viewport';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedProjectFormRoutes(page: Page) {
  const state = {
    projects: [] as Array<{
      id: string;
      slug: string;
      name: string;
      workingDirectory?: string;
      layouts: unknown[];
    }>,
  };

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/system/status') {
      await route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
        }),
      );
      return;
    }

    if (path === '/api/system/capabilities') {
      await route.fulfill(
        json({
          runtime: 'voltagent',
          voice: { stt: [], tts: [] },
          context: { providers: [] },
          scheduler: true,
        }),
      );
      return;
    }

    if (path === '/api/auth/status') {
      await route.fulfill(json({ authenticated: true, user: null }));
      return;
    }

    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }

    if (path === '/api/projects' && method === 'GET') {
      await route.fulfill(json({ success: true, data: state.projects }));
      return;
    }

    if (path === '/api/projects' && method === 'POST') {
      const body = route.request().postDataJSON() as {
        name: string;
        slug: string;
        workingDirectory?: string;
      };
      const project = {
        id: `p-${body.slug}`,
        slug: body.slug,
        name: body.name,
        workingDirectory: body.workingDirectory,
        layouts: [],
      };
      state.projects.push(project);
      await route.fulfill(json({ success: true, data: project }, 201));
      return;
    }

    if (path === '/api/projects/demo' && method === 'GET') {
      await route.fulfill(
        json({
          success: true,
          data: {
            id: 'p-demo',
            slug: 'demo',
            name: 'Demo Project',
            hasWorkingDirectory: false,
            layoutCount: 0,
            hasKnowledge: false,
            createdAt: '2026-07-13T00:00:00.000Z',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        }),
      );
      return;
    }

    const projectDetailMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectDetailMatch && method === 'GET') {
      const project = state.projects.find(
        (entry) => entry.slug === projectDetailMatch[1],
      );
      if (!project) {
        await route.fulfill(json({ success: false, error: 'Not found' }, 404));
        return;
      }
      await route.fulfill(
        json({
          success: true,
          data: {
            ...project,
            hasWorkingDirectory: Boolean(project.workingDirectory),
            layoutCount: 0,
            hasKnowledge: false,
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
          },
        }),
      );
      return;
    }

    if (path === '/api/templates') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    if (path === '/api/fs/browse') {
      await route.fulfill(
        json({
          success: true,
          data: {
            path: '/tmp',
            entries: [{ name: 'demo', isDirectory: true }],
          },
        }),
      );
      return;
    }

    if (path === '/api/coding/repos') {
      await route.fulfill(
        json({
          success: true,
          data: {
            workspace: url.searchParams.get('path') ?? '',
            workspaceIsRepo: false,
            repos: [],
          },
        }),
      );
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });
}

async function fillStable(page: Page, selector: string, value: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const locator = page.locator(selector).first();
    try {
      await locator.fill(value, { timeout: 1_000 });
      if ((await locator.inputValue().catch(() => '')) === value) {
        return;
      }
    } catch {}
    await locator.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {});
  }

  throw new Error(`Failed to fill stable input: ${selector}`);
}

const DEEP_SEGMENTS = Array.from(
  { length: 9 },
  (_, index) => `deeply-nested-directory-segment-${index}`,
).join('/');

/** Working directories past 200 characters, in the shapes that broke #2799. */
const LONG_WORKING_DIRECTORIES = {
  'no spaces': `/private/var/folders/zz/${DEEP_SEGMENTS}/station-project-home`,
  'with spaces': `/Users/someone/Library/Application Support/${DEEP_SEGMENTS.replaceAll('-', ' ')}/station project home`,
  'one unbroken segment': `/tmp/${'unbroken'.repeat(28)}`,
} as const;

/** Serves the `long-path` Project with whatever directory the test sets. */
async function routeLongPathProject(page: Page) {
  const project = { workingDirectory: '' };
  await page.route(/\/api\/projects\/long-path(?:\?|$)/, async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          id: 'p-long-path',
          slug: 'long-path',
          name: 'Long Path Project',
          workingDirectory: project.workingDirectory,
          layouts: [],
          hasWorkingDirectory: true,
          layoutCount: 0,
          hasKnowledge: false,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
        },
      }),
    );
  });
  return project;
}

/**
 * A start-truncated path line: its text reads as one path. Laid out as flex
 * items, the parent and leaf read (innerText) and selected as two lines with
 * a line break between them (#2799 review). The Settings preview can be
 * selected and copied; the Project page line sits inside its edit button.
 */
async function expectPathReadsWhole(
  line: Locator,
  parts: { parent: string; leaf: string },
  value: string,
  label: string,
  context: string,
) {
  expect(
    await line.evaluate((node) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
      const selected = selection.toString();
      selection.removeAllRanges();
      return { innerText: (node as HTMLElement).innerText, selected };
    }),
    `${context}: read and copied text`,
  ).toEqual({ innerText: value, selected: value });

  // The line keeps its end: the leaf finishes at the line's right edge, and
  // it is cut only when it alone is wider than the line (the Project page
  // header gives a phone about 140px, less than many folder names). One
  // snapshot: the shell's sidebar can still be settling after a resize.
  const geometry = await line.evaluate((node, selectors) => {
    const lineBox = node.getBoundingClientRect();
    const leaf = node.querySelector(selectors.leaf)!.getBoundingClientRect();
    const text = node.querySelector(selectors.parent)!.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - 1);
    range.setEnd(text, text.textContent!.length);
    return {
      lineLeft: lineBox.left,
      lineRight: lineBox.right,
      lineWidth: lineBox.width,
      leafLeft: leaf.left,
      leafRight: leaf.right,
      leafWidth: leaf.width,
      separatorRight: range.getBoundingClientRect().right,
    };
  }, parts);
  expect(
    Math.abs(geometry.leafRight - geometry.lineRight),
    `${context}: leaf ends the line`,
  ).toBeLessThanOrEqual(1);
  if (geometry.leafLeft < geometry.lineLeft - 0.5) {
    expect(
      geometry.leafWidth,
      `${context}: leaf cut only when wider than the line`,
    ).toBeGreaterThan(geometry.lineWidth);
    return;
  }
  expect(label, `${context}: leaf shown whole`).not.toBe(
    'one unbroken segment',
  );
  // The parent's last separator is drawn against the leaf. Without the ltr
  // isolate the rtl line reorders the neutral separators: the parent's
  // trailing `/` is drawn at its far (cut) end instead.
  expect(
    Math.abs(geometry.separatorRight - geometry.leafLeft),
    `${context}: separator adjoins the leaf`,
  ).toBeLessThanOrEqual(1);
}

/** A path that fits is not pushed right by the rtl line: it starts at the left. */
async function expectShortPathStartsLeft(line: Locator, context: string) {
  const { start, left } = await line.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      start: range.getClientRects()[0]!.left,
      left: node.getBoundingClientRect().left,
    };
  });
  expect(
    Math.abs(start - left),
    `${context}: short path starts at the left`,
  ).toBeLessThanOrEqual(1);
}

test.describe('Project forms', () => {
  test.beforeEach(async ({ page }) => {
    await seedProjectFormRoutes(page);
  });

  test('new project prioritizes working directory and derives the name from the path leaf', async ({
    page,
  }) => {
    const nonexistentProjectRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/projects/new') {
        nonexistentProjectRequests.push(request.url());
      }
    });
    await page.goto('/projects/new');

    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();
    await expect.poll(() => nonexistentProjectRequests).toEqual([]);

    await fillStable(page, 'input[placeholder="/path/to/project"]', '/tmp');

    const nameInput = page.locator('input[placeholder="My Project"]');
    await expect(nameInput).toHaveValue('Tmp');

    await fillStable(page, 'input[placeholder="My Project"]', 'Launchpad');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page).toHaveURL(/\/projects\/launchpad$/);
    expect(nonexistentProjectRequests).toEqual([]);
  });

  test('project detail and edit routes retain the intended project context', async ({
    page,
  }) => {
    const projectRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.match(/^\/api\/projects\/[^/]+$/)) {
        projectRequests.push(path);
      }
    });

    await page.goto('/projects/demo');
    await expect(
      page.getByRole('heading', { name: 'Demo Project' }),
    ).toBeVisible();
    await page.goto('/projects/demo/edit');
    await expect(page.locator('.project-settings__name-input')).toHaveValue(
      'Demo Project',
    );

    expect(projectRequests.length).toBeGreaterThanOrEqual(2);
    expect(projectRequests.every((path) => path === '/api/projects/demo')).toBe(
      true,
    );
  });

  /**
   * #2799, in a real browser: jsdom has no layout, so only Chromium can say
   * whether a long working directory leaves the Workspace section intact. On
   * main the header's identity preview never shrank, so an unbreakable path
   * took the whole row: the description collapsed to a one-word column, the
   * avatar landed on the heading, and the "saved as" pill ran out of the card.
   */
  test('a long working directory leaves the Workspace section header, description and controls intact at 360px, 768px and 1280px (#2799)', async ({
    page,
  }) => {
    // Three paths at three widths, every measurement a browser round trip:
    // about 10s on a quiet host, past the 30s default on a loaded one.
    test.setTimeout(90_000);
    const project = await routeLongPathProject(page);

    const section = page.locator('#section-workspace');
    const box = async (selector: string, context: string) => {
      const rect = await section.locator(selector).boundingBox();
      expect(rect, `${context}: ${selector} box`).not.toBeNull();
      return rect!;
    };
    const intersects = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) =>
      a.x < b.x + b.width &&
      b.x < a.x + a.width &&
      a.y < b.y + b.height &&
      b.y < a.y + a.height;

    // The one-line treatment is for a path. With no directory the preview
    // prints a sentence, which has to wrap rather than be cut at 320px.
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/projects/demo/edit');
    const unset = section.locator('.project-settings__identity-path');
    await expect(unset).toHaveText('No working directory configured');
    expect(
      await unset.evaluate((node) => node.scrollWidth <= node.clientWidth),
      'unset preview text shown whole at 320px',
    ).toBe(true);

    for (const [label, value] of Object.entries(LONG_WORKING_DIRECTORIES)) {
      expect(value.length, `${label}: fixture length`).toBeGreaterThan(200);
      project.workingDirectory = value;
      await page.goto('/projects/long-path/edit');
      await expect(section.locator('#project-working-directory')).toHaveValue(
        value,
      );
      for (const width of [360, 768, 1280]) {
        const context = `${label} at ${width}px`;
        await page.setViewportSize({ width, height: 900 });

        const card = await box(':scope', context);
        const inside = async (selector: string) => {
          const rect = await box(selector, context);
          expect(
            rect.x,
            `${context}: ${selector} left edge`,
          ).toBeGreaterThanOrEqual(card.x - 0.5);
          expect(
            rect.x + rect.width,
            `${context}: ${selector} right edge`,
          ).toBeLessThanOrEqual(card.x + card.width + 0.5);
          return rect;
        };

        // The description keeps a readable measure: on main it was squeezed
        // to the width of its longest word (about 60px) at every width where
        // the header is a row.
        const description = await inside('.page-section__description');
        expect(
          description.width,
          `${context}: description width`,
        ).toBeGreaterThanOrEqual(240);

        // Nothing in the header sits on anything else.
        const eyebrow = await inside('.page-section__eyebrow');
        const title = await inside('.page-section__title');
        const preview = await inside('.project-settings__identity-preview');
        for (const [name, rect] of [
          ['eyebrow', eyebrow],
          ['title', title],
          ['description', description],
        ] as const) {
          expect(
            intersects(rect, preview),
            `${context}: identity preview over the ${name}`,
          ).toBe(false);
        }

        // The preview keeps the leaf folder in view and offers the whole
        // path; the pill below prints the whole path, wrapped inside the card.
        const previewPath = section.locator('.project-settings__identity-path');
        const previewLine = await inside('.project-settings__identity-path');
        // One line (18px at this size), never a wrapped block.
        expect(
          previewLine.height,
          `${context}: preview path is one line`,
        ).toBeLessThan(30);
        await expect(previewPath).toHaveAttribute('title', value);
        await expectPathReadsWhole(
          previewPath,
          {
            parent: '.project-settings__identity-path-parent',
            leaf: '.project-settings__identity-path-leaf',
          },
          value,
          label,
          context,
        );
        const savedAs = section
          .locator('.project-settings__path-pill')
          .filter({ hasText: 'saved as' });
        await expect(savedAs.locator('code')).toHaveText(value);
        for (const pill of await section
          .locator('.project-settings__path-pill')
          .all()) {
          const rect = (await pill.boundingBox())!;
          expect(
            rect.x + rect.width,
            `${context}: path pill right edge`,
          ).toBeLessThanOrEqual(card.x + card.width + 0.5);
          // The value stays inside its pill, and the pill's label ("leaf",
          // "saved as") stays on one line however far the value wraps.
          const code = (await pill.locator('code').boundingBox())!;
          expect(
            code.x + code.width,
            `${context}: path pill value right edge`,
          ).toBeLessThanOrEqual(rect.x + rect.width + 0.5);
          expect(
            await pill.evaluate((node) => {
              const range = document.createRange();
              range.selectNodeContents(node.firstChild!);
              return range.getClientRects().length;
            }),
            `${context}: path pill label lines`,
          ).toBe(1);
        }

        const field = await inside('#project-working-directory');
        expect(field.width, `${context}: input width`).toBeGreaterThan(200);
        if (width === 360) {
          expect(
            field.height,
            `${context}: input touch target`,
          ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        }

        expect(
          await page.evaluate(() => {
            const body = document.querySelector('.project-settings__body');
            return (
              document.documentElement.scrollWidth <= window.innerWidth &&
              body !== null &&
              body.scrollWidth <= body.clientWidth
            );
          }),
          `${context}: no horizontal overflow`,
        ).toBe(true);
      }
    }
    project.workingDirectory = '/srv/demo';
    await page.goto('/projects/long-path/edit');
    const short = section.locator('.project-settings__identity-path');
    await expect(short).toHaveText('/srv/demo');
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expectShortPathStartsLeft(short, `short path at ${width}px`);
    }
  });

  /**
   * The Project page header draws the same start-truncated path (#304's
   * treatment) and had the same flex split, so its text read as two lines
   * (#2799 review). It sits inside the edit button, which names the path.
   */
  test('the Project page header path reads and copies as one path with its leaf in view at 360px, 768px and 1280px (#2799)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const project = await routeLongPathProject(page);
    for (const [label, value] of Object.entries(LONG_WORKING_DIRECTORIES)) {
      project.workingDirectory = value;
      await page.goto('/projects/long-path');
      const line = page.locator('.project-page__dir-path');
      await expect(line).toBeVisible();
      for (const width of [360, 768, 1280]) {
        const context = `${label} at ${width}px`;
        await page.setViewportSize({ width, height: 900 });
        await expectPathReadsWhole(
          line,
          {
            parent: '.project-page__dir-parent',
            leaf: '.project-page__dir-leaf',
          },
          value,
          label,
          context,
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `${context}: no horizontal overflow`,
        ).toBe(true);
      }
    }
    project.workingDirectory = '/srv/demo';
    await page.goto('/projects/long-path');
    const short = page.locator('.project-page__dir-path');
    await expect(short).toHaveText('/srv/demo');
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expectShortPathStartsLeft(short, `short path at ${width}px`);
    }
  });

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    test(`new project keeps actions reachable with a mobile keyboard at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.emulateMedia({
        colorScheme: viewport.width === 320 ? 'light' : 'dark',
        reducedMotion: viewport.width === 320 ? 'reduce' : 'no-preference',
      });
      await page.setViewportSize(viewport);
      await installVisualViewportFixture(page);
      await page.addInitScript(() => {
        localStorage.setItem(
          'recentLayouts',
          JSON.stringify(['plugin:planning-board']),
        );
      });
      await page.route('**/api/projects/layouts/available', (route) =>
        route.fulfill(json({ success: true, data: STARTER_CATALOG })),
      );
      await page.goto('/projects/new');

      await page.evaluate(() => {
        (
          window as Window & {
            __setTestVisualViewport?: (height: number) => void;
          }
        ).__setTestVisualViewport?.(360);
      });

      const overlay = page.locator('.responsive-surface-overlay');
      await expect(overlay).toHaveCSS('height', '360px');
      await expect(overlay).toHaveCSS('overflow', 'hidden');

      await page.getByPlaceholder('My Project').fill('Keyboard-safe project');
      await page
        .getByPlaceholder('/path/to/project')
        .fill('/tmp/keyboard-safe');
      await expect(page.getByText('Recent on this device')).toBeVisible();
      await page.getByRole('button', { name: 'Browse all' }).click();
      const browser = page.getByRole('dialog', {
        name: 'Browse installed layouts',
      });
      await expect(browser).toBeVisible();
      const browserBox = await browser.boundingBox();
      expect(browserBox?.height).toBeLessThanOrEqual(360);
      expect(browserBox?.x).toBeGreaterThanOrEqual(0);
      expect(
        (browserBox?.x ?? 0) + (browserBox?.width ?? 0),
      ).toBeLessThanOrEqual(viewport.width);
      await browser.getByRole('button', { name: /Planning board/ }).click();
      await expect(browser).toHaveCount(0);
      await expect(page.getByPlaceholder('My Project')).toHaveValue(
        'Keyboard-safe project',
      );
      await expect(page.getByPlaceholder('/path/to/project')).toHaveValue(
        '/tmp/keyboard-safe',
      );

      if (viewport.width === 390) {
        const directory = page.getByPlaceholder('/path/to/project');
        await directory.fill('/tmp/d');
        const option = page.locator('.path-autocomplete__option', {
          hasText: 'demo',
        });
        await expect(option).toBeVisible();
        expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
        await page.getByPlaceholder('My Project').click();
        await expect(option).toBeHidden();
      }

      const create = page.getByRole('button', {
        name: 'Create',
        exact: true,
      });
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport();

      const panelBox = await page
        .getByRole('dialog', { name: 'New Project' })
        .boundingBox();
      expect(panelBox?.height).toBeLessThanOrEqual(360);
      expect(panelBox?.x).toBeGreaterThanOrEqual(0);
      expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );

      await page.setViewportSize({
        width: viewport.height,
        height: viewport.width,
      });
      await page.evaluate(() => {
        (
          window as Window & {
            __setTestVisualViewport?: (height: number) => void;
          }
        ).__setTestVisualViewport?.(280);
      });
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  }

  /**
   * #1014: the folder browser is now reachable from New Project's Working
   * Directory field via a Browse button wired into `PathAutocomplete`
   * itself. This pins the mobile-keyboard case the shared component must
   * not regress: opening the browser must not unmount the form (the #998
   * class — a remount-plus-return-focus race left a stale 200ms blur timer
   * that could dismiss the suggestion dropdown after the fact), so picking a
   * folder must land the value in the field AND leave the suggestion
   * dropdown working afterward.
   */
  test('new project Browse button picks a folder and leaves suggestions working at 390x844 (#998 class)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installVisualViewportFixture(page);
    await page.goto('/projects/new');

    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();

    const directory = page.getByPlaceholder('/path/to/project');
    const browseButton = page.getByRole('button', {
      name: 'Browse for a folder',
    });
    const browseBox = await browseButton.boundingBox();
    expect(browseBox?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(browseBox?.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await browseButton.click();
    const browser = page.getByRole('dialog', { name: 'Select Folder' });
    await expect(browser).toBeVisible();

    // The dialog must fit inside the reduced mobile viewport, not just the
    // nominal one.
    const browserBox = await browser.boundingBox();
    expect(browserBox?.x).toBeGreaterThanOrEqual(0);
    expect((browserBox?.x ?? 0) + (browserBox?.width ?? 0)).toBeLessThanOrEqual(
      390,
    );

    const entry = browser.getByRole('button', { name: 'demo' });
    await expect(entry).toBeVisible();
    expect((await entry.boundingBox())?.height).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET_PX,
    );

    await browser.getByRole('button', { name: 'Select This Folder' }).click();
    await expect(browser).toHaveCount(0);
    await expect(directory).toHaveValue('/tmp/');

    // The #998 class: the form must not have unmounted (and re-mounted) to
    // show the browser, so the suggestion dropdown must still work — a
    // stale blur timer from the remount-plus-return-focus race is what
    // dismissed it historically.
    await directory.fill('/tmp/d');
    const option = page.locator('.path-autocomplete__option', {
      hasText: 'demo',
    });
    await expect(option).toBeVisible();
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ]) {
    test(`new project footer clears the starter card at ${viewport.width}x${viewport.height} (#959)`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => {
        localStorage.setItem(
          'recentLayouts',
          JSON.stringify(['plugin:planning-board']),
        );
      });
      await page.route('**/api/projects/layouts/available', (route) =>
        route.fulfill(json({ success: true, data: STARTER_CATALOG })),
      );
      await page.goto('/projects/new');

      const starter = page.locator('.new-project-modal__starter');
      const footer = page.locator('.new-project-modal__actions');
      await expect(starter).toBeVisible();
      await starter.scrollIntoViewIfNeeded();

      const geometry = await page.evaluate(() => {
        const overlay = document.querySelector('.responsive-surface-overlay');
        const panel = document.querySelector('.new-project-modal');
        const form = document.querySelector('.new-project-modal__form');
        const scroll = document.querySelector(
          '.new-project-modal__draft-scroll',
        );
        const card = document.querySelector('.new-project-modal__starter');
        const actions = document.querySelector('.new-project-modal__actions');
        if (!overlay || !panel || !form || !scroll || !card || !actions)
          return null;
        const overlayBox = overlay.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        const formBox = form.getBoundingClientRect();
        const scrollBox = scroll.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        const actionsBox = actions.getBoundingClientRect();
        return {
          overlayBottom: overlayBox.bottom,
          panelBottom: panelBox.bottom,
          formBottom: formBox.bottom,
          scrollBottom: scrollBox.bottom,
          cardBottom: cardBox.bottom,
          footerTop: actionsBox.top,
          footerBottom: actionsBox.bottom,
          scrollHeight: scroll.scrollHeight,
          clientHeight: scroll.clientHeight,
          overflowY: getComputedStyle(scroll).overflowY,
        };
      });

      expect(geometry).not.toBeNull();
      expect(geometry!.panelBottom).toBeLessThanOrEqual(
        geometry!.overlayBottom,
      );
      expect(geometry!.formBottom).toBeLessThanOrEqual(geometry!.panelBottom);
      expect(geometry!.overflowY).toBe('auto');
      expect(geometry!.scrollHeight).toBeGreaterThan(geometry!.clientHeight);
      // The card must be reachable and clear of the footer; an exact scroll
      // offset is incidental and changes when fonts or viewport metrics settle.
      expect(geometry!.cardBottom).toBeLessThanOrEqual(
        geometry!.scrollBottom + 1,
      );
      expect(geometry!.scrollBottom).toBeLessThanOrEqual(geometry!.footerTop);
      expect(geometry!.cardBottom).toBeLessThanOrEqual(geometry!.footerTop);
      expect(geometry!.footerBottom).toBeLessThanOrEqual(geometry!.panelBottom);
      await expect(footer).toBeInViewport();
    });
  }

  /**
   * #765 residue (F7-class): two independent audit passes saw real pointer
   * clicks on Create ignored while a programmatic click "worked". The state
   * half — a verdict-less directory check disabling Create under "Try
   * again." copy — is pinned in NewProjectModal.test.tsx. This pins the
   * geometry half at the audit's exact viewport: with the path-suggestion
   * dropdown open (the historical over-painting suspect,
   * PathAutocomplete.tsx s202 Wave 4), the footer controls must own their
   * own centers (`elementFromPoint` answers "who paints here", the trial
   * click answers "who would receive the event"), and a REAL coordinate
   * click on Create must submit.
   */
  test('new project footer receives real pointer clicks at 1440x900 with the path dropdown open', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/projects/new');
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();

    // A trailing slash keeps every mocked suggestion eligible, so the
    // dropdown is genuinely open when the pointer goes for the footer.
    await fillStable(page, 'input[placeholder="/path/to/project"]', '/tmp/');
    await expect(page.locator('.path-autocomplete__option')).toBeVisible();
    await expect(page.locator('input[placeholder="My Project"]')).toHaveValue(
      'Tmp',
    );

    for (const name of ['Cancel', 'Create']) {
      const control = page.getByRole('button', { name, exact: true });
      const box = await control.boundingBox();
      expect(box, `${name} rendered no box`).toBeTruthy();
      const owner = await page.evaluate(
        ([x, y]) => {
          const element = document.elementFromPoint(x, y);
          return (
            element?.closest('button')?.textContent ??
            (element instanceof HTMLElement ? element.className : 'nothing')
          );
        },
        [box!.x + box!.width / 2, box!.y + box!.height / 2] as const,
      );
      expect(owner, `who paints at ${name}'s center`).toContain(name);
      await control.click({ trial: true, timeout: 3_000 });
    }

    const create = page.getByRole('button', { name: 'Create', exact: true });
    const createBox = (await create.boundingBox())!;
    await page.mouse.click(
      createBox.x + createBox.width / 2,
      createBox.y + createBox.height / 2,
    );
    await expect(page).toHaveURL(/\/projects\/tmp$/);
  });
});
