/** @vitest-environment jsdom */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { chromium, expect as expectPlaywright } from '@playwright/test';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../tests/helpers/touch-target';
import { commitSessionInventorySelection } from '../sessionInventorySelection';

const hooks = vi.hoisted(() => ({
  inventory: vi.fn(),
  showSurface: vi.fn(),
  input: vi.fn(),
  tool: vi.fn(),
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

vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => hooks.showSurface,
}));
// The real modules, with only their hooks replaced: the drill-down
// classifies failures with the clients' own error classes.
vi.mock('@kontourai/station-sdk/task-tool-results', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionToolResultQuery: (...args: unknown[]) => hooks.tool(...args),
}));

vi.mock('@kontourai/station-sdk/session-inventory', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionInventoryInput: (...args: unknown[]) => hooks.input(...args),
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
const AXE_PATH = resolve(REPO_ROOT, 'node_modules/axe-core/axe.min.js');

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

const inputInventory = {
  ...projection,
  groups: [
    {
      id: 'inputs',
      owner: { owner: 'thread.canonical-events', id: 'v1' },
      state: 'available',
      count: { kind: 'exact', value: 1 },
      gaps: [],
      items: [
        {
          kind: 'thread-authored-input',
          key: 'input:input-a',
          owner: { owner: 'thread.canonical-events', id: 'v1' },
          relations: ['provided-to'],
          sessionId: 'station:1792851837813:session:b1f09152',
          eventId: 'input-a',
          turnId: 'turn',
          inputKind: 'message',
          attachmentDescriptors: [],
        },
      ],
    },
  ],
} as unknown as SessionInventoryProjection;

/** A crashed turn: one command reported, one never did (#4178). */
const noResultInventory = {
  ...projection,
  groups: [
    {
      id: 'execution',
      owner: { owner: 'thread.canonical-events', id: 'v1' },
      state: 'available',
      count: { kind: 'exact', value: 2 },
      gaps: [],
      items: [
        {
          kind: 'thread-tool-result',
          key: 'tool:tool-done',
          owner: { owner: 'thread.canonical-events', id: 'v1' },
          relations: ['observed-during'],
          sessionId: 'session',
          eventId: 'tool-done',
          turnId: 'turn',
          toolCallId: 'call-done',
          name: 'Bash',
          terminalStatus: 'succeeded',
        },
        {
          kind: 'thread-tool-result',
          key: 'tool:tool-open',
          owner: { owner: 'thread.canonical-events', id: 'v1' },
          relations: ['observed-during'],
          sessionId: 'session',
          eventId: 'tool-open',
          turnId: 'turn',
          toolCallId: 'call-open',
          name: 'Read',
          terminalStatus: 'unresolved',
        },
      ],
    },
  ],
} as unknown as SessionInventoryProjection;

/** The drill-down for one authored input, opened, under `inputState`. */
function openInputDetails(inputState: Record<string, unknown>) {
  configure();
  hooks.inventory.mockReturnValue({
    data: inputInventory,
    isLoading: false,
    error: null,
  });
  hooks.input.mockReturnValue({
    data: undefined,
    error: null,
    hostSupport: 'supported',
    refetch: vi.fn(),
    ...inputState,
  });
  const view = render(<ConnectedSessionInventory sessionId="session" />);
  fireEvent.click(screen.getByRole('button', { name: 'Inputs 1' }));
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Authored message View details',
    }),
  );
  return view;
}

function renderInputDetailsMarkup(inputState: Record<string, unknown>) {
  const view = openInputDetails(inputState);
  const markup = view.container.innerHTML;
  view.unmount();
  return markup;
}

const SUCCESS_INPUT = {
  data: { prompt: 'Continue', attachments: [] },
  hostSupport: 'supported',
};
const UNSUPPORTED_HOST_INPUT = { hostSupport: 'unsupported' };

function buildInventoryFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(INVENTORY_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

function renderWorkItemMarkup(inventory = workItemInventory()): string {
  configure();
  hooks.inventory.mockReturnValue({
    data: inventory as never,
    isLoading: false,
    error: null,
  });
  const view = render(
    <ConnectedSessionInventory
      sessionId="session"
      currentProjectId="project"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Work items 1' }));
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
  test('selecting an input opens its actual prompt and selecting a tool opens the recorded result', () => {
    configure();
    hooks.input.mockReturnValue({
      data: {
        prompt: 'Compare the two invoices, including tax.',
        attachments: [
          { name: 'invoice.pdf', mediaType: 'application/pdf', size: 2048 },
        ],
      },
      error: null,
    });
    hooks.tool.mockReturnValue({
      data: {
        name: 'read_file',
        terminalStatus: 'succeeded',
        content: [{ type: 'text', text: 'Invoice total: $120.00' }],
        truncated: false,
      },
      error: null,
    });
    hooks.inventory.mockReturnValue({
      data: {
        ...projection,
        groups: [
          {
            id: 'inputs',
            owner: { owner: 'thread', id: 'inputs' },
            state: 'available',
            count: { kind: 'exact', value: 1 },
            gaps: [],
            items: [
              {
                kind: 'thread-authored-input',
                key: 'input-a',
                owner: { owner: 'thread', id: 'input-a' },
                relations: ['observed-during'],
                sessionId: 'session',
                eventId: 'input-a',
                turnId: 'turn',
                inputKind: 'message',
                attachmentDescriptors: [],
              },
            ],
          },
          {
            id: 'execution',
            owner: { owner: 'thread', id: 'execution' },
            state: 'available',
            count: { kind: 'exact', value: 1 },
            gaps: [],
            items: [
              {
                kind: 'thread-tool-result',
                key: 'tool-a',
                owner: { owner: 'thread', id: 'tool-a' },
                relations: ['observed-during'],
                sessionId: 'session',
                eventId: 'tool-a',
                turnId: 'turn',
                toolCallId: 'call-a',
                name: 'read_file',
                terminalStatus: 'succeeded',
              },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    hooks.input.mockClear();
    hooks.tool.mockClear();
    const onDismiss = vi.fn();
    render(
      <ConnectedSessionInventory sessionId="session" onDismiss={onDismiss} />,
    );
    expect(
      screen.queryByText('Compare the two invoices, including tax.'),
    ).toBeNull();
    expect(hooks.input).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Authored message View details',
      }),
    );
    expect(
      screen.getByText('Compare the two invoices, including tax.'),
    ).toBeTruthy();
    expect(screen.getByText(/invoice.pdf.*2,048 bytes/)).toBeTruthy();
    expect(hooks.input).toHaveBeenCalledWith(
      'session',
      'input-a',
      'turn',
      requestScope,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Execution 1$/ }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'read_file View details',
      }),
    );
    expect(screen.getByText('Invoice total: $120.00')).toBeTruthy();
    expect(hooks.tool).toHaveBeenCalledWith('session', 'tool-a', {
      requestScope,
    });
    expect(
      screen.queryByText('Compare the two invoices, including tax.'),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(hooks.showSurface).toHaveBeenCalledWith('activity', {
      session: 'session',
    });
  });

  test('a command with no recorded result is listed, counted, and named without an outcome', () => {
    configure();
    hooks.inventory.mockReturnValue({
      data: noResultInventory,
      isLoading: false,
      error: null,
    });
    hooks.tool.mockClear();
    render(<ConnectedSessionInventory sessionId="session" />);
    // Counted in the Execution tile, like the transcript's "1 with no result".
    fireEvent.click(screen.getByRole('button', { name: /^Execution 2$/ }));
    const rows = [...document.querySelectorAll('.session-inventory__item')];
    expect(rows).toHaveLength(2);
    const [succeeded, open] = rows;
    expect(succeeded!.textContent).not.toContain('No result recorded');
    const badge = open!.querySelector('.status');
    expect(badge?.textContent).toBe('No result recorded');
    // The shared status primitive, in its neutral tone.
    expect(badge?.classList.contains('tone-neutral')).toBe(true);
    for (const outcome of ['Cancelled', 'cancelled', 'Failed', 'failed'])
      expect(open!.textContent).not.toContain(outcome);

    fireEvent.click(screen.getByRole('button', { name: 'Read View details' }));
    const details = screen.getByRole('region', { name: 'Read details' });
    expect(details.textContent).toContain('No result recorded.');
    expect(details.textContent).toContain(
      'This command never reported an outcome, so whether it ran is unknown.',
    );
    // Neither boundary is claimed: engines settle at session or turn end.
    expect(details.textContent).not.toMatch(/turn ended|session ended/);
    expect(screen.queryByRole('alert')).toBeNull();
    // Nothing is read for a result that was never recorded.
    expect(hooks.tool).not.toHaveBeenCalledWith(
      'session',
      'tool-open',
      expect.anything(),
    );
    expect(
      within(details).getByRole('button', { name: 'Open session' }),
    ).toBeTruthy();
  });

  test('an input on a host that does not serve the read says so, suggests an update, and can check again', () => {
    const recheckHost = vi.fn();
    openInputDetails({ ...UNSUPPORTED_HOST_INPUT, recheckHost });
    const failure = screen.getByRole('alert');
    // #4177: hosted deployments also withdraw the flag, so the copy must not
    // claim the host is outdated; it only offers updating as one remedy.
    expect(failure.textContent).toContain(
      "This Station can't show input details",
    );
    expect(failure.textContent).toContain('update Station on the host');
    expect(failure.textContent).not.toContain('runs an older version');
    // Not a retry of the read: a re-ask of the host, for after it updates.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(
      [...failure.querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['Check again', 'Open session']);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(recheckHost).toHaveBeenCalledOnce();
    expect(screen.queryByText('Recorded origin')).toBeNull();
  });

  test('Check again shows a pending check, then says the host still lacks input details', () => {
    const view = openInputDetails({
      ...UNSUPPORTED_HOST_INPUT,
      recheckHost: vi.fn(),
      hostRecheck: 'checking',
    });
    const pending = screen.getByRole('button', { name: 'Check again' });
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    // Busy, not disabled: the focused button keeps focus, and a second press
    // during the check sends nothing.
    expect((pending as HTMLButtonElement).disabled).toBe(false);
    pending.focus();
    fireEvent.click(pending);
    expect(document.activeElement).toBe(pending);
    expect(
      hooks.input.mock.results.at(-1)?.value.recheckHost,
    ).not.toHaveBeenCalled();
    hooks.input.mockReturnValue({
      data: undefined,
      error: null,
      refetch: vi.fn(),
      ...UNSUPPORTED_HOST_INPUT,
      recheckHost: vi.fn(),
      hostRecheck: 'still-unsupported',
    });
    view.rerender(<ConnectedSessionInventory sessionId="session" />);
    const failure = screen.getByRole('alert');
    expect(failure.textContent).toContain(
      "This Station still can't show input details",
    );
    expect(failure.textContent).toContain(
      "Checked again just now: the Station host this app is connected to still doesn't offer input details.",
    );
    // A hosted deployment never serves the read; the result must not call
    // the host outdated.
    expect(failure.textContent).not.toMatch(/still on an older version/i);
    const again = screen.getByRole('button', { name: 'Check again' });
    expect(again.getAttribute('aria-busy')).toBeNull();
    expect(again.getAttribute('aria-disabled')).toBeNull();
  });

  test('when Check again finds the host now serves the read, focus moves to the details instead of the page', () => {
    const view = openInputDetails({
      ...UNSUPPORTED_HOST_INPUT,
      recheckHost: vi.fn(),
      hostRecheck: 'idle',
    });
    const again = screen.getByRole('button', { name: 'Check again' });
    again.focus();
    expect(document.activeElement).toBe(again);
    // The recheck answered: the host serves the read, and it is loading.
    hooks.input.mockReturnValue({
      data: undefined,
      error: null,
      refetch: vi.fn(),
      hostSupport: 'supported',
      recheckHost: vi.fn(),
      hostRecheck: 'idle',
    });
    view.rerender(<ConnectedSessionInventory sessionId="session" />);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    const details = screen.getByRole('region', {
      name: 'Authored message details',
    });
    // Inside the dialog, where Escape still works, not on the page.
    expect(document.activeElement).toBe(details);
    // And it stays there as the body arrives.
    hooks.input.mockReturnValue({ ...SUCCESS_INPUT, error: null });
    view.rerender(<ConnectedSessionInventory sessionId="session" />);
    expect(screen.getByText('Continue')).toBeTruthy();
    expect(document.activeElement).toBe(details);
  });

  test('when Check again succeeds after the user moved focus elsewhere, focus stays where the user put it', () => {
    const view = openInputDetails({
      ...UNSUPPORTED_HOST_INPUT,
      recheckHost: vi.fn(),
      hostRecheck: 'idle',
    });
    // The user has moved on to the row's own toggle, outside the panel.
    const toggle = screen.getByRole('button', {
      name: 'Authored message Hide details',
    });
    toggle.focus();
    hooks.input.mockReturnValue({
      data: undefined,
      error: null,
      refetch: vi.fn(),
      hostSupport: 'supported',
      recheckHost: vi.fn(),
      hostRecheck: 'idle',
    });
    view.rerender(<ConnectedSessionInventory sessionId="session" />);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  test.each([
    [404, "This input isn't available", false],
    [403, "This input isn't available", false],
    [200, "This input couldn't be shown", false],
    [503, "This input didn't load", true],
    [0, "This input didn't load", true],
  ])(
    'a read that failed with %s says why and offers a retry only when one can help',
    async (status, title, retryable) => {
      const { SessionInventoryRequestError } = await import(
        '@kontourai/station-sdk/session-inventory'
      );
      const refetch = vi.fn();
      openInputDetails({
        error: new SessionInventoryRequestError(status),
        refetch,
      });
      const failure = screen.getByRole('alert');
      expect(failure.textContent).toContain(title);
      expect(screen.queryByText('Recorded origin')).toBeNull();
      const retry = screen.queryByRole('button', { name: 'Try again' });
      expect(Boolean(retry)).toBe(retryable);
      if (retry) {
        fireEvent.click(retry);
        expect(refetch).toHaveBeenCalledOnce();
      }
    },
  );

  test.each([
    ['pane', 1],
    ['host', 0],
  ] as const)(
    'with the title owned by the %s, the inventory shows %i title of its own',
    (titleOwner, ownTitles) => {
      configure();
      hooks.inventory.mockReturnValue({
        data: inputInventory,
        isLoading: false,
        error: null,
      });
      render(
        <ConnectedSessionInventory
          sessionId="session"
          titleOwner={titleOwner}
        />,
      );
      expect(
        screen.queryAllByRole('heading', { level: 2, name: 'Chat inventory' }),
      ).toHaveLength(ownTitles);
      // Named either way, and the description and Scope stay.
      expect(
        screen.getByRole('region', { name: 'Chat inventory' }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          'A navigable record of what Station is authorized to show.',
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole('group', { name: 'Inventory scope' }),
      ).toBeTruthy();
    },
  );

  test('the drill-down cue says what a press will do, and a second press closes it', () => {
    openInputDetails(SUCCESS_INPUT);
    const open = screen.getByRole('button', {
      name: 'Authored message Hide details',
    });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('region', { name: 'Authored message details' }),
    ).toBeTruthy();
    fireEvent.click(open);
    const closed = screen.getByRole('button', {
      name: 'Authored message View details',
    });
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.queryByRole('region', { name: 'Authored message details' }),
    ).toBeNull();
  });

  test('a read input shows its text, then its recorded origin and Open session', () => {
    openInputDetails(SUCCESS_INPUT);
    const details = screen.getByRole('region', {
      name: 'Authored message details',
    });
    expect(details.querySelector('pre')?.textContent).toBe('Continue');
    expect(screen.getByText('Recorded origin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open session' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Work items 1' }));
    const itemSelection = screen.getByRole('button', {
      name: / View details$/,
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
      screen.getByRole('button', { name: 'Outputs 2+, at least 2 items' }),
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
      screen.getByRole('button', { name: 'Outputs 2+, at least 2 items' }),
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

  test('keeps an inventory on screen when only its refresh failed, and offers Retry', () => {
    configure();
    const refetch = vi.fn();
    hooks.inventory.mockReturnValue({
      data: projection,
      isLoading: false,
      error: new Error('Session inventory unavailable'),
      refetch,
    });
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Outputs 2+, at least 2 items' }),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'Couldn’t refresh this inventory',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  test('names a first read that failed as unavailable, with Retry', () => {
    configure();
    const refetch = vi.fn();
    hooks.inventory.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Session inventory unavailable'),
      refetch,
    });
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
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
      screen.getByRole('button', { name: 'Outputs 2+, at least 2 items' }),
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
      screen.getByRole('button', { name: 'Outputs 2+, at least 2 items' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() => expect(screen.getByText('page two')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() => expect(screen.getByText('page three')).toBeTruthy());
    expect(screen.getByText('report.txt')).toBeTruthy();
    expect(
      screen.getAllByRole('button', {
        name: / View details$/,
      }),
    ).toHaveLength(3);
  });

  test('does not publish a late kept result onto a Task selected while the keep was pending', async () => {
    configure();
    let resolve: (value: { outcome: 'kept' }) => void = () => {};
    hooks.keep.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const selectTask = (taskId: string) => {
      const scope = {
        kind: 'kept-in-task' as const,
        sessionId: 'session',
        taskId,
      };
      hooks.inventory.mockReturnValue({
        data: { ...projection, scope },
        isLoading: false,
        error: null,
      });
      commitSessionInventorySelection(
        { ...requestScope, sessionId: 'session' },
        { scope, groupId: 'outputs' },
      );
    };
    selectTask('task-a');
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    expect(hooks.keep).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-a', requestScope }),
    );
    // The pane stays mounted; only the kept-in Task changes under the keep.
    act(() => selectTask('task-b'));
    expect(screen.getByRole('button', { name: 'Keep file' })).toBeTruthy();
    await act(async () => {
      resolve({ outcome: 'kept' });
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).toBeNull();
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
    expect(screen.getByText('Chat inventory')).toBeTruthy();
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
          name: / View details$/,
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
        // The shared floor constant, not a bare `44`: this is a raw
        // `boundingBox()` float, and an exact-integer comparison is not a
        // faithful encoding of "meets the 44px touch floor" under float
        // layout — a sibling suite measured 43.99999237060547 for a control
        // styled to exactly 44 and red on it (#2086).
        expect(selectBox?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
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

    test('lays out a command with no recorded result at phone and desktop widths', async () => {
      const css = buildInventoryFixtureCss();
      configure();
      hooks.inventory.mockReturnValue({
        data: noResultInventory,
        isLoading: false,
        error: null,
      });
      const view = render(<ConnectedSessionInventory sessionId="session" />);
      fireEvent.click(screen.getByRole('button', { name: /^Execution 2$/ }));
      const markup = view.container.innerHTML;
      view.unmount();
      for (const width of [390, 1440]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        try {
          await page.setContent(
            `<!doctype html><style>${css}</style><main>${markup}</main>`,
          );
          const label = `${width}px`;
          const item = page.locator('.session-inventory__item').nth(1);
          const itemBox = await item.boundingBox();
          const badge = item.locator('.session-inventory__item-status');
          await expectPlaywright(badge).toHaveCount(1);
          const badgeBox = await badge.boundingBox();
          const toggle = item.getByRole('button', {
            name: 'Read View details',
          });
          const toggleBox = await toggle.boundingBox();
          expect(badgeBox, label).not.toBeNull();
          // The shared primitive's styles applied, not an unstyled div.
          await expectPlaywright(badge).not.toHaveCSS(
            'border-top-width',
            '0px',
          );
          // As wide as its words, inside the card, and the title row keeps
          // its 44px target beside or below it.
          expect(badgeBox!.width, label).toBeLessThan(itemBox!.width / 2);
          expect(badgeBox!.x, label).toBeGreaterThanOrEqual(itemBox!.x);
          expect(badgeBox!.x + badgeBox!.width, label).toBeLessThanOrEqual(
            itemBox!.x + itemBox!.width,
          );
          expect(toggleBox!.height, label).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
          expect(
            await page.evaluate(() => document.body.scrollWidth),
            label,
          ).toBeLessThanOrEqual(width);
        } finally {
          await page.close();
        }
      }
    });

    test('lays out the input drill-down at phone and desktop widths, read and failed', async () => {
      const css = buildInventoryFixtureCss();
      for (const [state, inputState] of [
        ['read', SUCCESS_INPUT],
        ['unsupported host', UNSUPPORTED_HOST_INPUT],
      ] as const) {
        const markup = renderInputDetailsMarkup(inputState);
        for (const width of [390, 1152]) {
          const page = await browser.newPage({
            viewport: { width, height: 844 },
          });
          try {
            await page.setContent(
              `<!doctype html><style>${css}</style><main>${markup}</main>`,
            );
            const label = `${state} at ${width}px`;
            const item = await page
              .locator('.session-inventory__item')
              .boundingBox();
            const chip = await page
              .locator('.session-inventory__classification')
              .boundingBox();
            const toggle = page.getByRole('button', {
              name: /^Authored message (View|Hide) details$/,
            });
            const toggleBox = await toggle.boundingBox();
            const title = await toggle
              .locator('.session-inventory__label')
              .boundingBox();
            const cue = await toggle
              .locator('.session-inventory__item-cue')
              .boundingBox();
            expect(item, label).not.toBeNull();
            // The chip is as wide as its word, not the card.
            expect(chip!.width, label).toBeLessThan(item!.width / 3);
            // One 44px row: the title leads, the cue trails on the same line
            // at the inline end, so the two never stack into one heading.
            expect(toggleBox!.height, label).toBeGreaterThanOrEqual(
              MIN_TOUCH_TARGET_PX,
            );
            expect(
              Math.abs(
                cue!.y + cue!.height / 2 - (title!.y + title!.height / 2),
              ),
              label,
            ).toBeLessThan(4);
            expect(cue!.x, label).toBeGreaterThanOrEqual(
              title!.x + title!.width,
            );
            expect(
              Math.abs(cue!.x + cue!.width - (toggleBox!.x + toggleBox!.width)),
              label,
            ).toBeLessThan(16);
            // Every action is a 44px target on its own row under the copy
            // it acts on, never wrapped beside a sentence.
            const actions = page.locator(
              '.session-inventory__item-details button',
            );
            const details = await page
              .locator('.session-inventory__item-details')
              .boundingBox();
            const count = await actions.count();
            expect(count, label).toBeGreaterThan(0);
            const copy =
              state === 'read'
                ? await page
                    .locator('.session-inventory__item-details pre')
                    .boundingBox()
                : await page.locator('.empty__description').boundingBox();
            for (let index = 0; index < count; index += 1) {
              const box = await actions.nth(index).boundingBox();
              expect(box!.height, label).toBeGreaterThanOrEqual(
                MIN_TOUCH_TARGET_PX,
              );
              expect(box!.y, label).toBeGreaterThanOrEqual(
                copy!.y + copy!.height - 0.5,
              );
              // On a phone an action spans the body (its box less 1rem
              // padding and a 1px border per side), like the row actions.
              if (width === 390)
                expect(box!.width, label).toBeGreaterThanOrEqual(
                  details!.width - 2 * (16 + 1) - 0.5,
                );
              // On a desktop it is as wide as its label.
              else expect(box!.width, label).toBeLessThan(details!.width / 2);
            }
            expect(
              await page.evaluate(() => document.body.scrollWidth),
              label,
            ).toBeLessThanOrEqual(width);
            // WCAG 2.5.3 on the real rendered tree: every named control in
            // the inventory (tiles, index rail, item toggle, actions) has an
            // accessible name that contains its visible label.
            await page.addScriptTag({ path: AXE_PATH });
            const mismatches = await page.evaluate(async () => {
              const axe = (
                window as unknown as {
                  axe: {
                    run(
                      context: unknown,
                      options: unknown,
                    ): Promise<{
                      violations: {
                        id: string;
                        nodes: { target: string[] }[];
                      }[];
                    }>;
                  };
                }
              ).axe;
              const result = await axe.run(
                { include: [['.session-inventory']] },
                {
                  runOnly: {
                    type: 'rule',
                    values: ['label-content-name-mismatch', 'button-name'],
                  },
                },
              );
              return result.violations.flatMap((violation) =>
                violation.nodes.map(
                  (node) => `${violation.id}:${node.target.join(' ')}`,
                ),
              );
            });
            expect(mismatches, label).toEqual([]);
          } finally {
            await page.close();
          }
        }
      }
    });

    test('keeps compact chip text on the theme foreground under a vivid channel accent', async () => {
      // Beta, nightly, and user accents may be intentionally vivid. Tone stays
      // in the border/tint; readable chip text must resolve to the canonical
      // theme foreground rather than inheriting any accent.
      const kept = workItemInventory();
      kept.groups[0]!.items[0]!.relations = ['observed-during', 'kept-in-task'];
      const css = buildInventoryFixtureCss();
      const page = await browser.newPage({
        viewport: { width: 1152, height: 768 },
      });
      try {
        await page.setContent(
          `<!doctype html><html data-app-channel="nightly"><style>${css}
          :root { --accent-primary: rgb(255, 0, 255); --success-text: rgb(0, 255, 0); --warning-text: rgb(255, 255, 0); }
          </style><main>${renderWorkItemMarkup()}${renderWorkItemMarkup(kept)}</main>
          <span id="foreground" style="color: var(--text-primary)">probe</span></html>`,
        );
        const foreground = await page
          .locator('#foreground')
          .evaluate((node) => getComputedStyle(node).color);
        expect(foreground).not.toBe('rgb(255, 0, 255)');
        const chips = [
          page.locator('.session-inventory__state').first(),
          page
            .locator(
              '.session-inventory__item:not(.session-inventory__item--kept) .session-inventory__classification',
            )
            .first(),
          page
            .locator(
              '.session-inventory__item--kept .session-inventory__classification',
            )
            .first(),
        ];
        for (const chip of chips)
          expect(
            await chip.evaluate((node) => getComputedStyle(node).color),
          ).toBe(foreground);
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
