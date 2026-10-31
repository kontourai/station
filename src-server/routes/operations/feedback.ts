import type { FeedbackRatingTarget } from '@kontourai/station-contracts/feedback';
import { FeedbackEvidenceStoreError } from '../../services/feedback/feedback-evidence-store.js';
/**
 * Feedback Routes — message rating and insights REST API.
 */

import { Hono } from 'hono';
import type {
  FeedbackService,
  MessageRating,
} from '../../services/feedback/feedback-service.js';
import { feedbackOps } from '../../telemetry/metrics.js';
import {
  feedbackAnalyzeSchema,
  feedbackDeleteSchema,
  getBody,
  RequestBodyTooLargeError,
  rateSchema,
  readRequestText,
  validate,
} from '../schemas/schemas.js';

export interface FeedbackTargetExpectation {
  conversationId: string;
  messageIndex: number;
  expectedSessionId?: string;
  expectedTurnId?: string;
}
export function createFeedbackRoutes(
  feedbackService: FeedbackService,
  resolveTarget?: (
    request: Request,
    input: FeedbackTargetExpectation,
  ) => Promise<
    { target: FeedbackRatingTarget; assertCurrent(): void } | undefined
  >,
  canExposeTarget?: (request: Request, target: FeedbackRatingTarget) => boolean,
) {
  const app = new Hono();
  const publicRating = (request: Request, entry: MessageRating) => {
    try {
      if (entry.target && canExposeTarget?.(request, entry.target) === true)
        return entry;
    } catch {}
    const { target: _privateTarget, ...publicEntry } = entry;
    return publicEntry;
  };

  // Rate a message
  app.post('/rate', validate(rateSchema), async (c) => {
    const body = getBody(c);
    const {
      agentSlug,
      conversationId,
      messageIndex,
      messagePreview,
      rating,
      reason,
    } = body;
    if (!conversationId || messageIndex == null || !rating) {
      return c.json(
        {
          success: false,
          error: 'conversationId, messageIndex, and rating are required',
        },
        400,
      );
    }
    const proof =
      body.expectedSessionId && body.expectedTurnId
        ? await resolveTarget?.(c.req.raw, {
            conversationId,
            messageIndex,
            expectedSessionId: body.expectedSessionId,
            expectedTurnId: body.expectedTurnId,
          })
        : undefined;
    if (
      proof &&
      (proof.target.conversationId !== conversationId ||
        proof.target.sessionId !== body.expectedSessionId ||
        proof.target.turnId !== body.expectedTurnId)
    )
      return c.json({ success: false, error: 'Feedback target changed' }, 409);
    proof?.assertCurrent();
    let entry: MessageRating;
    try {
      entry = feedbackService.rateMessage(
        {
          agentSlug: agentSlug || 'unknown',
          conversationId,
          messageIndex,
          messagePreview: messagePreview || '',
          rating,
          reason,
        },
        proof?.target,
      );
    } catch (error) {
      if (error instanceof FeedbackEvidenceStoreError)
        return c.json(
          { success: false, code: error.code, error: error.message },
          error.code === 'feedback_capacity' ? 409 : 503,
        );
      throw error;
    }
    proof?.assertCurrent();
    feedbackOps.add(1, { op: 'submit' });
    return c.json({ success: true, data: publicRating(c.req.raw, entry) });
  });

  // Remove a rating
  app.delete('/rate', validate(feedbackDeleteSchema), async (c) => {
    const { conversationId, messageIndex } = getBody(c);
    const ok = feedbackService.removeRating(conversationId, messageIndex);
    return c.json({ success: true, removed: ok });
  });

  // List all ratings
  app.get('/ratings', (c) => {
    return c.json({
      success: true,
      data: feedbackService
        .getRatings()
        .map((entry) => publicRating(c.req.raw, entry)),
    });
  });

  // Get behavior guidelines (what gets injected into prompts)
  app.get('/guidelines', (c) => {
    return c.json({
      success: true,
      data: {
        guidelines: feedbackService.getBehaviorGuidelines(),
        summary: feedbackService.getSummary(),
      },
    });
  });

  // Manually trigger analysis (with optional configurable counts)
  app.post('/analyze', async (c) => {
    let raw: unknown = {};
    try {
      const text = await readRequestText(c.req.raw, 4096);
      if (text.trim()) raw = JSON.parse(text);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return c.json({ success: false, error: 'Request body too large' }, 413);
      return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    }
    const parsed = feedbackAnalyzeSchema.safeParse(raw);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error: 'Feedback counts must be integers from 1 to 50.',
        },
        400,
      );
    if (!feedbackService.hasAnalyzeCallback())
      return c.json(
        { success: false, error: 'Feedback analysis is not configured.' },
        503,
      );
    const { maxReinforce, maxAvoid } = parsed.data;
    if (maxReinforce !== undefined || maxAvoid !== undefined)
      feedbackService.setMaxBehaviors(maxReinforce ?? 25, maxAvoid ?? 25);
    const summary = await feedbackService.runAnalysisPipeline();
    return c.json({ success: true, data: summary });
  });

  // Clear all analysis (re-queue everything)
  app.post('/clear-analysis', (c) => {
    feedbackService.clearAnalysis();
    return c.json({ success: true });
  });

  // Pipeline status
  app.get('/status', (c) => {
    return c.json({ success: true, data: feedbackService.getStatus() });
  });

  // Exercise model analysis with transient data; never alter saved ratings
  // or the profile that is injected into real conversations.
  app.post('/test', async (c) => {
    const start = Date.now();
    const report = await feedbackService.diagnoseAnalysis();
    const status = feedbackService.getStatus();
    return c.json({
      success: true,
      data: {
        ...report,
        totalRatings: status.totalRatings,
        pendingAnalysis: status.pendingAnalysis,
        pipelineDurationMs: Date.now() - start,
      },
    });
  });

  return app;
}
