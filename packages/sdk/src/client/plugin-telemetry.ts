import { getClientRawEgressPolicy, mutateJson } from './http';
import { getPluginHeaders } from './plugin-headers';

/** Counts go only to this Station's kernel. The plugin's declared endpoint is never an SDK destination. */
export function createPluginTelemetry(apiBase: string, pluginName: string) {
  return {
    async count(
      event: string,
      props: Record<string, string | number> = {},
    ): Promise<void> {
      const policy = getClientRawEgressPolicy();
      if (
        !pluginName ||
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
          headers: getPluginHeaders(undefined, pluginName),
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
