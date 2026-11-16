/**
 * Shell-staged delivery for visual replies that cannot reach the loopback
 * frame listener. The shell stages the composed page document and serves it
 * on its own scheme, so the sandboxed frame is a real document: it does not
 * inherit the app CSP, and the page's inline scripts run. Without the
 * capability (a desktop browser, or an older shell) the viewer keeps its
 * srcdoc fallback.
 */
export async function stageHtmlReplyDocument(
  document: string,
): Promise<string | undefined> {
  const capability: unknown = (
    window as Window & {
      __STATION_HTML_REPLY_CAPABILITY__?: unknown;
    }
  ).__STATION_HTML_REPLY_CAPABILITY__;
  if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability))
    return undefined;
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
  const handle: unknown = await invoke('station_html_reply_stage', {
    document,
  });
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(handle))
    return undefined;
  const url = new URL(`/${handle}`, convertFileSrc('', 'station-html-reply'));
  url.searchParams.set('capability', capability);
  return url.href;
}
