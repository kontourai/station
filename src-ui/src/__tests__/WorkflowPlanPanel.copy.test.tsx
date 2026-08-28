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

  test('a refused write never claims a copy', async () => {
    clipboardRefuses();
    renderPanel();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.queryByText('Copied')).toBeNull();
  });

  test('an insecure origin with no clipboard API never claims a copy', async () => {
    clipboardAbsent();
    renderPanel();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.queryByText('Copied')).toBeNull();
    expect(copyButton().getAttribute('title')).toContain(
      'refused clipboard access',
    );
  });
});
