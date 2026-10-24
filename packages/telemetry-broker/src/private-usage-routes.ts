import { Hono } from 'hono';
import {
  PrivateUsageError,
  type PrivateUsageRepository,
} from './private-usage-store.js';

/** Storage capability only. Core still verifies the person and current source before use. */
export function createPrivateUsageRoutes(store: PrivateUsageRepository) {
  const app = new Hono();
  const key = (request: Request) => {
    const token = /^Bearer (stai_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.get('authorization') ?? '',
    )?.[1];
    if (!token) throw new PrivateUsageError('unauthorized');
    return token;
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    key(c.req.raw);
    await next();
  });
  app.post('/pages', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new PrivateUsageError('invalid_commit');
    }
    return c.json({ receipt: await store.commit(key(c.req.raw), body) }, 201);
  });
  app.post('/invalidations', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new PrivateUsageError('invalid_commit');
    }
    return c.json(
      { receipt: await store.applyInvalidations(key(c.req.raw), body) },
      201,
    );
  });
  app.get('/invalidation-commits/:operationId', async (c) => {
    const receipt = await store.invalidationReceipt(
      key(c.req.raw),
      c.req.param('operationId'),
    );
    return receipt
      ? c.json({ receipt })
      : c.json({ error: 'private_usage_receipt_unavailable' }, 404);
  });
  app.get('/checkpoint', async (c) => {
    const q = new URL(c.req.url).searchParams;
    const from = q.get('from'),
      to = q.get('to');
    if (
      [...q.keys()].some(
        (name) => !['from', 'to'].includes(name) || q.getAll(name).length !== 1,
      ) ||
      !from ||
      !to ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      new Date(from).toISOString().slice(0, 10) !== from ||
      new Date(to).toISOString().slice(0, 10) !== to ||
      Date.parse(to) - Date.parse(from) > 365 * 86400000 ||
      from > to
    )
      throw new PrivateUsageError('invalid_commit');
    return c.json(await store.checkpoint(key(c.req.raw), from, to));
  });
  app.get('/commits/:operationId', async (c) => {
    const receipt = await store.receipt(
      key(c.req.raw),
      c.req.param('operationId'),
    );
    return receipt
      ? c.json({ receipt })
      : c.json({ error: 'private_usage_receipt_unavailable' }, 404);
  });
  app.get('/observations', async (c) => {
    const q = new URL(c.req.url).searchParams;
    if (
      [...q.keys()].some(
        (name) =>
          !['after', 'highWater'].includes(name) || q.getAll(name).length !== 1,
      )
    )
      throw new PrivateUsageError('invalid_commit');
    const integer = (name: string) => {
      const raw = q.get(name);
      if (raw === null) return undefined;
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new PrivateUsageError('invalid_commit');
      return Number(raw);
    };
    return c.json(
      await store.observations(
        key(c.req.raw),
        integer('after') ?? 0,
        integer('highWater'),
      ),
    );
  });
  app.delete('/vault', async (c) => c.json(await store.revoke(key(c.req.raw))));
  app.onError((error, c) => {
    if (error instanceof PrivateUsageError)
      return c.json(
        { error: error.message },
        error.code === 'unauthorized'
          ? 401
          : error.code === 'invalid_commit'
            ? 400
            : error.code === 'conflict'
              ? 409
              : error.code === 'capacity'
                ? 507
                : error.code === 'expired'
                  ? 403
                  : 503,
      );
    return c.json({ error: 'private_usage_unavailable' }, 503);
  });
  return app;
}
