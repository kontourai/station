/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { StatusSummary } from '../components/StatusSummary';

afterEach(cleanup);

test.each([
  '0.2.0-nightly.20261019.0',
  '0.2.0-nightly.20261019',
  '0.2.0-nightly.2026101900',
  '0.2.0-nightly.248300',
])(
  'renders %s as a Nightly date/build and keeps the exact version in details',
  (current) => {
    render(
      <StatusSummary title="Desktop app" current={current} target="0.3.0" />,
    );
    const label = screen.getByText('Nightly · Oct 19 (build 248300)');
    expect(label.getAttribute('title')).toBe(current);
    expect(screen.getByText('0.3.0')).toBeTruthy();
  },
);

test.each([
  '0.2.0',
  'branch-main',
  '0.2.0-nightly.20260230',
  '0.11.0-nightly.20261019.43709226198',
])(
  'keeps %s intact when it has no valid product Nightly allocation',
  (current) => {
    render(<StatusSummary title="Server" current={current} />);
    expect(screen.getByText(current)).toBeTruthy();
  },
);
