/** Origins presented by Station's packaged Tauri shells, never a web host. */
export const STATION_NATIVE_SHELL_ORIGINS = [
  'tauri://localhost',
  'https://tauri.localhost',
  // Android's Tauri WebView serves over plain HTTP.
  'http://tauri.localhost',
] as const;

export function isStationNativeShellOrigin(origin: string): boolean {
  return (STATION_NATIVE_SHELL_ORIGINS as readonly string[]).includes(origin);
}
