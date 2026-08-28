import {
  ANSWER_SHARE_REFUSAL_STATUS,
  type AnswerShareViewResult,
} from '@kontourai/station-contracts/answer-share';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AnswerShareService } from '../../services/share/answer-share-service.js';
import {
  AnswerShareStoreError,
  answerShareTokenHash,
} from '../../services/share/answer-share-store.js';
import {
  answerShareMintSchema,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';

/**
 * Answer-share routes (archive#1423) — two families with two very different
 * callers, kept in one module so the split is readable in one place.
 *
 * **Operator management** ({@link createAnswerShareRoutes}) is mounted at
 * `/api/shares` behind the runtime auth boundary and gated to `access:manage`
 * in `src-server/security/pairing-route-scopes.ts` — the same tier
 * `/api/pairing/**` uses, and for the same reason: minting a share hands a
 * third party durable read access to an answer, which is an access-granting
 * act, not an operational one. `access:manage` is the one scope
 * `PAIRING_SCOPE_PRESETS` never grants to any paired device, so no paired
 * device — however broadly scoped — can mint or revoke shares of the
 * operator's answers.
 *
 * **The share view** ({@link configureAnswerSharePublicRoutes}) is public in
 * the runtime's routing sense (registered before `configureRuntimeHttp` and
 * listed in `PUBLIC_ROUTES`) and credentialed in the product sense: the
 * request must carry a token that hashes to a stored share. It is a `POST`
 * with the token in the body rather than the path, so the capability never
 * lands in an access log, a `Referer`, or a proxy log.
 *
 * Neither family re-checks the other's authorization. A handler that
 * re-derives its own scope is how the route and the table drift apart.
 */

function storeErrorStatus(error: unknown): ContentfulStatusCode {
  if (!(error instanceof AnswerShareStoreError)) return 400;
  if (error.code === 'share_not_found') return 404;
  if (error.code === 'capacity_reached') return 429;
  return 400;
}

export function createAnswerShareRoutes(
  service: AnswerShareService,
  options: {
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  } = {},
) {
  const app = new Hono();

  app.get('/', (c) => {
    const authority = options.readAuthorityForRequest?.(c.req.raw);
    // An absent hosted ingress context is not permission to enumerate the
    // global share store. Keep the management list's empty shape stable.
    if (authority && isHostedSessionReadAuthority(authority)) {
      if (!authority.tenantExecutionContext) {
        return c.json({ success: true, data: [] });
      }
      return c.json({ success: true, data: service.list(authority) });
    }
    return c.json({ success: true, data: service.list() });
  });

  app.post('/', validate(answerShareMintSchema), async (c) => {
    const body = getBody(c) as {
      sessionId: string;
      turnId: string;
      label?: string;
      ttlMs?: number;
    };
    try {
      // Deliberately no origin. `new URL(c.req.url).origin` is the `Host`
      // header, and Station's UI proxy rewrites it to the backend before
      // forwarding — a link built from it points at a port that serves
      // neither the SPA nor the `/share` route. The client composes the
      // permalink from `window.location.origin` instead.
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      const result = authority
        ? await service.mint(
            { ...body, ownerUserId: authority.userId },
            authority,
          )
        : await service.mint(body);
      if ('error' in result) {
        return c.json(
          {
            success: false,
            error:
              'That turn has no answer on this Station, so there is nothing to share.',
          },
          404,
        );
      }
      return c.json({ success: true, data: result }, 201);
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof AnswerShareStoreError
              ? error.message
              : 'Share could not be created.',
        },
        storeErrorStatus(error),
      );
    }
  });

  app.delete('/:shareId', async (c) => {
    try {
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      // Match a missing share without consulting the service/store when
      // hosted request authority is absent.
      if (
        authority &&
        isHostedSessionReadAuthority(authority) &&
        !authority.tenantExecutionContext
      ) {
        return c.json({ success: false, error: 'Share not found' }, 404);
      }
      const data = authority
        ? await service.revoke(param(c, 'shareId'), authority)
        : await service.revoke(param(c, 'shareId'));
      return c.json({ success: true, data });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof AnswerShareStoreError
              ? error.message
              : 'Share could not be revoked.',
        },
        storeErrorStatus(error),
      );
    }
  });

  return app;
}

/** Maximum bytes of a share-view request body. A token and nothing else. */
export const ANSWER_SHARE_VIEW_MAX_BODY_BYTES = 512;

