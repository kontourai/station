// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { composerDisplayValue } from '../composer-mentions';
import { SessionReferencePicker } from '../SessionReferencePicker';

const fetchInventory = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  fetchConversationInventory: fetchInventory,
}));

const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'owner',
  isCurrent: () => true,
};
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe('SessionReferencePicker', () => {
  beforeEach(() => fetchInventory.mockReset());
  test('stages an authorized cross-project link token without transcript data', async () => {
    fetchInventory.mockResolvedValue({
      items: [
        {
          id: 'earlier',
          title: 'Earlier work',
          projectSlug: 'other-project',
          referenceEligibility: {
            eligible: true,
            visibility: 'personal-private',
          },
        },
      ],
      hasMore: false,
    });
    const onChange = vi.fn();
    render(
      <SessionReferencePicker
        value="compare "
        activeConversationId="current"
        authority="authority-1"
        requestScope={scope}
        onChange={onChange}
        onClose={vi.fn()}
        onCandidateDragged={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(
      await screen.findByRole('option', { name: /Earlier work/ }),
    );
    const persisted = onChange.mock.calls[0]?.[0] as string;
    expect(composerDisplayValue(persisted)).toBe('compare @Earlier work ');
    expect(persisted).toContain('other-project');
    expect(persisted).not.toContain('transcript');
  });

  test('shows a genuine empty inventory after loading', async () => {
    fetchInventory.mockResolvedValue({ items: [], hasMore: false });
    render(
      <SessionReferencePicker
        value=""
        authority="authority-1"
        requestScope={scope}
        onChange={vi.fn()}
        onClose={vi.fn()}
        onCandidateDragged={vi.fn()}
      />,
      { wrapper },
    );
    expect(await screen.findByText('No matching conversations')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the disabled affordance and handler share the revoked-scope refusal', async () => {
    fetchInventory.mockResolvedValue({
      items: [
        {
          id: 'earlier',
          title: 'Earlier work',
          referenceEligibility: {
            eligible: true,
            visibility: 'personal-private',
          },
        },
      ],
      hasMore: false,
    });
    const onChange = vi.fn();
    const revoked = { ...scope, isCurrent: () => false };
    render(
      <SessionReferencePicker
        value=""
        authority="authority-1"
        requestScope={revoked}
        onChange={onChange}
        onClose={vi.fn()}
        onCandidateDragged={vi.fn()}
      />,
      { wrapper },
    );
    expect(
      (screen.getByLabelText('Find conversations') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(fetchInventory).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
