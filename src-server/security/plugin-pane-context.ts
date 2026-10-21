/** Explicit SDK or iframe context cannot author consent; header absence grants no authority. */
export function requestFromPluginPane(request: Request): boolean {
  return (
    request.headers.has('x-station-plugin-capability') ||
    request.headers.has('x-station-plugin') ||
    request.headers.get('sec-fetch-dest') === 'iframe'
  );
}
