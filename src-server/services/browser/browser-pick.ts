import { createHash, randomUUID } from 'node:crypto';
import type { CdpTransport } from './browser-host.js';
import type { BrowserLiveTarget } from './browser-session-registry.js';

const MAX_HTML = 4_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 5_000;
const active = new WeakMap<CdpTransport, Set<string>>();

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
    const world = await send<{ executionContextId?: number }>(
      'Page.createIsolatedWorld',
      { frameId: before.id, worldName: 'station-browser-pick' },
    );
    if (!world.executionContextId) throw new Error('Page context unavailable.');
    const resolved = await send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode',
      {
        backendNodeId: node.backendNodeId,
        executionContextId: world.executionContextId,
        objectGroup,
      },
    );
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
        const escape = (value) => value.replace(/[&"<>]/g, (c) => ({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'})[c]);
        const attrs = []; for (let i = 0; i < Math.min(this.attributes.length, 20); i++) { const attr = this.attributes[i]; const key = attr.name.slice(0, 100); const value = /value|token|secret|password|auth|key/i.test(key) ? '[redacted]' : attr.value.slice(0, 100); attrs.push(key + '="' + escape(value) + '"'); }
        const html = ('<' + this.localName + (attrs.length ? ' ' + attrs.join(' ') : '') + '>').slice(0, ${MAX_HTML});
        return { selector, tagName: this.localName, role: this.getAttribute('role') || '', name: (this.getAttribute('aria-label') || '').trim().slice(0, 500), html, styles, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
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
      html: string;
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
    return {
      ...picked,
      locator: `css=${picked.selector}`,
      url: before.url ?? '',
      capturedAt: new Date().toISOString(),
      ...(screenshot ? { screenshot, digest } : {}),
    };
  } finally {
    void cdp
      .send('Runtime.releaseObjectGroup', { objectGroup }, session)
      .catch(() => {});
  }
}