export type AnswerShareViewResponse =
  | { kind: 'rate-limited' }
  | {
      kind: 'result';
      result: AnswerShareViewResult;
      status: ContentfulStatusCode;
    };

/**
 * Attempt budgets for the public share-view route (archive#1423, security
 * review M-1).
 *
 * The first cut keyed one bucket on the socket's `remoteAddress`, copying the
 * pairing public routes. That is wrong HERE and the reason is the topology:
 * every browser reaches this route through the UI proxy, so `remoteAddress`
 * is `127.0.0.1` for all of them. One bucket, globally shared — meaning any
 * single client could spend it and 429 **the entire public share surface**
 * for five minutes, for everyone. A rate limit that converts one abuser into
 * a total outage is worse than none.
 *
 * Nor can it be fixed by trusting a forwarded-peer header: the runtime
 * deliberately ignores forwarding headers when classifying peers
 * (`normalizeSocketAddress`), because they are caller-controlled — keying a
 * limit on one lets an attacker mint a fresh bucket per request and evade it
 * entirely.
 *
 * So two budgets, each bounding the thing the other cannot:
 *
 *  - **Per token** — bounds one viewer hammering their own link. Keyed by a
 *    DIGEST of the token, never the token itself: this map outlives the
 *    request by minutes and a raw capability has no business sitting in it.
 *  - **Unknown-token, global** — bounds brute-force search, which is exactly
 *    the population that arrives with a *different* token every time and so
 *    can never be caught by a per-token bucket.
 *
 * The global budget is **reserved before the store lookup and refunded when
 * the token resolves** (security review N-1). Charging it afterwards — the
 * obvious ordering, and the first fix's — preserved starvation-immunity but
 * silently dropped the WORK bound: every unknown-token request still ran a
 * full `existsSync` + `lstat` + `readFile` + parse + validate over the whole
 * record set before the budget could refuse it, measured at ~0.59ms of
 * SYNCHRONOUS event-loop time at the 500-record ceiling. That is ~1700 req/s
 * to saturate the runtime, unauthenticated and remote-reachable through the
 * UI proxy: a rate limiter that bounds only *responses* is not a rate limiter.
 *
 * Reserve-then-refund keeps both properties, and they are independent:
 *
 *  - **Work bound** — a caller past the global budget is refused BEFORE the
 *    store is touched, so guessing costs a map lookup, not a file read.
 *  - **Starvation immunity** — a request whose token resolves has its
 *    reservation refunded, so legitimate holders never consume the budget an
 *    attacker is spending, and exhausting it can never lock them out.
 */
