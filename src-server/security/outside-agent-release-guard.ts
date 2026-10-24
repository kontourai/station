import type { MiddlewareHandler } from 'hono';

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
