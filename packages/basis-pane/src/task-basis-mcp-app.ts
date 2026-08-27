import taskBasisMcpApp from './task-basis-mcp-app.generated';

export const STATION_TASK_BASIS_MCP_SERVER_ID = 'station-control';
export const STATION_TASK_BASIS_MCP_TOOL_NAME = 'get_task_basis';
export const STATION_TASK_BASIS_MCP_TOOL_REF = `${STATION_TASK_BASIS_MCP_SERVER_ID}/${STATION_TASK_BASIS_MCP_TOOL_NAME}`;
// Version the immutable resource with its page contract so a host cannot
// reuse v2 HTML against a v3 structured-content envelope.
export const STATION_TASK_BASIS_MCP_RESOURCE_URI = 'ui://station/basis/task/v3';

const MAX_RESOURCE_BYTES = 500 * 1024;

export function buildStationTaskBasisMcpAppResource() {
  const text = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>Task Basis</title><style>:root{color-scheme:light;--tb-bg:#fffcf1;--tb-surface:#fff;--tb-text:#17201b;--tb-line:#657267;--tb-ring:#0f8f66}:root[data-theme=dark]{color-scheme:dark;--tb-bg:#0b1115;--tb-surface:#101820;--tb-text:#eff5f0;--tb-line:#657267;--tb-ring:#38c98b}*{box-sizing:border-box}body{margin:0;padding:1rem;background:var(--color-background-primary,var(--tb-bg));color:var(--color-text-primary,var(--tb-text));font-family:var(--font-sans,system-ui,sans-serif)}button,summary{min-height:44px}.task-basis__chrome{margin:0 0 1rem}.task-basis__answers{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0}.task-basis__answers button{border:1px solid var(--color-border-primary,var(--tb-line));background:var(--color-background-secondary,var(--tb-surface));color:inherit;padding:.4rem .6rem}.task-basis__answers button[aria-pressed=true]{outline:2px solid var(--color-ring-primary,var(--tb-ring))}.task-basis__more{margin-top:.75rem}.task-basis__process,.task-basis__gate-evaluation{min-width:0;overflow-wrap:anywhere}.task-basis__gate-evaluation{border:1px solid var(--color-border-primary,var(--tb-line));border-radius:var(--border-radius-md,.625rem);margin:.5rem 0;padding:.75rem}.task-basis__summary{cursor:pointer;font-weight:700}.task-basis__facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.375rem .75rem}.task-basis__facts dd{margin:0;overflow-wrap:anywhere}.task-basis__gate-evaluation bdi,.task-basis__facts bdi{unicode-bidi:isolate}@media(max-width:420px){body{padding:.75rem}.task-basis__facts{grid-template-columns:1fr;gap:.125rem}}</style></head><body><main id="task-basis-app" aria-label="Whole Task Basis"></main><script type="module">${safeInlineScript(taskBasisMcpApp)}</script></body></html>`;
  if (new TextEncoder().encode(text).byteLength > MAX_RESOURCE_BYTES)
    throw new Error('Station Task Basis MCP App resource exceeds 500 KiB');
  return {
    uri: STATION_TASK_BASIS_MCP_RESOURCE_URI,
    mimeType: 'text/html;profile=mcp-app' as const,
    text,
    _meta: {
      ui: { csp: { connectDomains: [], resourceDomains: [] } },
    },
  };
}

function safeInlineScript(value: string): string {
  return value.split('</').join('<\\/').split('<!--').join('<\\!--');
}
