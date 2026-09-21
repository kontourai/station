/**
 * Per-request memoization for principal/authority resolution: resolve once
 * per `Request`, cache on the request object's identity. Moved verbatim from
 * `runtime-routes.ts` so the canonical principal owner
 * (`runtime/bootstrap/orchestration-request-principal.ts`) can live outside
 * the routes module without a cycle; re-exported there for existing imports.
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
