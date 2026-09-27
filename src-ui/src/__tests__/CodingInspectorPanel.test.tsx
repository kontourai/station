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
  readiness: { data: undefined as unknown, isLoading: false, error: null },
  bundles: { data: undefined as unknown, isLoading: false, error: null },
  trustReport: { data: undefined as unknown, isLoading: false, error: null },
  initReadinessResult: undefined as unknown,
};

const initFlowMutate = vi.fn();
const initReadinessMutate = vi.fn();
const refreshMutate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
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

// The content components the builtin workspace pane registry mounts for the
// Coding Plan, Readiness and Trust panes (`builtinWorkspacePaneRegistry.tsx`).
import {
  ReadinessInspectorContent,
  TrustInspectorContent,
  WorkflowPlanInspectorContent,
} from '../components/coding-layout/CodingInspectorPanel';

beforeEach(() => {
  state.readiness = { data: undefined, isLoading: false, error: null };
  state.bundles = { data: undefined, isLoading: false, error: null };
  state.trustReport = { data: undefined, isLoading: false, error: null };
  state.initReadinessResult = undefined;
  clipboardAbsent();
  initFlowMutate.mockClear();
  initReadinessMutate.mockClear();
  refreshMutate.mockClear();
});

describe('WorkflowPlanInspectorContent — the Coding Plan pane', () => {
  test('not-configured shows the "Add a delivery flow" CTA and confirms before init', () => {
    render(
      <WorkflowPlanInspectorContent
        projectSlug="dev"
        artifact={null}
        configured={false}
      />,
    );

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
    render(
      <WorkflowPlanInspectorContent
        projectSlug="dev"
        artifact={null}
        configured
      />,
    );
    expect(screen.queryByText('No delivery flow')).toBeNull();
    expect(screen.getByText('Workflow plan')).toBeTruthy();
  });
});

describe('ReadinessInspectorContent — the Coding Readiness pane', () => {
  test('not-configured shows the "Set up readiness" CTA and confirms before init', () => {
    state.readiness = {
      data: { configured: false, reason: 'no-veritas-dir' },
      isLoading: false,
      error: null,
    };
    render(<ReadinessInspectorContent projectSlug="dev" />);

    expect(screen.getByText('Veritas not configured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up readiness' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(initReadinessMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(initReadinessMutate).toHaveBeenCalledTimes(1);
  });
});

describe('TrustInspectorContent — the Coding Trust pane', () => {
  test('renders guidance and a docs link, no one-click action', () => {
    state.bundles = { data: [], isLoading: false, error: null };
    render(<TrustInspectorContent projectSlug="dev" />);
    expect(screen.getByText(/Trust bundles/)).toBeTruthy();
    // Guidance docs link is present; there is no init button.
    expect(
      screen.getByRole('link', { name: 'How trust bundles work' }),
    ).toBeTruthy();
  });
});

// archive#3341 Class B: `await navigator.clipboard?.writeText(command)` inside
// a try/catch RESOLVES when there is no clipboard at all, so the insecure-origin
// case — the one this button most needs to report — rendered "Copied".
describe('ReadinessInspectorContent — copyable setup command', () => {
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
    return render(<ReadinessInspectorContent projectSlug="dev" />);
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

  // The command is a fallback the UI cannot perform itself; the note has to
  // say why (CLI missing, Station runs it for you otherwise) so the bare
  // command does not read as "leave the app" with no reason given.
  test('the copy-command fallback says why it exists', () => {
    renderNoCliCta();

    const note = screen.getByText(/cannot run the setup for you/);
    expect(note.textContent).toContain('downloads the CLI');
    expect(note.textContent).toContain('.veritas/');
  });

  // ONE failure case here, not the primitive's matrix. Which clipboard states
  // resolve `false` (absent, no `writeText`, rejected, throwing) is
  // `copyToClipboard`'s own contract, pinned in
  // `src-ui/src/lib/__tests__/clipboard.test.ts` -- 'resolves false when the
  // origin has no clipboard API at all'. What is this panel's to prove is that
  // it derives its affordance from that boolean rather than from the call.
  test('a refused write never claims a copy', async () => {
    clipboardRefuses();
    renderNoCliCta();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
