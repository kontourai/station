import type { MiddlewareHandler } from 'hono';

/** SUNSET(#4115): remove the compiled refusal only in the reviewed R6 release change. No configuration can enable it. */
export const outsideAgentReleaseGuard: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (
    path === '/mcp' ||
    path === '/mcp/' ||
    path === '/oauth' ||
    path.startsWith('/oauth/') ||
    path === '/api/outside-agent' ||
    path.startsWith('/api/outside-agent/') ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-protected-resource' ||
    path.startsWith('/.well-known/oauth-protected-resource/')
  )
    return c.notFound();
  await next();
};
