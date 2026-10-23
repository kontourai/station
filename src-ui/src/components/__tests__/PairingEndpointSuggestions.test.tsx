// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PairingEndpointSuggestions } from '../PairingEndpointSuggestions';

afterEach(cleanup);
function setup(value: unknown) {
  const request = vi.fn(
    async () => new Response(JSON.stringify(value), { status: 200 }),
  );
  const onSuggest = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <PairingEndpointSuggestions
        apiBase="https://host.example"
        request={request}
        onSuggest={onSuggest}
      />
    </QueryClientProvider>,
  );
  return { request, onSuggest };
}
test('shows the exact authenticated suggestion and applies it only on explicit selection', async () => {
  const { request, onSuggest } = setup({
    source: 'tailscale-serve',
    endpoints: ['https://computer.tail.example'],
  });
  await screen.findByText('https://computer.tail.example');
  expect(request).toHaveBeenCalledWith(
    '/api/pairing/endpoint-suggestions',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  );
  expect(onSuggest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use this address' }));
  expect(onSuggest).toHaveBeenCalledWith('https://computer.tail.example');
});
test.each([
  { source: 'untrusted', endpoints: ['https://computer.tail.example'] },
  { source: 'tailscale-serve', endpoints: ['http://192.168.1.2'] },
  {
    source: 'tailscale-serve',
    endpoints: ['https://user:secret@computer.tail.example'],
  },
  {
    source: 'tailscale-serve',
    endpoints: ['https://computer.tail.example/other'],
  },
])('never offers malformed endpoint inventory %#', async (value) => {
  const { request, onSuggest } = setup(value);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  expect(onSuggest).not.toHaveBeenCalled();
});
