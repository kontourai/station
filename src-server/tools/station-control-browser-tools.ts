/**
 * Browser tools (#90 #122/#123): agents drive the SAME visible browser the
 * user sees in the Browser pane, through Station's built-in `station-browser`
 * MCP server (`station-browser-mcp-server.ts`, #90 D14).
 *
 * Authority never comes from arguments. Every tool first resolves the
 * VERIFIED calling session (`requireStationControlCaller`) and refuses unless
 * its credential is `bound`, its principal is a recorded session owner, and
 * its Project was recorded when it started. Station's REST side re-derives
 * the same caller from the forwarded credential and adds the D5 check (the
 * operator or an admin of that Project), so this module's checks only give an
 * early, typed answer; the route is the enforcement. A `browserSessionId`
 * argument only SELECTS among sessions the caller may drive.
 *
 * This module is loaded by the stdio station-control child too, so it may
 * import nothing from Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';

import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  jsonToolResult,
  requireStationControlCaller,
  type StationControlCaller,
  StationControlCallerRequiredError,
} from './station-control-shared.js';

/** Where Station serves the browser tools (personal hosts only). */
const BROWSER_AGENT_API_PATH = '/api/browser-agent';

export type BrowserAgentCallerRefusalCode =
  | 'caller-required'
  | 'caller-not-bound'
  | 'principal-unverified'
  | 'project-unverified';

export interface BrowserAgentCallerRefusal {
  readonly code: BrowserAgentCallerRefusalCode;
  readonly message: string;
}

const NEED = 'Browser tools need a verified agent session';

/**
 * Why a caller may not use the browser tools at all, or undefined when it
 * passes the caller-level checks (D5's Project-role check comes after, on
 * Station's side). The one definition shared by this module and the route.
 */
export function browserAgentCallerRefusal(
  caller: StationControlCaller | null,
): BrowserAgentCallerRefusal | undefined {
  if (!caller)
    return {
      code: 'caller-required',
      message: `${NEED}; this engine's station-control connection does not carry one, so Station cannot tell which session is asking.`,
    };
  if (caller.assurance !== 'bound')
    return {
      code: 'caller-not-bound',
      message: `${NEED}; this engine's credential is not bound (assurance: ${caller.assurance}), so another process could be using it. Only engines Station runs in-process can drive the browser.`,
    };
  if (!caller.principal?.elevationEligible)
    return {
      code: 'principal-unverified',
      message: `${NEED}; Station has no recorded owner for this session, so it cannot tell whose browser this agent would use.`,
    };
  if (!caller.localProjectId || caller.projectIdSource !== 'session-record')
    return {
      code: 'project-unverified',
      message: `${NEED}; this session's Project was not recorded when it started, so Station will not grant it a Project's browser. Start a new session in the Project.`,
    };
  return undefined;
}

// Presets mirror the Browser pane's device menu.
const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  phone: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
  'phone-android': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  },
} as const;

const sessionId = z
  .string()
  .min(1)
  .max(80)
  .describe('A browserSessionId from browser_status or browser_open.');
const targetShape = {
  ref: z
    .string()
    .optional()
    .describe('Element ref from the latest browser_snapshot, e.g. "e12".'),
  locator: z
    .string()
    .optional()
    .describe(
      'Playwright-style locator, e.g. `role=button[name="Save"]`, `text=Sign in`, `css=#email`.',
    ),
  x: z
    .number()
    .optional()
    .describe('Viewport x in CSS pixels (use with y instead of ref/locator).'),
  y: z.number().optional().describe('Viewport y in CSS pixels.'),
};

type TargetArgs = {
  ref?: string;
  locator?: string;
  x?: number;
  y?: number;
};

