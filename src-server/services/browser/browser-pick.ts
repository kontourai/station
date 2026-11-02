import { createHash, randomUUID } from 'node:crypto';
import type { CdpTransport } from './browser-host.js';
import { redactNetworkUrl } from './browser-network-log.js';
import type { BrowserLiveTarget } from './browser-session-registry.js';

const MAX_HTML = 4_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 5_000;
const active = new WeakMap<CdpTransport, Set<string>>();
const worlds = new WeakMap<
  CdpTransport,
  Map<string, { frameId: string; loaderId: string; contextId: number }>
>();

function htmlExcerpt(
  tagName: string,
  attributes: Array<{ name: string; value: string }>,
  pageUrl: string,
): string {
  const escapeAttribute = (value: string) =>
    value.replace(
      /[&"<>]/g,
      (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!,
    );
  const safeUrl = (value: string) => {
    try {
      return redactNetworkUrl(new URL(value, pageUrl).href);
    } catch {
      return '[invalid URL]';
    }
  };
  const attrs = attributes.slice(0, 20).map(({ name, value }) => {
    const key = name.slice(0, 100);
    let safe = value.slice(0, 100);
    if (
      /value|token|secret|password|auth|key/i.test(key) ||
      (key.toLowerCase().startsWith('data-') &&
        /token|secret|password|bearer|api[_-]?key|authorization|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{10,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i.test(
          value,
        ))
    )
      safe = '[redacted]';
    else if (/^(href|src|action|formaction|poster|xlink:href)$/i.test(key))
      safe = safeUrl(value);
    else if (/^ping$/i.test(key))
      safe = value.trim().split(/\s+/).map(safeUrl).join(' ');
    else if (/^srcset$/i.test(key))
      safe = /data:/i.test(value)
        ? '[redacted]'
        : value
            .split(',')
            .map((entry) => {
              const [url, ...descriptor] = entry.trim().split(/\s+/);
              return [
                safeUrl(url ?? ''),
                ...descriptor.filter((part) =>
                  /^(?:\d+(?:\.\d+)?x|\d+[wh])$/.test(part),
                ),
              ].join(' ');
            })
            .join(', ');
    else if (/^style$/i.test(key)) safe = '[redacted]';
    return `${key}="${escapeAttribute(safe)}"`;
  });
  return `<${tagName}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`.slice(
    0,
    MAX_HTML,
  );
}

/** Captures one viewport point in the target's isolated world. */
export async function pickBrowserElement(
  live: BrowserLiveTarget,
  viewport: { width: number; height: number },
  point: { x: number; y: number },
  includeScreenshot = true,
) {
  const cdp = live.host.cdp();
  let sessions = active.get(cdp);
  if (!sessions) {
    sessions = new Set();
    active.set(cdp, sessions);
  }
  const session = live.target.cdpSessionId;
  if (sessions.has(session)) throw new Error('Pick is busy.');
  sessions.add(session);
  try {
    return await pick(cdp, live, viewport, point, includeScreenshot);
  } finally {
    sessions.delete(session);
  }
}

async function pick(
  cdp: CdpTransport,
  live: BrowserLiveTarget,
  viewport: { width: number; height: number },
  point: { x: number; y: number },
  includeScreenshot: boolean,
) {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= viewport.width ||
    point.y >= viewport.height
  )
    throw new Error('Point is outside the viewport.');
  const session = live.target.cdpSessionId;
  const objectGroup = `station-browser-pick-${randomUUID()}`;
  const started = Date.now();
  const send = async <T>(method: string, params: object = {}): Promise<T> => {
    const remaining = DEADLINE_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error('Pick timed out.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const pending = cdp.send<T>(method, params, session);
    if (method === 'DOM.resolveNode')
      void pending.then(
        () => {
          if (timedOut)
            void cdp
              .send('Runtime.releaseObjectGroup', { objectGroup }, session)
              .catch(() => {});
        },
        () => {},
      );
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Pick timed out.'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const frame = async () => {
    const result = await send<{
      frameTree?: { frame?: { id?: string; loaderId?: string; url?: string } };
    }>('Page.getFrameTree');
    const value = result.frameTree?.frame;
    if (!value?.id || !value.loaderId)
      throw new Error('Page identity unavailable.');
    return value;
  };
  try {
    const before = await frame();
    const node = await send<{ backendNodeId?: number }>(
      'DOM.getNodeForLocation',
      {
        x: Math.floor(point.x),
        y: Math.floor(point.y),
        includeUserAgentShadowDOM: false,
      },
    );
    if (!node.backendNodeId) throw new Error('No element at point.');
    let bySession = worlds.get(cdp);
    if (!bySession) {
      bySession = new Map();
      worlds.set(cdp, bySession);
    }
    let cached = bySession.get(session);
    if (
      !cached ||
      cached.frameId !== before.id ||
      cached.loaderId !== before.loaderId
    ) {
      bySession.delete(session);
      const world = await send<{ executionContextId?: number }>(
        'Page.createIsolatedWorld',
        { frameId: before.id, worldName: 'station-browser-pick' },
      );
      if (!world.executionContextId)
        throw new Error('Page context unavailable.');
      cached = {
        frameId: before.id!,
        loaderId: before.loaderId!,
        contextId: world.executionContextId,
      };
      bySession.set(session, cached);
      if (bySession.size > 32) bySession.delete(bySession.keys().next().value!);
    }
    const resolve = (contextId: number) =>
      send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: node.backendNodeId,
        executionContextId: contextId,
        objectGroup,
      });
    let resolved: { object?: { objectId?: string } };
    try {
      resolved = await resolve(cached.contextId);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/context.*(destroyed|not found|cannot find)|(?:cannot|could not) find.*context/i.test(
          error.message,
        )
      )
        throw error;
      bySession.delete(session);
      const world = await send<{ executionContextId?: number }>(
        'Page.createIsolatedWorld',
        {
          frameId: before.id,
          worldName: 'station-browser-pick',
        },
      );
      if (!world.executionContextId)
        throw new Error('Page context unavailable.');
      cached = {
        frameId: before.id!,
        loaderId: before.loaderId!,
        contextId: world.executionContextId,
      };
      bySession.set(session, cached);
      resolved = await resolve(cached.contextId);
    }
    if (!resolved.object?.objectId) throw new Error('Element unavailable.');
    const result = await send<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        if (!(this instanceof Element)) return null;
        const rect = this.getBoundingClientRect();
        const parts = []; let element = this;
        while (element && parts.length < 20) {
          const tag = element.localName;
          if (!tag) break;
          const siblings = element.parentElement ? Array.from(element.parentElement.children).filter((s) => s.localName === tag) : [];
          parts.unshift(CSS.escape(tag) + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')' : ''));
          element = element.parentElement;
        }
        const selector = parts.join(' > ');
        if (!selector || selector.length > 2000 || document.querySelectorAll(selector).length !== 1) return null;
        const computed = getComputedStyle(this);
        const styles = {}; for (const name of ['display','position','color','background-color','font-size','font-family','font-weight','margin','padding','border','width','height']) styles[name] = computed.getPropertyValue(name).slice(0, 200);
        const attributes = []; for (let i = 0; i < Math.min(this.attributes.length, 20); i++) { const attr = this.attributes[i]; attributes.push({ name: attr.name.slice(0, 100), value: attr.value.slice(0, 2048) }); }
        return { selector, tagName: this.localName, role: this.getAttribute('role') || '', name: (this.getAttribute('aria-label') || '').trim().slice(0, 500), attributes, styles, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }`,
    });
    if (
      result.exceptionDetails ||
      !result.result?.value ||
      typeof result.result.value !== 'object'
    )
      throw new Error('Element could not be inspected.');
    const picked = result.result.value as {
      selector: string;
      tagName: string;
      role: string;
      name: string;
      attributes: Array<{ name: string; value: string }>;
      styles: Record<string, string>;
      rect: { x: number; y: number; width: number; height: number };
    };
    const accessibility = await send<{
      nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }>;
    }>('Accessibility.getPartialAXTree', {
      backendNodeId: node.backendNodeId,
      fetchRelatives: false,
    });
    const ax = accessibility.nodes?.[0];
    if (typeof ax?.role?.value === 'string')
      picked.role = ax.role.value.slice(0, 100);
    if (typeof ax?.name?.value === 'string')
      picked.name = ax.name.value.slice(0, 500);
    const rect = picked.rect;
    if (
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      point.x < rect.x ||
      point.y < rect.y ||
      point.x > rect.x + rect.width ||
      point.y > rect.y + rect.height
    )
      throw new Error('Element moved during selection.');
    const x = Math.max(0, rect.x),
      y = Math.max(0, rect.y);
    const width = Math.min(viewport.width, rect.x + rect.width) - x,
      height = Math.min(viewport.height, rect.y + rect.height) - y;
    if (width <= 0 || height <= 0)
      throw new Error('Element is outside the viewport.');
    let screenshot: string | undefined;
    let digest: string | undefined;
    if (includeScreenshot) {
      const metrics = await send<{
        cssVisualViewport?: { pageX?: number; pageY?: number };
      }>('Page.getLayoutMetrics');
      const pageX = metrics.cssVisualViewport?.pageX,
        pageY = metrics.cssVisualViewport?.pageY;
      if (
        typeof pageX !== 'number' ||
        typeof pageY !== 'number' ||
        !Number.isFinite(pageX) ||
        !Number.isFinite(pageY)
      )
        throw new Error('Viewport metrics unavailable.');
      const shot = await send<{ data?: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: pageX + x, y: pageY + y, width, height, scale: 1 },
      });
      if (
        typeof shot.data !== 'string' ||
        shot.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4
      )
        throw new Error('Element image unavailable.');
      const image =
        typeof shot.data === 'string'
          ? Buffer.from(shot.data, 'base64')
          : Buffer.alloc(0);
      if (
        image.length > MAX_IMAGE_BYTES ||
        !image
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('Element image unavailable.');
      screenshot = image.toString('base64');
      digest = createHash('sha256').update(image).digest('hex');
    }
    const after = await frame();
    if (
      before.id !== after.id ||
      before.loaderId !== after.loaderId ||
      before.url !== after.url
    )
      throw new Error('Page changed during selection.');
    const { attributes, ...safePicked } = picked;
    const html = htmlExcerpt(picked.tagName, attributes, before.url ?? '');
    return {
      ...safePicked,
      html,
      locator: `css=${picked.selector}`,
      url: before.url ?? '',
      capturedAt: new Date().toISOString(),
      ...(screenshot ? { screenshot, digest } : {}),
    };
  } catch (error) {
    worlds.get(cdp)?.delete(session);
    throw error;
  } finally {
    void cdp
      .send('Runtime.releaseObjectGroup', { objectGroup }, session)
      .catch(() => {});
  }
}
