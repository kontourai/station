/**
 * @vitest-environment jsdom
 *
 * station#2931 — heading ownership, expressed by the components rather than
 * remembered by each view (docs/design/shell-skeletons.md §2.1). These assert
 * the LEVEL a title renders at, which is the whole mechanism: `.detail-header__title`
 * sets its own font-size, so the element name is the only thing that changes and
 * the accessibility tree is the only place the rule is observable.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

import { DetailHeader } from '../components/DetailHeader';
import { SplitPaneLayout } from '../components/SplitPaneLayout';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

function renderInSplitPaneDetail(detail: React.ReactNode) {
  return render(
    <SplitPaneLayout
      label="Providers"
      title="Providers"
      items={[{ id: 'a', name: 'Alpha' }]}
      selectedId="a"
      onSelect={vi.fn()}
      onSearch={vi.fn()}
    >
      {detail}
    </SplitPaneLayout>,
  );
}

describe('DetailHeader heading level', () => {
  test('is a page-level heading on its own (the page-layout skeleton)', () => {
    render(<DetailHeader title="Knowledge infrastructure" />);

    expect(
      screen.getByRole('heading', {
        name: 'Knowledge infrastructure',
        level: 2,
      }),
    ).toBeTruthy();
  });

  test('drops to item level inside a SplitPaneLayout detail slot', () => {
    renderInSplitPaneDetail(<DetailHeader title="Add provider" />);

    // The shell's collection title stays at page level...
    expect(
      screen.getByRole('heading', { name: 'Providers', level: 2 }),
    ).toBeTruthy();
    // ...and the item title sits one level under it, not beside it.
    expect(
      screen.getByRole('heading', { name: 'Add provider', level: 3 }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Add provider', level: 2 }),
    ).toBeNull();
  });

  test('leaves exactly one page-level heading on a split-pane screen', () => {
    renderInSplitPaneDetail(<DetailHeader title="Add provider" />);

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  });

  test('a view cannot opt out — the level follows the slot, not a prop', () => {
    // The same element, rendered in both positions, reports different levels.
    const header = <DetailHeader title="Same header" />;

    const standalone = render(header);
    expect(
      standalone.getByRole('heading', { name: 'Same header', level: 2 }),
    ).toBeTruthy();
    standalone.unmount();

    renderInSplitPaneDetail(header);
    expect(
      screen.getByRole('heading', { name: 'Same header', level: 3 }),
    ).toBeTruthy();
  });
});

describe('SplitPaneLayout collection heading', () => {
  test('renders no breadcrumb when its only segment restates the title', () => {
    const { container } = render(
      <SplitPaneLayout
        label="Sessions"
        title="Sessions"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
      >
        <div />
      </SplitPaneLayout>,
    );

    expect(container.querySelector('.split-pane__label')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Sessions', level: 2 }),
    ).toBeTruthy();
  });

  test('still renders a real multi-segment breadcrumb', () => {
    const { container } = render(
      <SplitPaneLayout
        label="Connections / Providers"
        title="Providers"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
      >
        <div />
      </SplitPaneLayout>,
    );

    const label = container.querySelector('.split-pane__label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain('Connections');
  });
});