export interface AnswerShareViewBudget {
  /** Charged for a request whose token resolves to a stored share. */
  consumeForToken: (tokenKey: string) => boolean;
  /**
   * Taken BEFORE the store lookup, so an exhausted budget refuses without
   * doing the work. Refunded via {@link AnswerShareViewBudget.refundUnknownToken}
   * when the token turns out to resolve.
   */
  reserveUnknownToken: () => boolean;
  /**
   * Returns a reservation taken by
   * {@link AnswerShareViewBudget.reserveUnknownToken}. Called only on the
   * path where the token resolved, which is what keeps a real holder's
   * traffic off the guessing budget entirely.
   */
  refundUnknownToken: () => void;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * The default budget: a fixed-window counter per key plus one global window,
 * with a bounded key map so an attacker cannot grow it without limit (the
 * oldest entry is evicted, matching `consumePairingAttempt`'s shape).
 */
export function createAnswerShareViewBudget(
  options: {
    now?: () => number;
    perTokenLimit?: number;
    unknownTokenLimit?: number;
    windowMs?: number;
    maxTrackedTokens?: number;
  } = {},
): AnswerShareViewBudget {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 5 * 60_000;
  const perTokenLimit = options.perTokenLimit ?? 120;
  const unknownTokenLimit = options.unknownTokenLimit ?? 60;
  const maxTracked = options.maxTrackedTokens ?? 1_024;
  const perToken = new Map<string, Window>();
  let unknown: Window | undefined;

  function consume(
    current: Window | undefined,
    limit: number,
  ): { allowed: boolean; next: Window } {
    const timestamp = now();
    if (!current || current.resetAt <= timestamp) {
      return {
        allowed: true,
        next: { count: 1, resetAt: timestamp + windowMs },
      };
    }
    if (current.count >= limit) return { allowed: false, next: current };
    return { allowed: true, next: { ...current, count: current.count + 1 } };
  }

  return {
    consumeForToken(tokenKey) {
      const { allowed, next } = consume(perToken.get(tokenKey), perTokenLimit);
      if (allowed) {
        if (!perToken.has(tokenKey) && perToken.size >= maxTracked) {
          const oldest = perToken.keys().next().value;
          if (oldest !== undefined) perToken.delete(oldest);
        }
        perToken.set(tokenKey, next);
      }
      return allowed;
    },
    reserveUnknownToken() {
      const { allowed, next } = consume(unknown, unknownTokenLimit);
      if (allowed) unknown = next;
      return allowed;
    },
    refundUnknownToken() {
      // Only ever undoes a reservation this same window granted. Guarded at
      // zero so a stray refund cannot mint budget, and skipped once the
      // window has rolled over — the reservation being returned belonged to
      // a window that no longer exists.
      if (unknown && unknown.count > 0 && unknown.resetAt > now()) {
        unknown = { ...unknown, count: unknown.count - 1 };
      }
    },
  };
}

/**
 * The share-view handler, as a plain function so it can be registered by
 * `runtime-routes.ts` (which owns the app type) and exercised by a test with
 * neither an app nor a socket.
 *
 * Token guessing is the only attack this route has, and a 256-bit token plus
 * {@link AnswerShareViewBudget} is the whole defense.
 */
export async function handleAnswerShareView(input: {
  request: Request;
  service: AnswerShareService;
  budget: AnswerShareViewBudget;
  /** Omitted only by the public personal-mode compatibility mount. */
  authority?: SessionReadAuthority;
  readBoundedBody: (
    request: Request,
    maxBytes: number,
  ) => Promise<{ status: 'ok'; body: string } | { status: string }>;
}): Promise<AnswerShareViewResponse> {
  // No query strings on a public POST at all — the same refusal the pairing
  // public routes make, and here it also stops a token from being smuggled
  // into somewhere that gets logged.
  if (new URL(input.request.url).search) {
    return refuseUnknown(input.budget);
  }

  const read = await input.readBoundedBody(
    input.request,
    ANSWER_SHARE_VIEW_MAX_BODY_BYTES,
  );
  // Every unusable body — too large, unreadable, not JSON, no token — takes
  // the SAME path as an unknown token. A distinct "invalid request" here
  // would tell a prober which of their guesses was at least well-formed.
  let token: unknown;
  if (read.status === 'ok') {
    try {
      token = (
        JSON.parse((read as { body: string }).body) as { token?: unknown }
      )?.token;
    } catch {
      token = undefined;
    }
  }
  if (typeof token !== 'string') return refuseUnknown(input.budget);

  // Charged BEFORE the lookup so a viewer hammering a real link is bounded,
  // and keyed by digest so no raw capability lands in a minutes-long map.
  if (!input.budget.consumeForToken(answerShareTokenHash(token))) {
    return { kind: 'rate-limited' };
  }

  // RESERVE before the lookup. Every request is brute-force-shaped until the
  // store says otherwise, and the store is the expensive part — so the budget
  // has to be able to refuse without paying it (N-1).
  if (!input.budget.reserveUnknownToken()) return { kind: 'rate-limited' };

  const result = input.service.view(token, input.authority);

  // ...and REFUND once possession is proven. Anything other than
  // `share-not-found` means the token matched a stored record — revoked,
  // expired, and answer-gone all required the real token to reach — so this
  // caller is a holder, not a guesser, and must not spend the guessing budget.
  if (!(result.state === 'refused' && result.reason === 'share-not-found')) {
    input.budget.refundUnknownToken();
  }

  return {
    kind: 'result',
    result,
    status:
      result.state === 'refused'
        ? (ANSWER_SHARE_REFUSAL_STATUS[result.reason] as ContentfulStatusCode)
        : 200,
  };
}

/**
 * An unresolvable request — no token at all, or a body that never yielded
 * one. Charged globally and never refunded (nothing was proven), and it never
 * reaches the store, so the work bound holds here trivially.
 */
function refuseUnknown(budget: AnswerShareViewBudget): AnswerShareViewResponse {
  return budget.reserveUnknownToken() ? notFound() : { kind: 'rate-limited' };
}

function notFound(): AnswerShareViewResponse {
  return {
    kind: 'result',
    result: { state: 'refused', reason: 'share-not-found' },
    status: ANSWER_SHARE_REFUSAL_STATUS[
      'share-not-found'
    ] as ContentfulStatusCode,
  };
}
