/**
 * Feedback Routes — message rating and insights REST API.
 */

import { Hono } from 'hono';
import type { FeedbackService } from '../../services/feedback/feedback-service.js';
import { feedbackOps } from '../../telemetry/metrics.js';
import {
  feedbackDeleteSchema,
  getBody,
  rateSchema,
  validate,
} from '../schemas/schemas.js';

export function createFeedbackRoutes(feedbackService: FeedbackService) {
  const app = new Hono();

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
    const entry = feedbackService.rateMessage({
      agentSlug: agentSlug || 'unknown',
      conversationId,
      messageIndex,
      messagePreview: messagePreview || '',
      rating,
      reason,
    });
    feedbackOps.add(1, { op: 'submit' });
    return c.json({ success: true, data: entry });
  });

  // Remove a rating
  app.delete('/rate', validate(feedbackDeleteSchema), async (c) => {
    const { conversationId, messageIndex } = getBody(c);
    const ok = feedbackService.removeRating(conversationId, messageIndex);
    return c.json({ success: true, removed: ok });
  });

  // List all ratings
  app.get('/ratings', (c) => {
    return c.json({ success: true, data: feedbackService.getRatings() });
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
    try {
      const body = await c.req.json();
      if (body.maxReinforce || body.maxAvoid) {
        feedbackService.setMaxBehaviors(
          body.maxReinforce || 25,
          body.maxAvoid || 25,
        );
      }
    } catch (e) {
      console.debug('Failed to parse feedback analyze request body:', e);
      /* no body is fine */
    }
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

  // Diagnostic test — exercises the full pipeline and returns results
  app.post('/test', async (c) => {
    const start = Date.now();
    const agentAvailable = feedbackService.hasAnalyzeCallback();

    // Create synthetic rating
    const synthetic = feedbackService.rateMessage({
      agentSlug: '_test',
      conversationId: '_test_pipeline',
      messageIndex: 0,
      messagePreview:
        'Test message for pipeline verification — the assistant provided a clear, concise answer with code examples.',
      rating: 'thumbs_up',
    });

    let analysisRan = false;
    let guidelinesGenerated = false;
    let guidelinesPreview = '';

    if (agentAvailable) {
      await feedbackService.runAnalysisPipeline();
      analysisRan = true;
      const guidelines = feedbackService.getBehaviorGuidelines();
      guidelinesGenerated = guidelines.length > 0;
      guidelinesPreview = guidelines.slice(0, 300);
    }

    // Clean up synthetic rating
    feedbackService.removeRating('_test_pipeline', 0);

    const status = feedbackService.getStatus();
    return c.json({
      success: true,
      data: {
        agentAvailable,
        syntheticRatingCreated: !!synthetic,
        analysisRan,
        guidelinesGenerated,
        guidelinesPreview,
        totalRatings: status.totalRatings,
        pendingAnalysis: status.pendingAnalysis,
        pipelineDurationMs: Date.now() - start,
      },
    });
  });

  return app;
}
