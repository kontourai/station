/**
 * @vitest-environment jsdom
 *
 * archive#3341 Class B: the plan panel awaited `navigator.clipboard?.writeText`
 * inside a try/catch, which RESOLVES when there is no clipboard at all — so on
 * a non-secure origin (Station reached over plain http:// from another device)
 * the button reported "Copied" for a write that never happened. The catch only
 * ever covered the refusal case.
 *
 * The panel's own derivation tests live in WorkflowPlanPanel.test.ts; this file
 * is the rendered copy affordance.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type WorkflowPlanArtifact,
  WorkflowPlanPanel,
} from '../components/flow/WorkflowPlanPanel';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';
import {
  chooseOverflow,
  openOverflow,
  overflowItems,
} from './helpers/overflow-menu';

vi.mock('../components/chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children?: string }) => <div>{children}</div>,
}));

const ARTIFACT: WorkflowPlanArtifact = {
  title: 'Ship the clipboard seam',
  markdown: '# Ship the clipboard seam\n\n- [x] Write the seam',
  rawText: '',
  steps: [{ id: 's1', label: 'Write the seam', status: 'completed' }],
};

function renderPanel() {
  return render(<WorkflowPlanPanel artifact={ARTIFACT} />);
}

function copyButton() {
  return screen.getByRole('button', { name: /^(Copy|Copied|Can't copy)$/ });
}

beforeEach(() => {
  clipboardAbsent();
});

afterEach(() => {
  cleanup();
  clipboardAbsent();
});

describe('WorkflowPlanPanel copy (station#3341)', () => {
  test('reports the copy only once the write resolved', async () => {
    const writeText = clipboardWrites();
    renderPanel();

    fireEvent.click(copyButton());

    expect(writeText).toHaveBeenCalledWith(ARTIFACT.markdown);
    await waitFor(() => expect(copyButton().textContent).toBe('Copied'));
  });

  // ONE failure case here, not the primitive's matrix. Which clipboard states
  // resolve `false` (absent, no `writeText`, rejected, throwing) is
  // `copyToClipboard`'s own contract, pinned in
  // `src-ui/src/lib/__tests__/clipboard.test.ts` -- 'resolves false when the
  // origin has no clipboard API at all'. What is this panel's to prove is that
  // it derives its affordance from that boolean rather than from the call.
  test('a refused write never claims a copy', async () => {
    clipboardRefuses();
    renderPanel();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.queryByText('Copied')).toBeNull();
    expect(copyButton().getAttribute('title')).toContain(
      'refused clipboard access',
    );
  });

  // Review M3: Save and Export were folded out of the header (#3045); both
  // are still there and each still writes a file.
  test('the plan menu holds Save and Export, and each downloads', () => {
    // jsdom has no object URLs; these are the two calls a download makes.
    const createObjectURL = vi.fn(() => 'blob:plan');
    const { createObjectURL: realCreate, revokeObjectURL: realRevoke } = URL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    renderPanel();

    expect(overflowItems(openOverflow('More plan actions'))).toEqual([
      { name: 'Save', danger: false },
      { name: 'Export', danger: false },
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    chooseOverflow('More plan actions', 'Export');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  test('with no plan, both rows are refused and say why', () => {
    render(<WorkflowPlanPanel artifact={null} />);
    openOverflow('More plan actions');
    for (const name of ['Save', 'Export']) {
      const row = screen.getByRole('menuitem', { name });
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(
        document.getElementById(row.getAttribute('aria-describedby')!)
          ?.textContent,
      ).toBe('No plan yet');
    }
  });
});
