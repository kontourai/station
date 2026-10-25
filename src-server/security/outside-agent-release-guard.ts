import type { Context, MiddlewareHandler } from 'hono';
import type { ConsentChannelService } from '../services/consent/consent-channel.js';

function isOutsideAgentPath(path: string): boolean {
  return (
    path === '/mcp' ||
    path === '/mcp/' ||
    path === '/oauth' ||
    path.startsWith('/oauth/') ||
    path === '/api/outside-agent' ||
    path.startsWith('/api/outside-agent/') ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-authorization-server/' ||
    path === '/.well-known/oauth-protected-resource' ||
    path.startsWith('/.well-known/oauth-protected-resource/')
  );
}

/** SUNSET(#4115): remove the compiled refusal only in the reviewed R6 release change. No configuration can enable it. */
export const outsideAgentReleaseGuard: MiddlewareHandler = async (c, next) => {
  // Use Hono's once-decoded routing path. Case and duplicate slashes remain
  // significant, as in its strict router; encoded guarded segments are refused.
  const path = c.req.path;
  const rawPath = new URL(c.req.url).pathname;
  if (
    isOutsideAgentPath(path) ||
    (path !== rawPath && isOutsideAgentPath(rawPath))
  )
    return c.notFound();
  await next();
};

/** SUNSET(#4115): shared consent paths must also refuse outside targets until R6. */
export function outsideAgentConsentReleaseGuard(
  channel: ConsentChannelService,
  refuse: (c: Context) => Response,
): MiddlewareHandler {
  return async (c, next) => {
    const segments = c.req.path.split('/');
    const sharedRoute =
      segments[1] === 'consent' &&
      ((c.req.method === 'GET' && segments.length === 3) ||
        (c.req.method === 'POST' &&
          segments.length === 4 &&
          segments[3] === 'decide'));
    if (sharedRoute) {
      const transaction = channel.store.get(
        channel.tenantId,
        segments[2] ?? '',
      );
      if (!transaction || transaction.target.kind.startsWith('outside-agent-'))
        return refuse(c);
    }
    await next();
  };
}
