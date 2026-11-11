/**
 * `/api/read-markers` (#3075): the caller's own server-kept read state.
 *
 * - `POST /summary` `{ targets }` — read state for up to
 *   `READ_MARKER_SUMMARY_MAX_TARGETS` conversations at once. More is a 400
 *   with `read_marker_too_many_targets`, never a truncated answer.
 * - `POST /mark` `{ target, version }` — advance the caller's marker.
 *   Monotonic and idempotent: an older version answers the stored state and
 *   changes nothing. A version above the conversation's current one is a 409
 *   with `read_marker_future_version`; a conversation the caller cannot read
 *   is a 404, identical whether or not it exists.
 *
 * Whose marker it is comes only from the request: the per-person key the
 * conversation inventory files "last viewed" under. No body field names a
 * person; a caller that is not a person is refused (403).
 */
import {
  InvalidReadMarkerInputError,
  parseReadMarkerMarkRequest,
  parseReadMarkerSummaryRequest,
  READ_MARKER_REFUSAL_CODES,
  READ_MARKER_SUMMARY_MAX_TARGETS,
  ReadMarkerTooManyTargetsError,
} from '@kontourai/station-contracts/read-markers';
import { Hono } from 'hono';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import {
  ReadMarkerFutureVersionError,
  ReadMarkerNoPersonError,
  type ReadMarkerService,
} from '../../services/read-markers/read-marker-service.js';

/** A summary body naming 100 targets fits well inside this. */
const MAX_BODY_BYTES = 128 * 1024;

async function readBody(c: {
  req: { text(): Promise<string> };
}): Promise<unknown> {
  const raw = await c.req.text().catch(() => undefined);
  if (raw === undefined || raw.length > MAX_BODY_BYTES)
    throw new InvalidReadMarkerInputError('body is missing or too large');
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidReadMarkerInputError('body is not JSON');
  }
}

export function createReadMarkerRoutes(deps: {
  service: Pick<ReadMarkerService, 'summary' | 'mark'>;
}) {
  const app = new Hono();

  // Every refusal answers an authored sentence, never a caught `.message`
  // (route-error-egress-gate): the typed errors below only choose which.
  const refuse = (
    c: { json: (body: unknown, status: 400 | 403 | 409) => Response },
    error: unknown,
  ): Response => {
    if (error instanceof ReadMarkerTooManyTargetsError)
      return c.json(
        {
          success: false,
          code: READ_MARKER_REFUSAL_CODES.tooManyTargets,
          error: `A summary names at most ${READ_MARKER_SUMMARY_MAX_TARGETS} conversations.`,
        },
        400,
      );
    if (error instanceof InvalidReadMarkerInputError)
      return c.json(
        { success: false, error: 'Invalid read marker request.' },
        400,
      );
    if (error instanceof ReadMarkerFutureVersionError)
      return c.json(
        {
          success: false,
          code: READ_MARKER_REFUSAL_CODES.futureVersion,
          error: "That version is past the conversation's current version.",
          latestVersion: error.latestVersion,
        },
        409,
      );
    // As the conversation acknowledgement route answers a non-person.
    if (error instanceof ReadMarkerNoPersonError)
      return c.json(
        { success: false, error: 'Only a person has read state' },
        403,
      );
    // A deterministic authz refusal, answered like `/api/me/layouts` does.
    if (error instanceof PrincipalUnresolvedError)
      return c.json(
        {
          success: false,
          code: error.code,
          error: 'This request has no resolvable person.',
        },
        400,
      );
    throw error;
  };

  app.post('/summary', async (c) => {
    try {
      const { targets } = parseReadMarkerSummaryRequest(await readBody(c));
      const items = await deps.service.summary(c, targets);
      return c.json({ success: true, data: { items } });
    } catch (error) {
      return refuse(c, error);
    }
  });

  app.post('/mark', async (c) => {
    try {
      const { target, version } = parseReadMarkerMarkRequest(await readBody(c));
      const state = await deps.service.mark(c, target, version);
      if (!state)
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      return c.json({ success: true, data: state });
    } catch (error) {
      return refuse(c, error);
    }
  });

  return app;
}
