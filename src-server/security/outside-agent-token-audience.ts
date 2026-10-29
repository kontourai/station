import type { MiddlewareHandler } from 'hono';

// Outside artifacts are 47 characters; Station internal/device tokens are 43.
/** Negative namespace boundary, never an authenticator: outside artifacts cannot substitute on another Station surface. */
export const outsideAgentTokenAudience: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  const candidates = [
    c.req.header('authorization')?.replace(/^Bearer\s+/i, ''),
    c.req.header('x-station-control-caller-token'),
    ...url.searchParams.getAll('token'),
  ];
  if (
    candidates.some((value) =>
      /^(oat|ort|oac)_[A-Za-z0-9_-]{43}$/.test(value ?? ''),
    ) &&
    !(c.req.path === '/mcp' && url.pathname === '/mcp')
  )
    return c.json({ error: 'invalid_token' }, 401);
  await next();
};
