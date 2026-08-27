type StarterNavigate = (
  pathname: string,
  params?: Record<string, string | null>,
) => void;

/**
 * Navigate one server-owned Starter href through the shell's path/params API.
 *
 * Starter owners return exact relative deep links. `navigationStore.navigate`
 * deliberately accepts the pathname separately from its query projection;
 * passing the whole href as pathname percent-encodes `?` and silently routes
 * to a not-found fallback.
 */
export function navigateStarterHref(
  navigate: StarterNavigate,
  href: string,
): void {
  const url = new URL(href, 'https://station.invalid');
  if (
    url.origin !== 'https://station.invalid' ||
    !href.startsWith('/') ||
    url.hash
  ) {
    throw new Error('Starter Work returned an invalid navigation target.');
  }
  navigate(url.pathname, Object.fromEntries(url.searchParams));
}
