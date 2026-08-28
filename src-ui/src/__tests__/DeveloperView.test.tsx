/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));

import { PageFrame } from '../components/page-frame';
import { DeveloperView } from '../views/DeveloperView';

const TAB_LABELS_TO_PATH: ReadonlyArray<[string, string]> = [
  ['Logs', '/developer/logs'],
  ['System', '/developer/system'],
  ['Telemetry', '/developer/telemetry'],
  ['Memory', '/developer/memory'],
  ['Archive', '/developer/archive'],
];

describe('DeveloperView', () => {
  test('renders five accessible read-only route-backed tabs', () => {
    render(<DeveloperView apiBase="http://test" />);
    expect(screen.getByLabelText('Developer')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(TAB_LABELS_TO_PATH.length);
    for (const tab of tabs) expect(tab.getAttribute('type')).toBe('button');
  });

  test('every tab click round-trips to its /developer/<tab> route', () => {
    render(<DeveloperView apiBase="http://test" />);
    for (const [label, path] of TAB_LABELS_TO_PATH) {
      navigate.mockClear();
      fireEvent.click(screen.getByRole('tab', { name: label }));
      expect(navigate).toHaveBeenCalledWith(path);
    }
  });

// archive#4463: 'Developer' is a real parent (the title
// is the active tab's name, never 'Developer' itself — decision #5), so
// its eyebrow stays linked, unlike the unlinked Connections eyebrow.
  test('publishes a linked "Developer" eyebrow back to /developer', () => {
    const { container } = render(
      <PageFrame
        spec={{ title: 'FALLBACK — must be overridden' }}
        routeIdentity="developer"
      >
        <DeveloperView apiBase="http://test" />
      </PageFrame>,
    );

    const eyebrowLink = container.querySelector('.page__label-link');
    expect(eyebrowLink?.textContent).toBe('Developer');
    navigate.mockClear();
    fireEvent.click(eyebrowLink as Element);
    expect(navigate).toHaveBeenCalledWith('/developer');
  });
});
