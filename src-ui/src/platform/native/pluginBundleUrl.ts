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
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const url = new URL(
    `/api/plugins/${name}/${asset}`,
    convertFileSrc('', 'station-plugin'),
  );
  url.searchParams.set('port', origin.port);
  return url.href;
}
