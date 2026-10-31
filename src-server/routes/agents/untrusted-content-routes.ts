/**
 * #3483: read and clear a conversation's durable untrusted-content mark.
 *
 * Clearing relaxes a protection, so only an authenticated person who may
 * manage integrations can do it, and each clear writes a receipt naming
 * them. Agents (station-control's internal callers) cannot reach these
 * leaves: the station-control route table does not name them.
 */

import { principalIdMatchesKind } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { UntrustedConversationMarks } from '../../services/plugins/untrusted-conversation-marks.js';

export interface UntrustedContentRouteDeps {
  marks: () => UntrustedConversationMarks | undefined;
  /** Throws unless the request may manage integrations. */
  authorizeOperator: (c: Context) => Promise<void>;
  /** The authenticated request principal, if any. */
  resolveRequestPrincipalId: (c: Context) => string | undefined;
  /** The cleared conversation is forgotten by this process too. */
  onCleared: (conversationId: string) => void;
}

const conversationId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._:@-]+$|^\*$/);

export function createUntrustedContentRoutes(deps: UntrustedContentRouteDeps) {
  const app = new Hono();
  const unavailable = (c: Context) =>
    c.json(
      { success: false, error: 'Untrusted-content marks are unavailable.' },
      503,
    );

  app.get('/untrusted-content/conversations/:conversationId', async (c) => {
    const id = conversationId.safeParse(c.req.param('conversationId'));
    if (!id.success || id.data === '*')
      return c.json({ success: false, error: 'Invalid conversation id' }, 400);
    const marks = deps.marks();
    if (!marks) return unavailable(c);
    try {
      return c.json({ success: true, data: marks.status(id.data) });
    } catch {
      // An unreadable store counts as marked everywhere.
      return c.json({
        success: true,
        data: { marked: true, saturated: true, clearances: [] },
      });
    }
  });

  app.post(
    '/untrusted-content/conversations/:conversationId/clear',
    async (c) => {
      const id = conversationId.safeParse(c.req.param('conversationId'));
      if (!id.success)
        return c.json(
          { success: false, error: 'Invalid conversation id' },
          400,
        );
      try {
        await deps.authorizeOperator(c);
      } catch {
        return c.json(
          { success: false, error: 'Only the operator can clear this mark.' },
          403,
        );
      }
      const by = deps.resolveRequestPrincipalId(c);
      if (!by || !principalIdMatchesKind(by, 'human'))
        return c.json(
          {
            success: false,
            error: 'Only a signed-in person can clear this mark.',
          },
          403,
        );
      const marks = deps.marks();
      if (!marks) return unavailable(c);
      const receipt = marks.clear(id.data, by);
      deps.onCleared(id.data);
      return c.json({ success: true, data: receipt });
    },
  );

  return app;
}
