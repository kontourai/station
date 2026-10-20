/** Explicit SDK context cannot author consent; same-origin code can omit these headers. */
export function requestFromPluginPane(request: Request): boolean {
  return (
    request.headers.has('x-station-plugin-capability') ||
    request.headers.has('x-station-plugin')
  );
}
