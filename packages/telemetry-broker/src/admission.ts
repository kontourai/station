import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';

export function receiverAdmission(): MiddlewareHandler<{
  Bindings: HttpBindings;
  Variables: { dailyClient: { day: string; hash: string } };
}> {
  let active = 0;
  let tokens = 60;
  let replenishedAt = performance.now();
  return async (c, next) => {
    const now = performance.now();
    tokens = Math.min(60, tokens + (now - replenishedAt) / 1000);
    replenishedAt = now;
    if (tokens < 1) {
      c.header('Retry-After', '1');
      return c.json({ error: 'receiver_rate_limit' }, 429);
    }
    if (active >= 8) return c.json({ error: 'receiver_busy' }, 503);
    tokens--;
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  };
}
