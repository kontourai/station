/**
 * @vitest-environment jsdom
 *
 * The frame a Customize item hosts today's connection screens in: its
 * header, its one add action, and no section rail (the Customize list is
 * the way between items). And the Computers page, which left the rail and
 * kept its own add action.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const navigate = vi.fn();
const header = vi.hoisted(() => ({
  last: undefined as
    | { eyebrow?: unknown; title?: string; subtitle?: string }
    | undefined,
}));
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => viewport.mobile,
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../components/page-frame', () => ({
  PageEyebrowTrail: ({
    segments,
  }: {
    segments: Array<{ label: string; onClick?: () => void }>;
  }) => (
    <>
      {segments.map((segment) =>
        segment.onClick ? (
          <button key={segment.label} type="button" onClick={segment.onClick}>
            {segment.label}
          </button>
        ) : (
          <span key={segment.label}>{segment.label}</span>
        ),
      )}
    </>
  ),
  PageFrameActions: ({ children }: { children: ReactNode }) => (
    <div data-testid="frame-actions">{children}</div>
  ),
  PageHeaderScope: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  usePageHeader: (value: typeof header.last) => {
    header.last = value;
  },
}));
vi.mock('../views/connections-hub/AddMachineModal', () => ({
  AddMachineModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="chooser" /> : null,
}));
vi.mock('../views/connections-hub/IntegrationStatusSection', () => ({
  IntegrationStatusSection: () => <div data-testid="integration-status-slot" />,
}));
vi.mock('../views/connections-hub/ComputersSection', () => ({
  ComputersSection: () => <div data-testid="computers-body" />,
}));

import { CustomizeSectionFrame } from '../views/CustomizeSectionFrame';
import { ComputersPage } from '../views/connections-hub/ComputersPage';

/** Renders the eyebrow the frame published, so its links can be pressed. */
function renderEyebrow() {
  render(<div>{header.last?.eyebrow as ReactNode}</div>);
}

describe('CustomizeSectionFrame', () => {
  beforeEach(() => {
    navigate.mockReset();
    viewport.mobile = false;
    header.last = undefined;
  });

  test('titles the page for its item, under a Customize eyebrow that goes back to the list', () => {
    const { unmount } = render(
      <CustomizeSectionFrame sectionId="providers">
        <div data-testid="body" />
      </CustomizeSectionFrame>,
    );
    expect(header.last?.title).toBe('Providers');
    expect(screen.getByTestId('body')).toBeTruthy();
    expect(screen.getByTestId('integration-status-slot')).toBeTruthy();
    // The Customize list replaces the old section rail.
    expect(screen.queryByRole('tablist')).toBeNull();
    unmount();
    renderEyebrow();
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(navigate).toHaveBeenCalledWith('/customize');
  });

  test('while adding an engine, the eyebrow names both levels above', () => {
    render(
      <CustomizeSectionFrame sectionId="engines" creating>
        <div />
      </CustomizeSectionFrame>,
    );
    expect(header.last?.title).toBe('Add engine');
    renderEyebrow();
    fireEvent.click(screen.getByRole('button', { name: 'Engines' }));
    expect(navigate).toHaveBeenCalledWith('/customize/engines');
  });

  test('each item routes its one add action to its own creator', () => {
    for (const [sectionId, path] of [
      ['providers', '/customize/providers/new'],
      ['engines', '/customize/engines/new'],
      ['tools', '/customize/tools/new'],
      ['knowledge', '/settings?view=knowledge'],
    ] as const) {
      navigate.mockReset();
      const { unmount } = render(
        <CustomizeSectionFrame sectionId={sectionId}>
          <div />
        </CustomizeSectionFrame>,
      );
      const actions = screen.getByTestId('frame-actions');
      expect(actions.querySelectorAll('button')).toHaveLength(1);
      fireEvent.click(actions.querySelector('button')!);
      expect(navigate).toHaveBeenCalledWith(path);
      unmount();
    }
  });
});

describe('ComputersPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    viewport.mobile = false;
  });

  test('keeps one add action, which opens the chooser rather than navigating', () => {
    render(<ComputersPage />);
    expect(screen.getByTestId('computers-body')).toBeTruthy();
    const actions = screen.getByTestId('frame-actions');
    expect(actions.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add computer' }));
    expect(screen.getByTestId('chooser')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('on a phone the add action floats instead of taking a header row, and still opens the chooser', () => {
    viewport.mobile = true;
    render(<ComputersPage />);
    expect(screen.queryByTestId('frame-actions')).toBeNull();
    const add = screen.getByRole('button', { name: 'Add computer' });
    expect(add.classList.contains('create-plus-button')).toBe(true);
    fireEvent.click(add);
    expect(screen.getByTestId('chooser')).toBeTruthy();
  });
});
