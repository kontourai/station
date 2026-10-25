// biome-ignore lint/correctness/noUnusedVariables: Rust includes this script and invokes its entry point before document parsing.
function installPluginBundleCapability(capability, shellOrigins) {
  // WebView2 injects even main-frame initialization scripts into child frames.
  if (window !== window.top) return;
  if (
    !shellOrigins.includes(
      `${window.location.protocol}//${window.location.host}`,
    )
  )
    return;
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  if (
    label !== 'main' &&
    !/^workspace-pane-pop-out-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      label ?? '',
    )
  )
    return;
  Object.defineProperty(window, '__STATION_PLUGIN_CAPABILITY__', {
    value: capability,
  });
}