function targetOf(args: TargetArgs): Record<string, unknown> | undefined {
  if (args.ref !== undefined) return { ref: args.ref };
  if (args.locator !== undefined) return { locator: args.locator };
  if (args.x !== undefined || args.y !== undefined)
    return { x: args.x, y: args.y };
  return undefined;
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Resolve the caller, refuse early when it cannot pass, then call Station.
 * Every refusal is a normal, typed result the model can read and act on.
 */
async function callBrowser(
  operation: string,
  body: Record<string, unknown>,
): Promise<{ content: ToolContent[] }> {
  let caller: StationControlCaller | null;
  try {
    caller = await requireStationControlCaller();
  } catch (error) {
    if (!(error instanceof StationControlCallerRequiredError)) throw error;
    caller = null;
  }
  const refusal = browserAgentCallerRefusal(caller);
  if (refusal) return jsonToolResult({ ok: false, ...refusal });
  let response: unknown;
  try {
    response = await api(`${BROWSER_AGENT_API_PATH}/${operation}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    return jsonToolResult({
      ok: false,
      code: 'unavailable',
      message:
        'The browser tools did not answer. They run only on a personal Station host; if this is one, Station could not be reached.',
    });
  }
  const result = (response ?? {}) as Record<string, unknown>;
  // A route that is not mounted (a hosted deployment) answers without our
  // envelope.
  if (typeof result.ok !== 'boolean')
    return jsonToolResult({
      ok: false,
      code: 'unavailable',
      message:
        'The browser is not available on this Station (browser tools run only on a personal Station host).',
    });
  const screenshot = result.screenshot as
    | { data?: unknown; mimeType?: unknown }
    | undefined;
  if (
    screenshot &&
    typeof screenshot.data === 'string' &&
    typeof screenshot.mimeType === 'string'
  ) {
    const { screenshot: _image, ...rest } = result;
    const { data: _data, ...meta } = screenshot;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ...rest, screenshot: meta }, null, 2),
        },
        {
          type: 'image',
          data: screenshot.data,
          mimeType: screenshot.mimeType,
        },
      ],
    };
  }
  return jsonToolResult(result);
}

export function registerBrowserTools(registry: StationControlToolRegistry) {
  registry.tool(
    'browser_status',
    'List the Browser pane sessions you may drive in this Project (url, viewport, who controls it, live viewers), and whether page JavaScript evaluation is allowed.',
    {},
    async () => callBrowser('status', {}),
  );

  registry.tool(
    'browser_open',
    "Open a browser page in this Project's Browser pane (the same browser the user can watch), or reuse/reopen one of your sessions. Returns its browserSessionId.",
    {
      url: z
        .string()
        .max(4096)
        .optional()
        .describe('http(s) URL to open. Default about:blank.'),
      browserSessionId: sessionId
        .optional()
        .describe('Reuse or reopen this session instead of opening one.'),
      viewport: z
        .enum(Object.keys(VIEWPORT_PRESETS) as [keyof typeof VIEWPORT_PRESETS])
        .optional()
        .describe('Viewport preset for a new session. Default desktop.'),
      visible: z
        .boolean()
        .optional()
        .describe(
          'Whether you intend the user to watch (default true). Every session is listed in the Browser pane, watchable live, either way.',
        ),
    },
    async (args) =>
      callBrowser('open', {
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.browserSessionId !== undefined
          ? { browserSessionId: args.browserSessionId }
          : {}),
        ...(args.viewport ? { viewport: VIEWPORT_PRESETS[args.viewport] } : {}),
        visible: args.visible ?? true,
      }),
  );

  registry.tool(
    'browser_navigate',
    'Load a URL in a browser session, or go back, forward or reload.',
    {
      browserSessionId: sessionId,
      url: z.string().max(4096).optional().describe('http(s) URL to load.'),
      action: z
        .enum(['back', 'forward', 'reload'])
        .optional()
        .describe('Instead of url: move through history or reload.'),
    },
    async (args) =>
      callBrowser('navigate', {
        browserSessionId: args.browserSessionId,
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.action !== undefined ? { action: args.action } : {}),
      }),
  );

  registry.tool(
    'browser_resize',
    'Change a browser session viewport to a device preset.',
    {
      browserSessionId: sessionId,
      preset: z.enum(
        Object.keys(VIEWPORT_PRESETS) as [keyof typeof VIEWPORT_PRESETS],
      ),
    },
    async (args) =>
      callBrowser('resize', {
        browserSessionId: args.browserSessionId,
        viewport: VIEWPORT_PRESETS[args.preset],
      }),
  );

  registry.tool(
    'browser_snapshot',
    'Read the page as an accessibility outline with element refs (e.g. [ref=e12]) for click/type/scroll. Bounded (very large pages may time out instead); optional viewport screenshot.',
    {
      browserSessionId: sessionId,
      screenshot: z
        .boolean()
        .optional()
        .describe('Also return a JPEG of the visible viewport.'),
    },
    async (args) =>
      callBrowser('snapshot', {
        browserSessionId: args.browserSessionId,
        screenshot: args.screenshot === true,
      }),
  );

  registry.tool(
    'browser_click',
    'Click an element (ref or locator) or a point (x, y CSS px). Refused if something covers the element; a page that moves things on a timer can still redirect a click. Stops if the user takes control.',
    {
      browserSessionId: sessionId,
      ...targetShape,
      button: z.enum(['left', 'middle', 'right']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
    },
    async (args) =>
      callBrowser('click', {
        browserSessionId: args.browserSessionId,
        target: targetOf(args),
        ...(args.button ? { button: args.button } : {}),
        ...(args.clickCount ? { clickCount: args.clickCount } : {}),
      }),
  );

  registry.tool(
    'browser_type',
    'Type text into a text field (ref or locator; default: the focused field), refused if the page moves focus away first. Optionally clear it first and press Enter after.',
    {
      browserSessionId: sessionId,
      text: z.string().max(8192),
      ref: targetShape.ref,
      locator: targetShape.locator,
      clear: z.boolean().optional().describe('Replace the current contents.'),
      submit: z.boolean().optional().describe('Press Enter afterwards.'),
    },
    async (args) =>
      callBrowser('type', {
        browserSessionId: args.browserSessionId,
        text: args.text,
        ...(targetOf(args) ? { target: targetOf(args) } : {}),
        ...(args.clear !== undefined ? { clear: args.clear } : {}),
        ...(args.submit !== undefined ? { submit: args.submit } : {}),
      }),
  );

  registry.tool(
    'browser_press',
    'Press a key or chord in the page: Enter, Tab, Escape, ArrowDown, Backspace, a character, or e.g. Shift+Tab.',
    {
      browserSessionId: sessionId,
      key: z.string().min(1).max(64),
    },
    async (args) =>
      callBrowser('press', {
        browserSessionId: args.browserSessionId,
        key: args.key,
      }),
  );

  registry.tool(
    'browser_scroll',
    'Scroll the page by deltaX/deltaY CSS px (at an element, a point, or the viewport centre), or scroll an element into view.',
    {
      browserSessionId: sessionId,
      ...targetShape,
      deltaX: z.number().min(-10_000).max(10_000).optional(),
      deltaY: z.number().min(-10_000).max(10_000).optional(),
    },
    async (args) =>
      callBrowser('scroll', {
        browserSessionId: args.browserSessionId,
        ...(targetOf(args) ? { target: targetOf(args) } : {}),
        ...(args.deltaX !== undefined ? { deltaX: args.deltaX } : {}),
        ...(args.deltaY !== undefined ? { deltaY: args.deltaY } : {}),
      }),
  );

  registry.tool(
    'browser_wait_for',
    'Wait until text appears on the page, a locator matches a visible element, or the URL contains a string. Bounded timeout (default 5 s, max 30 s).',
    {
      browserSessionId: sessionId,
      text: z.string().max(2000).optional(),
      locator: z.string().max(2000).optional(),
      url: z.string().max(2000).optional(),
      timeoutMs: z.number().int().min(0).max(30_000).optional(),
    },
    async (args) =>
      callBrowser('wait-for', {
        browserSessionId: args.browserSessionId,
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.locator !== undefined ? { locator: args.locator } : {}),
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      }),
  );

  registry.tool(
    'browser_evaluate',
    "Run a JavaScript expression as the page itself (it can read the page's data, cookies and storage, and may keep running after this returns); returns its JSON result, max 64 KB. Off unless the Project allows it.",
    {
      browserSessionId: sessionId,
      expression: z.string().min(1).max(16_384),
      timeoutMs: z.number().int().min(100).max(30_000).optional(),
    },
    async (args) =>
      callBrowser('evaluate', {
        browserSessionId: args.browserSessionId,
        expression: args.expression,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      }),
  );
}
