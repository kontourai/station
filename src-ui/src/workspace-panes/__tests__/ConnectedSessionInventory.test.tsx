/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { chromium, expect as expectPlaywright } from '@playwright/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../tests/helpers/css-cascade-fixture';
import { commitSessionInventorySelection } from '../sessionInventorySelection';

const hooks = vi.hoisted(() => ({
  inventory: vi.fn(),
  page: vi.fn(),
  inspection: vi.fn(),
  tasks: vi.fn(),
  keep: vi.fn(),
  answer: vi.fn(),
  authority: {
    apiBase: 'http://station.test',
    authorityKey: 'epoch-a',
  },
}));

vi.mock('@kontourai/station-sdk/session-inventory', () => ({
  useSessionInventoryQuery: (...args: unknown[]) => hooks.inventory(...args),
  useSessionInventoryGroupPage: (...args: unknown[]) => hooks.page(...args),
}));
vi.mock('@kontourai/station-sdk/session-outputs', () => ({
  useSessionOutputInspection: (...args: unknown[]) => hooks.inspection(...args),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useTasksQuery: (...args: unknown[]) => hooks.tasks(...args),
}));
vi.mock('@kontourai/station-sdk/session-output-actions', () => ({
  useKeepSessionOutputMutation: () => ({
    isPending: false,
    mutateAsync: hooks.keep,
  }),
}));
vi.mock('@kontourai/station-sdk/answer-basis', () => ({
  useAnswerBasisQuery: (...args: unknown[]) => hooks.answer(...args),
}));
vi.mock('@kontourai/surface/basis/view', () => ({
  buildBasisPanelViewModel: () => ({
    title: 'Current answer',
    standing: { label: 'Grounded', description: 'Owner-backed.' },
    gaps: [],
    assessment: {
      claimStatus: 'supported',
      freshness: 'current',
      evidence: [
        {
          id: 'evidence',
          label: 'Evidence',
          items: Array.from({ length: 21 }, (_, index) => ({
            id: `evidence-${index + 1}`,
            label: `Evidence ${index + 1}`,
            source: 'owner',
            observedAt: 'now',
          })),
        },
      ],
    },
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => hooks.authority,
}));

const output = {
  kind: 'station-session-output' as const,
  key: 'output',
  owner: { owner: 'thread', id: 'output' },
  relations: ['produced-by'] as const,
  output: {
    ref: { sessionId: 'session', eventId: 'event-output' },
    turnId: 'turn',
    toolCallId: 'call',
    declaredAt: '2026-08-27T00:00:00.000Z',
    label: 'report.txt',
    descriptor: {
      kind: 'workspace-file' as const,
      relativePath: 'report.txt',
      digest: 'a'.repeat(64),
      length: 1,
    },
  },
};

const projection: SessionInventoryProjection = {
  version: 'station.session-inventory/v1',
  scope: { kind: 'whole-session', sessionId: 'session' },
  groups: [
    {
      id: 'outputs',
      owner: { owner: 'thread', id: 'outputs' },
      state: 'available',
      count: { kind: 'at-least', value: 2 },
      items: [output],
      continuation: 'next-outputs',
      gaps: [],
    },
  ],
};

const requestScope = {
  apiBase: 'http://station.test',
  authorityKey: 'epoch-a',
};
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../index.css');
const INVENTORY_CSS_PATH = resolve(HERE, '../SessionInventory.css');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

function workItemInventory(nativeId = '1234567890') {
  return {
    version: 'station.session-inventory/v2',
    scope: projection.scope,
    groups: [
      {
        id: 'work-items',
        owner: { owner: 'station.session-work-items', id: 'v1' },
        state: 'available',
        count: { kind: 'exact', value: 1 },
        gaps: [],
        items: [
          {
            kind: 'station-session-work-item',
            key: 'work-item:association-235',
            owner: { owner: 'station.session-work-items', id: 'v1' },
            relations: ['observed-during', 'produced-by'],
            sessionId: 'session',
            conversationId: 'conversation',
            eventId: 'event',
            turnId: 'turn',
            toolCallId: 'call',
            provider: { id: 'github', host: 'github.com' },
            workItemRef: 'github:kontourai/station#235',
            repository: { owner: 'kontourai', name: 'station' },
            nativeId,
            associationIds: ['association-235'],
            observedAt: '2026-08-28T12:00:00.000Z',
          },
        ],
      },
    ],
  };
}

function buildInventoryFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(INVENTORY_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

function renderWorkItemMarkup(): string {
  configure();
  hooks.inventory.mockReturnValue({
    data: workItemInventory() as never,
    isLoading: false,
    error: null,
  });
  const view = render(
    <ConnectedSessionInventory
      sessionId="session"
      currentProjectId="project"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Work items, 1 item' }));
  const markup = view.container.innerHTML;
  view.unmount();
  return markup;
}

function configure() {
  hooks.inventory.mockReturnValue({
    data: projection,
    isLoading: false,
    error: null,
  });
  hooks.page.mockReturnValue({ data: undefined });
  hooks.inspection.mockReturnValue({
    data: { kind: 'metadata' },
    isLoading: false,
    error: null,
  });
  hooks.tasks.mockReturnValue({
    data: [{ id: 'task-a', title: 'Task A' }],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  hooks.keep.mockResolvedValue({ outcome: 'kept' });
  hooks.answer.mockReturnValue({
    data: { protected: 'answer' },
    isLoading: false,
    error: null,
  });
}

const { ConnectedSessionInventory } = await import(
  '../ConnectedSessionInventory'
);

describe('ConnectedSessionInventory', () => {
  test('keeps compact chip text independent of channel accent contrast', () => {
    const css = readFileSync(INVENTORY_CSS_PATH, 'utf8');
    // Beta, nightly, and user accents may be intentionally vivid. Tone stays
    // in the border/tint; readable chip text must remain on the canonical
    // theme foreground rather than inheriting the channel accent.
    expect(css).toMatch(
      /\.session-inventory__state,\s*\.session-inventory__classification\s*\{[^}]*color:\s*var\(--text-primary\)/,
    );
    expect(css).toMatch(
      /\.session-inventory__item--kept \.session-inventory__classification\s*\{[^}]*color:\s*var\(--text-primary\)/,
    );
    expect(css).toMatch(
      /^\.session-inventory__classification\s*\{[^}]*color:\s*var\(--text-primary\)/m,
    );
  });

  test('renders only a valid structured work item as a safe keyboard link', () => {
    configure();
    hooks.inventory.mockReturnValue({
      data: workItemInventory() as never,
      isLoading: false,
      error: null,
    });
    const view = render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Work items, 1 item' }));
    const itemSelection = screen.getByRole('button', {
      name: 'Select item 1 in Work items',
    });
    const link = screen.getByRole('link', {
      name: 'Open work item github:kontourai/station#235 in github kontourai/station',
    });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/kontourai/station/issues/235',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // Both controls remain in normal keyboard order: selection first, then
    // the semantic link, whose native Enter behavior follows its href.
    itemSelection.focus();
    expect(document.activeElement).toBe(itemSelection);
    link.focus();
    expect(document.activeElement).toBe(link);

    view.unmount();
    hooks.inventory.mockReturnValue({
      data: workItemInventory('0') as never,
      isLoading: false,
      error: null,
    });
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('defers inspection, paging, and Task reads until their explicit actions', async () => {
    configure();
    hooks.inspection.mockClear();
    hooks.tasks.mockClear();
    hooks.page.mockClear();
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    expect(hooks.inspection).not.toHaveBeenCalled();
    expect(hooks.tasks).not.toHaveBeenCalled();
    expect(hooks.page).toHaveBeenLastCalledWith(
      expect.anything(),
      'inputs',
      undefined,
      expect.objectContaining({ enabled: false, requestScope }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Outputs, at least 2 items' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect output' }));
    await waitFor(() =>
      expect(hooks.inspection).toHaveBeenLastCalledWith(
        'session',
        'event-output',
        expect.objectContaining({ enabled: true, requestScope }),
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close Session output' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() =>
      expect(hooks.page).toHaveBeenLastCalledWith(
        expect.anything(),
        'outputs',
        'next-outputs',
        expect.objectContaining({ enabled: true, requestScope }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    await waitFor(() =>
      expect(hooks.tasks).toHaveBeenLastCalledWith(
        'project',
        expect.objectContaining({ enabled: true, requestScope }),
      ),
    );
  });

  test('keeps only in the explicitly selected Task with the captured authority', async () => {
    configure();
    hooks.keep.mockClear();
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Outputs, at least 2 items' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    fireEvent.click(await screen.findByRole('button', { name: /Task A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() =>
      expect(hooks.keep).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-a',
          sessionId: 'session',
          eventId: 'event-output',
          requestScope,
        }),
      ),
    );
  });

  test('fails closed and retries when an authorized page is denied', async () => {
    configure();
    const refetch = vi.fn();
    hooks.page.mockImplementation(
      (_scope: unknown, _group: unknown, continuation: unknown) =>
        continuation
          ? { data: undefined, error: new Error('denied'), refetch }
          : { data: undefined, error: null, refetch },
    );
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Outputs, at least 2 items' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
    expect(screen.queryByText('report.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry page' }));
    expect(refetch).toHaveBeenCalled();
  });

  test('retains the preview and every authorized page while continuations advance', async () => {
    configure();
    const second = {
      ...output,
      key: 'output-2',
      output: {
        ...output.output,
        ref: { sessionId: 'session', eventId: 'event-2' },
        label: 'page two',
      },
    };
    const third = {
      ...output,
      key: 'output-3',
      output: {
        ...output.output,
        ref: { sessionId: 'session', eventId: 'event-3' },
        label: 'page three',
      },
    };
    hooks.page.mockImplementation(
      (_scope: unknown, _group: unknown, continuation: unknown) => {
        if (continuation === 'next-outputs')
          return {
            data: {
              version: projection.version,
              scope: projection.scope,
              group: {
                ...projection.groups[0]!,
                items: [output, second],
                continuation: 'third-page',
              },
            },
            error: null,
          };
        if (continuation === 'third-page')
          return {
            data: {
              version: projection.version,
              scope: projection.scope,
              group: { ...projection.groups[0]!, items: [third] },
            },
            error: null,
          };
        return { data: undefined, error: null };
      },
    );
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Outputs, at least 2 items' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() => expect(screen.getByText('page two')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() => expect(screen.getByText('page three')).toBeTruthy());
    expect(screen.getByText('report.txt')).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: /Select item \d+ in Outputs/ }),
    ).toHaveLength(3);
  });

  test('does not publish a late kept result after the bound pane unmounts', async () => {
    configure();
    let resolve: (value: { outcome: 'kept' }) => void = () => {};
    hooks.keep.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    commitSessionInventorySelection(
      { ...requestScope, sessionId: 'session' },
      {
        scope: { kind: 'kept-in-task', sessionId: 'session', taskId: 'task-a' },
        groupId: 'outputs',
      },
    );
    hooks.inventory.mockReturnValue({
      data: {
        ...projection,
        scope: { kind: 'kept-in-task', sessionId: 'session', taskId: 'task-a' },
      },
      isLoading: false,
      error: null,
    });
    const view = render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    expect(hooks.keep).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-a',
        requestScope,
      }),
    );
    view.unmount();
    resolve({ outcome: 'kept' });
    await Promise.resolve();
    expect(screen.queryByText('Kept')).toBeNull();
  });

  test('keeps current-answer assessment disclosure and evidence windows local to its authority tuple', () => {
    configure();
    const current = {
      kind: 'current-answer' as const,
      sessionId: 'session',
      turnId: 'turn-a',
    };
    commitSessionInventorySelection(
      { ...requestScope, sessionId: 'session' },
      { scope: current, groupId: 'inputs' },
    );
    hooks.inventory.mockReturnValue({
      data: {
        ...projection,
        scope: current,
        basis: {} as never,
        basisBinding: {} as never,
      },
      isLoading: false,
      error: null,
    });
    const view = render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    const assessment = screen.getByText('Assessment').closest('details');
    expect(assessment?.open).toBe(false);
    fireEvent.click(screen.getByText('Assessment'));
    expect(assessment?.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show more Evidence' }));
    expect(screen.getByText(/^Evidence 21/)).toBeTruthy();
    fireEvent.click(screen.getByText('Assessment'));
    fireEvent.click(screen.getByText('Assessment'));
    expect(screen.getByText(/^Evidence 21/)).toBeTruthy();

    hooks.authority = {
      apiBase: 'http://station.test',
      authorityKey: 'epoch-b',
    };
    commitSessionInventorySelection(
      { ...hooks.authority, sessionId: 'session' },
      { scope: current, groupId: 'inputs' },
    );
    view.rerender(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    const reauthorizedAssessment = screen
      .getByText('Assessment')
      .closest('details');
    expect(reauthorizedAssessment?.open).toBe(false);
    expect(screen.queryByText(/^Evidence 21/)).toBeNull();
    hooks.authority = requestScope;
  });

  test('does not turn whole-Session inventory into an aggregate standing', () => {
    configure();
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    expect(screen.queryByText('Grounded')).toBeNull();
    expect(screen.getByText('What this session contains')).toBeTruthy();
    expect(screen.getByText('Session inventory')).toBeTruthy();
  });
});

describe.skipIf(!chromiumAvailable)(
  'ConnectedSessionInventory work-item link browser behavior',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    test('keeps the derived GitHub link in keyboard tab order and activates it natively', async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.route('https://github.com/**', (route) =>
          route.fulfill({ status: 200, body: '<title>GitHub issue</title>' }),
        );
        await page.setContent(
          `<!doctype html><style>${buildInventoryFixtureCss()}</style>${renderWorkItemMarkup()}`,
        );
        const selection = page.getByRole('button', {
          name: 'Select item 1 in Work items',
        });
        const link = page.getByRole('link', {
          name: 'Open work item github:kontourai/station#235 in github kontourai/station',
        });
        await expectPlaywright(link).toHaveAttribute(
          'href',
          'https://github.com/kontourai/station/issues/235',
        );
        await expectPlaywright(link).toHaveAttribute('target', '_blank');
        await expectPlaywright(link).toHaveAttribute(
          'rel',
          'noopener noreferrer',
        );
        await selection.focus();
        await page.keyboard.press('Tab');
        await expectPlaywright(link).toBeFocused();
        const popup = page.waitForEvent('popup');
        await page.keyboard.press('Enter');
        const popupPage = await popup;
        await popupPage.waitForLoadState('domcontentloaded');
        expectPlaywright(popupPage.url()).toBe(
          'https://github.com/kontourai/station/issues/235',
        );
        await popupPage.close();
      } finally {
        await page.close();
      }
    });

    test('adapts desktop, phone, and narrow-pane geometry without horizontal overflow', async () => {
      const markup = renderWorkItemMarkup();
      const css = buildInventoryFixtureCss();
      const page = await browser.newPage({
        viewport: { width: 1152, height: 768 },
      });
      try {
        await page.setContent(
          `<!doctype html><style>${css}</style><main id="fixture">${markup}</main>`,
        );
        const inventory = page.locator('.session-inventory');
        const rail = page.locator('.session-inventory__index');
        const selector = page.locator(
          '.session-inventory__compact-selector-label',
        );
        const detail = page.locator('.session-inventory__detail');

        await expectPlaywright(rail).toHaveCSS('display', 'grid');
        await expectPlaywright(selector).toHaveCSS('display', 'none');
        const desktopInventory = await inventory.boundingBox();
        const desktopDetail = await detail.boundingBox();
        expect(desktopInventory).not.toBeNull();
        expect(desktopDetail).not.toBeNull();
        expect(desktopDetail!.x).toBeGreaterThan(desktopInventory!.x + 150);
        expect(
          await page.evaluate(() => document.body.scrollWidth),
        ).toBeLessThanOrEqual(1152);

        await page.setViewportSize({ width: 390, height: 844 });
        await expectPlaywright(rail).toHaveCSS('display', 'none');
        await expectPlaywright(selector).toHaveCSS('display', 'grid');
        const selectBox = await selector.locator('select').boundingBox();
        const phoneDetail = await detail.boundingBox();
        const phoneItem = await page
          .locator('.session-inventory__item')
          .boundingBox();
        const phoneAction = await page
          .getByRole('link', { name: /Open work item/ })
          .boundingBox();
        expect(selectBox?.height).toBeGreaterThanOrEqual(44);
        expect(phoneDetail).not.toBeNull();
        expect(phoneItem).not.toBeNull();
        expect(phoneAction).not.toBeNull();
        expect(phoneAction!.width).toBeGreaterThanOrEqual(
          phoneItem!.width - 32,
        );
        expect(phoneDetail!.x).toBeGreaterThanOrEqual(0);
        expect(phoneDetail!.x + phoneDetail!.width).toBeLessThanOrEqual(390);
        expect(
          await page.evaluate(() => document.body.scrollWidth),
        ).toBeLessThanOrEqual(390);

        await page.setViewportSize({ width: 1152, height: 600 });
        await page.locator('#fixture').evaluate((node) => {
          (node as HTMLElement).style.width = '420px';
        });
        await expectPlaywright(rail).toHaveCSS('display', 'none');
        await expectPlaywright(selector).toHaveCSS('display', 'grid');
        expect(
          await page.evaluate(
            () => document.querySelector('#fixture')!.scrollWidth,
          ),
        ).toBeLessThanOrEqual(420);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'ConnectedSessionInventory work-item link browser behavior — Chromium not installed',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the work-item link keyboard behavior cannot be verified. Run npm run install:playwright and retry.',
    );
  },
);
