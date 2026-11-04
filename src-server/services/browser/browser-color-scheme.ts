export type BrowserColorScheme = 'system' | 'light' | 'dark';

export function browserColorSchemeParams(scheme: BrowserColorScheme) {
  return {
    features: [
      {
        name: 'prefers-color-scheme',
        value: scheme === 'system' ? '' : scheme,
      },
    ],
  };
}
