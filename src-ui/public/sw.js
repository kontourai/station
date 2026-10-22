/**
 * Station Service Worker — handles Web Push notifications.
 *
 * Supports two payload shapes:
 *
 * Tool-approval (legacy):
 * { title, body, approvalId, sessionId, agentSlug, apiBase }
 *
 * Generic notification:
 * { title, body, category, notificationId, actions?, apiBase }
 */

// Replaced by the web build; development and native shells never cache.
const OFFLINE_BUILD = /* STATION_OFFLINE_BUILD */ null;
const SHELL_CACHE = `station-shell-${OFFLINE_BUILD?.version}`;
const OFFLINE_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

async function anonymousResponse(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'no-cache',
    redirect: 'error',
  });
  if (!response.ok || response.type === 'opaque')
    throw new Error('Offline shell unavailable');
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (OFFLINE_BUILD) {
        const cache = await caches.open(SHELL_CACHE);
        // Each stored response is fetched without cookies, bearer headers or a query.
        await Promise.all(
          OFFLINE_BUILD.precache.map(async (url) => {
            const response = await anonymousResponse(url);
            if (url === '/offline-shell.json') {
              const headers = new Headers({
                'Content-Type': 'text/html; charset=utf-8',
                'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff',
              });
              headers.set('Content-Security-Policy', OFFLINE_CSP);
              headers.set('Cache-Control', 'no-store');
              const { html } = await response.json();
              if (typeof html !== 'string')
                throw new Error('Invalid offline shell');
              await cache.put('/offline.html', new Response(html, { headers }));
            } else await cache.put(url, response);
          }),
        );
      }
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('station-shell-') && name !== SHELL_CACHE)
          await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener('fetch', (event) => {
  if (!OFFLINE_BUILD) return;
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.search ||
    request.headers.has('authorization') ||
    request.headers.has('range')
  )
    return;
  // Navigation responses can carry auth redirects and per-request CSP nonces.
  // Pass them through unchanged; fallback uses ONLY the generated static shell.
  if (request.mode === 'navigate') {
    if (
      /^\/(?:api|events|auth|account|sign-in|sign-out|register|\.well-known)(?:\/|$)/.test(
        url.pathname,
      )
    )
      return;
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await (await caches.open(SHELL_CACHE)).match(
            '/offline.html',
          );
          return cached || Response.error();
        }
      })(),
    );
    return;
  }
  const immutable =
    /^\/assets\/(?:[\w.-]+\/)*[\w.-]+-[\w-]{8,}\.(?:js|css|woff2?|png|svg|webp)$/.test(
      url.pathname,
    );
  const staticShell = OFFLINE_BUILD.precache.includes(url.pathname);
  if (!immutable && !staticShell) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const response = await anonymousResponse(url.href);
      await cache.put(url.pathname, response.clone());
      return response;
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return;
  }

  const {
    title = 'Station',
    body = '',
    category = 'general',
    approvalId,
    notificationId,
    agentSlug,
    apiBase = '',
    url,
    actions: customActions,
  } = data;

  // Determine notification tag and actions based on payload type
  const isApproval = !!approvalId;
  const tag = isApproval
    ? `approval-${approvalId}`
    : `notification-${notificationId || Date.now()}`;
  const actions = isApproval
    ? [
        { action: 'allow', title: 'Allow' },
        { action: 'deny', title: 'Deny' },
      ]
    : (customActions || []).map((a) => ({ action: a.id, title: a.label }));

  const showPromise = self.registration.showNotification(title, {
    body,
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag,
    requireInteraction: isApproval || category === 'urgent',
    data: { approvalId, notificationId, agentSlug, apiBase, category, url },
    actions,
  });

  event.waitUntil(showPromise);
});

self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const { approvalId, notificationId, agentSlug, apiBase, url } =
    event.notification.data || {};

  event.notification.close();

  // Requests go to this worker's own Station, never to a base the payload
  // names elsewhere.
  const stationBase = sameOriginApiBase(apiBase);

  // Tool-approval actions
  if (approvalId && (action === 'allow' || action === 'deny')) {
    event.waitUntil(
      fetch(`${stationBase}/api/tools/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, agentSlug, action }),
      }).catch(() => {}),
    );
    return;
  }

  // Generic notification actions
  if (notificationId && action) {
    event.waitUntil(
      fetch(
        `${stationBase}/notifications/${encodeURIComponent(notificationId)}/action/${encodeURIComponent(action)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      ).catch(() => {}),
    );
    return;
  }

  // Default tap — focus an existing tab (navigating it to the deep link) or
  // open a new one. Defaults to the attention inbox (/notifications) since
  // that's the canonical landing surface for an approval-request push.
  const targetUrl = sameOriginTarget(url);
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.focus);
        if (existing) {
          return Promise.resolve(existing.focus()).then(() => {
            if ('navigate' in existing) {
              return existing.navigate(targetUrl).catch(() => undefined);
            }
            return undefined;
          });
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});

/**
 * The tap's destination as an absolute URL on this worker's own origin, or
 * the inbox. The server already keeps push links on Station; this refuses
 * anything else (an absolute URL, `//host`, a path whose dot segments
 * resolve off-origin) in case a payload ever carries one. The absolute,
 * resolved URL is used as is, so it is never re-parsed as `//host`.
 */
function sameOriginTarget(url) {
  const origin = self.location.origin;
  if (typeof url === 'string' && url && !url.includes('\\')) {
    try {
      const target = new URL(url, `${origin}/`);
      if (
        (target.protocol === 'https:' || target.protocol === 'http:') &&
        target.origin === origin &&
        !target.pathname.startsWith('//')
      )
        return target.href;
    } catch {
      // Unparseable: the inbox.
    }
  }
  return new URL('/notifications', `${origin}/`).href;
}

/**
 * The API base for a tap's request: the payload's `apiBase` only when it is
 * on this worker's own origin (an http(s) URL, any path, no trailing slash),
 * else this origin. A payload can name where its request goes, never a
 * different host.
 */
function sameOriginApiBase(apiBase) {
  const origin = self.location.origin;
  if (typeof apiBase === 'string' && apiBase && !apiBase.includes('\\')) {
    try {
      const base = new URL(apiBase, `${origin}/`);
      if (
        (base.protocol === 'https:' || base.protocol === 'http:') &&
        base.origin === origin &&
        !base.pathname.startsWith('//')
      )
        return `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
    } catch {
      // Unparseable: this origin.
    }
  }
  return origin;
}
