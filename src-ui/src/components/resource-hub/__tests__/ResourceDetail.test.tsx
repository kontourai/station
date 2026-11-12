/**
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ResourceDetail } from '../ResourceDetail';

function detail(fixNotice?: string) {
  return (
    <ResourceDetail
      id="engine"
      title="Codex"
      status={{ label: 'Check failed', tone: 'negative' }}
      fixNotice={fixNotice}
      tabs={[{ key: 'overview', label: 'Overview' }]}
      activeTab="overview"
      onSelectTab={() => undefined}
      tabsLabel="Codex sections"
      renderPanel={() => null}
    />
  );
}

describe('ResourceDetail', () => {
  test('the notice region is mounted before a notice, so its arrival is announced', () => {
    const { container, rerender } = render(detail());
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');

    rerender(detail('The check passed.'));
    // The same element, now holding the notice: a region added together
    // with its text is not announced by most screen readers.
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toBe('The check passed.');
  });
});
