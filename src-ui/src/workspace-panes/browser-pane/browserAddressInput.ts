/** Human omnibox convenience; automation and server URL policy stay explicit. */
export function browserAddressInput(input: string): string {
  const value = input.trim();
  if (!value || value.length > 8192) return value;
  // Schemes, paths and address-like inputs must reach the URL validator,
  // including refusals such as javascript:, credentials and malformed URLs.
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /^[./\\]/.test(value) ||
    (!/\s/.test(value) && /[.@:/[\]]/.test(value)) ||
    value === 'localhost'
  )
    return value;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}
