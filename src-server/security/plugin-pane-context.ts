/** Declared Pane context cannot author user consent. Same-origin frames remain a platform trust boundary. */
export function requestFromPluginPane(request: Request): boolean {
  return (
    request.headers.has('x-station-plugin-capability') ||
    request.headers.has('x-station-plugin') ||
    request.headers.get('sec-fetch-dest') === 'iframe'
  );
}
