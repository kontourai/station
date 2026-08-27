/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

// Mutable SDK query/mutation state, reset per test.
const state = {
  flow: { data: undefined as unknown },
  readiness: { data: undefined as unknown, isLoading: false, error: null },
  bundles: { data: undefined as unknown, isLoading: false, error: null },
  trustReport: { data: undefined as unknown, isLoading: false, error: null },
  initReadinessResult: undefined as unknown,
};

const initFlowMutate = vi.fn();
const initReadinessMutate = vi.fn();
const refreshMutate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useFlowDefinitionsQuery: () => state.flow,
  useReadinessQuery: () => state.readiness,
  useRefreshReadinessMutation: () => ({
    mutate: refreshMutate,
    isPending: false,
    error: null,
  }),
  useTrustBundlesQuery: () => state.bundles,
  useTrustReportQuery: () => state.trustReport,
  useInitFlowMutation: () => ({
    mutate: initFlowMutate,
    isPending: false,
    error: null,
    data: undefined,
  }),
  useInitReadinessMutation: () => ({
    mutate: initReadinessMutate,
    isPending: false,
    error: null,
    data: state.initReadinessResult,
  }),
}));

import {
  CodingInspectorPanel,
  CodingInspectorStrip,
  type InspectorTabState,
  useInspectorTabs,
} from '../components/coding-layout/CodingInspectorPanel';

function harnessTabs(): InspectorTabState[] {
  return [
    { id: 'plan', configured: false, attention: false },
    { id: 'readiness', configured: false, attention: false },
    { id: 'trust', configured: false, attention: false },
  ];
}

function renderPanel(
  overrides: Partial<Parameters<typeof CodingInspectorPanel>[0]> = {},
) {
  return render(
    <CodingInspectorPanel
      projectSlug="dev"
      tabs={overrides.tabs ?? harnessTabs()}
      activeTab={overrides.activeTab ?? 'plan'}
      onSelectTab={overrides.onSelectTab ?? vi.fn()}
      onCollapse={overrides.onCollapse ?? vi.fn()}
      artifact={overrides.artifact ?? null}
      sessionTitle={overrides.sessionTitle ?? null}
      runtimeState={overrides.runtimeState}
    />,
  );
}

beforeEach(() => {
  state.flow = { data: undefined };
  state.readiness = { data: undefined, isLoading: false, error: null };
  state.bundles = { data: undefined, isLoading: false, error: null };
  state.trustReport = { data: undefined, isLoading: false, error: null };
  state.initReadinessResult = undefined;
  clipboardAbsent();
  initFlowMutate.mockClear();
  initReadinessMutate.mockClear();
  refreshMutate.mockClear();
});

