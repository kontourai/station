import { useQuery } from '@tanstack/react-query';
import { Button } from './Button';

/** Host-only suggestions are hints; selecting one never grants device access. */
export function PairingEndpointSuggestions({
  apiBase,
  request,
  onSuggest,
}: {
  apiBase: string;
  request: typeof fetch;
  onSuggest: (endpoint: string) => void;
}) {
  const query = useQuery({
    queryKey: ['pairing-endpoint-suggestions', apiBase],
    queryFn: async ({ signal }) => {
      const response = await request('/api/pairing/endpoint-suggestions', {
        signal,
        method: 'GET',
      });
      if (!response.ok) throw new Error('suggestions_unavailable');
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== 'object' ||
        !('source' in value) ||
        value.source !== 'tailscale-serve' ||
        !('endpoints' in value) ||
        !Array.isArray(value.endpoints) ||
        value.endpoints.length > 8
      )
        throw new Error('suggestions_invalid');
      return value.endpoints.map((endpoint: unknown) => {
        if (typeof endpoint !== 'string')
          throw new Error('suggestions_invalid');
        const url = new URL(endpoint);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.href !== `${url.origin}/`
        )
          throw new Error('suggestions_invalid');
        return url.origin;
      });
    },
    retry: false,
    staleTime: 30_000,
  });
  if (query.isPending || query.isError || !query.data?.length) return null;
  return (
    <div>
      <p>
        HTTPS addresses reported by this computer’s Tailscale Serve
        configuration. Your phone must be able to reach the address.
      </p>
      {query.data.map((endpoint) => (
        <p key={endpoint}>
          <code>{endpoint}</code>{' '}
          <Button size="sm" onClick={() => onSuggest(endpoint)}>
            Use this address
          </Button>
        </p>
      ))}
    </div>
  );
}
