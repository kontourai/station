/** Only the desktop host can authenticate this deliberately narrow asset protocol. */
export async function desktopPluginBundleUrl(
  apiBase: string,
  name: string,
  asset: 'bundle.js' | 'bundle.css',
): Promise<string | undefined> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(apiBase)) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) return undefined;
  const origin = new URL(apiBase);
  if (!origin.port || Number(origin.port) > 65535) return undefined;
  const capability: unknown = (
    window as Window & {
      __STATION_PLUGIN_CAPABILITY__?: unknown;
    }
  ).__STATION_PLUGIN_CAPABILITY__;
  if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability))
    return undefined;
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const url = new URL(
    `/api/plugins/${name}/${asset}`,
    convertFileSrc('', 'station-plugin'),
  );
  url.searchParams.set('port', origin.port);
  url.searchParams.set('capability', capability);
  return url.href;
}
