/**
 * Per-request memoization for principal/authority resolution: resolve once
 * per `Request`, cache on the request object's identity. A fresh `Request` per
 * incoming HTTP call means this never caches across requests; it only dedupes
 * repeated calls within one. A THROWN resolution is never cached, so a later
 * call re-runs the resolver and fails closed again rather than remembering a
 * stale refusal.
 */
export function memoizePerRequest<
  TContext extends { req: { raw: Request } },
  TResult,
>(resolve: (context: TContext) => TResult): (context: TContext) => TResult {
  const cache = new WeakMap<Request, TResult>();
  return (context: TContext): TResult => {
    // LOW-A (station#4518 fix round, delta review): `cache.has()`, not an
    // `undefined` sentinel — this is an EXPORTED generic, so a future
    // resolver that legitimately RETURNS `undefined` must still be cached,
    // not silently re-run on every call.
    if (cache.has(context.req.raw)) return cache.get(context.req.raw)!;
    const result = resolve(context);
    cache.set(context.req.raw, result);
    return result;
  };
}