describe('CodingInspectorPanel — tabs', () => {
  test('renders a tab bar and the active tab body', () => {
    renderPanel({ activeTab: 'plan' });
    expect(
      screen.getByRole('tablist', { name: 'Coding inspector' }),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Readiness' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Trust' })).toBeTruthy();
  });

  test('includes attention state in the tab name while keeping the dot decorative', () => {
    const tabs = harnessTabs();
    tabs[1] = { ...tabs[1], attention: true };
    const { container } = renderPanel({ tabs });

    expect(
      screen.getByRole('tab', { name: 'Readiness, needs attention' }),
    ).toBeTruthy();
    expect(
      container
        .querySelector('.coding-inspector__tab-badge')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  test('each tab renders its Kontour product mark (Plan→flow, Readiness→veritas, Trust→surface)', () => {
    const { container } = renderPanel({ activeTab: 'plan' });
    expect(
      container.querySelector(
        '.coding-inspector__tab-icon[data-product="flow"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '.coding-inspector__tab-icon[data-product="veritas"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '.coding-inspector__tab-icon[data-product="surface"]',
      ),
    ).toBeTruthy();
    // The marks are real SVGs, not the old Unicode glyphs.
    expect(
      container.querySelector('svg.coding-inspector__tab-icon'),
    ).toBeTruthy();
  });

  test('clicking a tab calls onSelectTab', () => {
    const onSelectTab = vi.fn();
    renderPanel({ onSelectTab });
    fireEvent.click(screen.getByRole('tab', { name: 'Readiness' }));
    expect(onSelectTab).toHaveBeenCalledWith('readiness');
  });

  test('the collapse button calls onCollapse', () => {
    const onCollapse = vi.fn();
    renderPanel({ onCollapse });
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse inspector panel' }),
    );
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe('CodingInspectorPanel — Plan tab', () => {
  test('not-configured shows the "Add a delivery flow" CTA and confirms before init', () => {
    state.flow = { data: { initialized: false, definitions: [] } };
    renderPanel({ activeTab: 'plan' });

    expect(screen.getByText('No delivery flow')).toBeTruthy();
    const cta = screen.getByRole('button', { name: 'Add a delivery flow' });
    fireEvent.click(cta);

    // A confirm dialog appears; init only fires after confirm.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(initFlowMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add flow' }));
    expect(initFlowMutate).toHaveBeenCalledTimes(1);
  });

  test('configured renders the workflow plan panel, not the CTA', () => {
    state.flow = {
      data: {
        initialized: true,
        definitions: [{ id: 'd', path: 'p', valid: true }],
      },
    };
    renderPanel({
      activeTab: 'plan',
      tabs: [
        { id: 'plan', configured: true, attention: false },
        { id: 'readiness', configured: false, attention: false },
        { id: 'trust', configured: false, attention: false },
      ],
    });
    expect(screen.queryByText('No delivery flow')).toBeNull();
    expect(screen.getByText('Workflow plan')).toBeTruthy();
  });
});

describe('CodingInspectorPanel — Readiness tab', () => {
  test('not-configured shows the "Set up readiness" CTA and confirms before init', () => {
    state.readiness = {
      data: { configured: false, reason: 'no-veritas-dir' },
      isLoading: false,
      error: null,
    };
    renderPanel({ activeTab: 'readiness' });

    expect(screen.getByText('Veritas not configured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up readiness' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(initReadinessMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(initReadinessMutate).toHaveBeenCalledTimes(1);
  });
});

describe('CodingInspectorPanel — Trust tab', () => {
  test('renders guidance and a docs link, no one-click action', () => {
    state.bundles = { data: [], isLoading: false, error: null };
    renderPanel({ activeTab: 'trust' });
    expect(screen.getByText(/Trust bundles/)).toBeTruthy();
    // Guidance docs link is present; there is no init button.
    expect(
      screen.getByRole('link', { name: 'How trust bundles work' }),
    ).toBeTruthy();
  });
});

describe('CodingInspectorStrip — collapsed', () => {
  test('renders per-tool product marks and expands on click', () => {
    const onExpand = vi.fn();
    const { container } = render(
      <CodingInspectorStrip
        tabs={[
          { id: 'plan', configured: false, attention: false },
          { id: 'readiness', configured: true, attention: true },
          { id: 'trust', configured: false, attention: false },
        ]}
        onExpand={onExpand}
      />,
    );
    expect(
      screen.getByRole('region', { name: 'Coding inspector (collapsed)' })
        .tagName,
    ).toBe('SECTION');
    // The strip icons are the real product marks, keyed by product.
    expect(
      container.querySelector(
        '.coding-inspector-strip__icon-mark[data-product="flow"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '.coding-inspector-strip__icon-mark[data-product="veritas"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '.coding-inspector-strip__icon-mark[data-product="surface"]',
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: /Open Readiness, needs attention/ }),
    );
    expect(onExpand).toHaveBeenCalledWith('readiness');
  });
});

describe('useInspectorTabs', () => {
  test('derives configured flags and a readiness attention badge', () => {
    state.flow = { data: { initialized: true, definitions: [] } };
    state.readiness = {
      data: { configured: true, overall: 'not-ready' },
      isLoading: false,
      error: null,
    };
    state.bundles = { data: [], isLoading: false, error: null };

    let captured: ReturnType<typeof useInspectorTabs> | null = null;
    function Probe() {
      captured = useInspectorTabs('dev');
      return null;
    }
    render(<Probe />);

    expect(captured!.anyConfigured).toBe(true);
    const plan = captured!.tabs.find((t) => t.id === 'plan')!;
    const readiness = captured!.tabs.find((t) => t.id === 'readiness')!;
    const trust = captured!.tabs.find((t) => t.id === 'trust')!;
    expect(plan.configured).toBe(true);
    expect(readiness.configured).toBe(true);
    expect(readiness.attention).toBe(true);
    expect(trust.configured).toBe(false);
  });

  test('anyConfigured is false when nothing is set up', () => {
    state.flow = { data: { initialized: false, definitions: [] } };
    state.readiness = {
      data: { configured: false, reason: 'no-veritas-dir' },
      isLoading: false,
      error: null,
    };
    state.bundles = { data: [], isLoading: false, error: null };

    let captured: ReturnType<typeof useInspectorTabs> | null = null;
    function Probe() {
      captured = useInspectorTabs('dev');
      return null;
    }
    render(<Probe />);
    expect(captured!.anyConfigured).toBe(false);
  });
});

// station#3341 Class B: `await navigator.clipboard?.writeText(command)` inside
// a try/catch RESOLVES when there is no clipboard at all, so the insecure-origin
// case — the one this button most needs to report — rendered "Copied".
describe('CodingInspectorPanel — copyable setup command', () => {
  function renderNoCliCta() {
    state.readiness = {
      data: { configured: false, reason: 'no-veritas-dir' },
      isLoading: false,
      error: null,
    };
    state.initReadinessResult = {
      outcome: 'no-cli',
      command: 'npx veritas init --non-interactive',
    };
    return renderPanel({ activeTab: 'readiness' });
  }

  function copyButton() {
    return screen.getByRole('button', {
      name: /Copy command|Copied|Can't copy/,
    });
  }

  test('reports the copy only once the write resolved', async () => {
    const writeText = clipboardWrites();
    renderNoCliCta();

    fireEvent.click(copyButton());

    expect(writeText).toHaveBeenCalledWith(
      'npx veritas init --non-interactive',
    );
    await waitFor(() => expect(copyButton().textContent).toBe('Copied'));
  });

  test('a refused write never claims a copy', async () => {
    clipboardRefuses();
    renderNoCliCta();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.queryByText('Copied')).toBeNull();
  });

  test('an insecure origin with no clipboard API never claims a copy', async () => {
    clipboardAbsent();
    renderNoCliCta();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
