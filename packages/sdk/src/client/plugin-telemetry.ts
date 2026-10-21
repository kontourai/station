import { getClientRawEgressPolicy, mutateJson } from './http';

/** Counts go only to this Station's kernel. The plugin's declared endpoint is never an SDK destination. */
export function createPluginTelemetry(
  apiBase: string,
  capability: string | (() => string | undefined),
) {
  return {
    async count(
      event: string,
      props: Record<string, string | number> = {},
    ): Promise<void> {
      const token =
        typeof capability === 'function' ? capability() : capability;
      const policy = getClientRawEgressPolicy();
      if (
        !token ||
        !apiBase ||
        policy?.kind === 'broker' ||
        (policy && (policy.apiBase !== apiBase || !policy.isCurrent()))
      )
        throw new Error(
          'Plugin telemetry needs a current direct Station and explicit plugin identity',
        );
      const response = await mutateJson(
        `${apiBase}/api/telemetry/events`,
        'POST',
        {
          headers: { 'x-station-plugin-capability': token },
          ...(policy?.authorityKey
            ? { requestScope: { apiBase, authorityKey: policy.authorityKey } }
            : {}),
          timeoutMs: 5000,
          maxResponseBytes: 2048,
        },
        { events: [{ event, attributes: props }] },
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new Error('Plugin telemetry rejected by the kernel');
    },
  };
}

/** Host-only mount operation; never call this from plugin code. Pane-marked requests are refused. */
export async function mountPluginTelemetryPane(
  apiBase: string,
  plugin: string,
  signal?: AbortSignal,
): Promise<{ token: string; expiresAt: string }> {
  const response = await mutateJson(
    `${apiBase}/api/telemetry/panes`,
    'POST',
    { signal, timeoutMs: 5000, maxResponseBytes: 2048 },
    { plugin },
  );
  if (!response.ok) throw new Error('Publisher telemetry unavailable');
  const json = (await response.json()) as {
    data: { token: string; expiresAt: string };
  };
  return json.data;
}
