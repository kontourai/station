/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { InputRequestUrlCard } from './InputRequestUrlCard';

const request = (
  url: string,
  purpose: 'mcp-sign-in' | 'engine-link' = 'mcp-sign-in',
) =>
  ({
    schema: 'station.input-request/v1',
    source: 'mcp:remote',
    requester: 'remote',
    message: 'Sign in to use this server.',
    body: { kind: 'url', url, purpose },
  }) as never;

describe('InputRequestUrlCard', () => {
  test('shows where the link goes and records opened only when the person opens it', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <InputRequestUrlCard
        request={request('https://auth.example.com/authorize?x=1')}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByText('auth.example.com')).toBeTruthy();
    expect(onRespond).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: 'Sign in' });
    expect(link.getAttribute('href')).toBe(
      'https://auth.example.com/authorize?x=1',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(link);
    expect(onRespond).toHaveBeenCalledWith('accept');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Opened remote’s link',
      ),
    );
  });

  test('Cancel answers cancel', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <InputRequestUrlCard
        request={request('https://example.com/x', 'engine-link')}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open link' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRespond).toHaveBeenCalledWith('cancel');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Cancelled remote’s request',
      ),
    );
  });

  test.each([
    'http://example.com/x',
    'https://user:pw@example.com/x',
    'javascript:alert(1)',
  ])('never renders an href for %s', (url) => {
    render(<InputRequestUrlCard request={request(url)} onRespond={vi.fn()} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
