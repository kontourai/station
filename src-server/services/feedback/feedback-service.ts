/**
 * FeedbackService — message ratings, automated analysis, and behavior guidelines.
 */

import { join } from 'node:path';
import { feedbackOps } from '../../telemetry/metrics.js';
import { JsonFileStore } from '../infra/json-store.js';
import {
  runFullFeedbackAnalysis,
  runMiniFeedbackAnalysis,
} from './feedback-analysis.js';

export type RatingValue = 'thumbs_up' | 'thumbs_down';

export interface MessageRating {
  id: string;
  agentSlug: string;
  conversationId: string;
  messageIndex: number;
  messagePreview: string;
  rating: RatingValue;
  reason?: string;
  analysis?: string;
  createdAt: string;
  analyzedAt?: string;
}

export interface FeedbackSummary {
  reinforce: string[];
  avoid: string[];
  analyzedCount: number;
  updatedAt: string;
}

export interface FeedbackStore {
  ratings: MessageRating[];
  summary: FeedbackSummary | null;
}

export type AnalyzeCallback = (prompt: string) => Promise<string>;

const ANALYSIS_INTERVAL_MS = 10 * 60 * 1000;

export class FeedbackService {
  private store: JsonFileStore<FeedbackStore>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private analyzeFn: AnalyzeCallback | null = null;
  private maxReinforce = 25;
  private maxAvoid = 25;
  private lastAnalyzedAt: number | null = null;
  private isAnalyzing = false;

  constructor(dataDir: string) {
    this.store = new JsonFileStore<FeedbackStore>(
      join(dataDir, 'feedback', 'feedback.json'),
      { ratings: [], summary: null },
    );
  }

  setAnalyzeCallback(fn: AnalyzeCallback): void {
    this.analyzeFn = fn;
  }

  rateMessage(params: {
    agentSlug: string;
    conversationId: string;
    messageIndex: number;
    messagePreview: string;
    rating: RatingValue;
    reason?: string;
  }): MessageRating {
    const data = this.store.read();
    const key = `${params.conversationId}:${params.messageIndex}`;
    const existing = data.ratings.findIndex(
      (rating) =>
        rating.conversationId === params.conversationId &&
        rating.messageIndex === params.messageIndex,
    );

    const entry: MessageRating = {
      id: existing >= 0 ? data.ratings[existing].id : key,
      agentSlug: params.agentSlug,
      conversationId: params.conversationId,
      messageIndex: params.messageIndex,
      messagePreview: params.messagePreview.slice(0, 200),
      rating: params.rating,
      reason: params.reason?.slice(0, 100),
      createdAt:
        existing >= 0
          ? data.ratings[existing].createdAt
          : new Date().toISOString(),
      analysis: undefined,
      analyzedAt: undefined,
    };

    if (existing >= 0) {
      data.ratings[existing] = entry;
    } else {
      data.ratings.push(entry);
    }

    this.store.write(data);
    feedbackOps.add(1, {
      operation: 'rate',
      rating: params.rating,
      agent: params.agentSlug,
    });
    return entry;
  }

  removeRating(conversationId: string, messageIndex: number): boolean {
    const data = this.store.read();
    const before = data.ratings.length;
    data.ratings = data.ratings.filter(
      (rating) =>
        !(
          rating.conversationId === conversationId &&
          rating.messageIndex === messageIndex
        ),
    );
    if (data.ratings.length < before) {
      this.store.write(data);
      return true;
    }
    return false;
  }

  getRatings(): MessageRating[] {
    return this.store.read().ratings;
  }

  getSummary(): FeedbackSummary | null {
    return this.store.read().summary;
  }

  hasAnalyzeCallback(): boolean {
    return this.analyzeFn !== null;
  }

  setMaxBehaviors(reinforce: number, avoid: number): void {
    this.maxReinforce = Math.max(1, Math.min(reinforce, 50));
    this.maxAvoid = Math.max(1, Math.min(avoid, 50));
  }

  getStatus() {
    const data = this.store.read();
    return {
      lastAnalyzedAt: this.lastAnalyzedAt,
      nextAnalysisAt: this.lastAnalyzedAt
        ? this.lastAnalyzedAt + ANALYSIS_INTERVAL_MS
        : null,
      isAnalyzing: this.isAnalyzing,
      analyzeCallbackAvailable: this.analyzeFn !== null,
      totalRatings: data.ratings.length,
      pendingAnalysis: data.ratings.filter((rating) => !rating.analyzedAt)
        .length,
    };
  }

  getBehaviorGuidelines(): string {
    return this.getBehaviorGuidelinesDetailed()?.text ?? '';
  }

  /**
   * station#2649: the guidelines string plus the reinforce/avoid counts that
   * describe THAT string, from ONE read of the summary — so the per-turn
   * context-injection receipt cannot report counts from a different summary
   * revision than the text actually injected.
   */
  getBehaviorGuidelinesDetailed(): {
    text: string;
    reinforce: number;
    avoid: number;
  } | null {
    const summary = this.store.read().summary;
    if (
      !summary ||
      (summary.reinforce.length === 0 && summary.avoid.length === 0)
    ) {
      return null;
    }

    const reinforce = summary.reinforce
      .map((behavior) => `- ${behavior}`)
      .join('\n');
    const avoid = summary.avoid.map((behavior) => `- ${behavior}`).join('\n');

    return {
      text: `<feedback_profile>
Based on ${summary.analyzedCount} rated responses, the user prefers:

BEHAVIORS TO REINFORCE:
${reinforce || '(none identified yet)'}

BEHAVIORS TO AVOID:
${avoid || '(none identified yet)'}
</feedback_profile>`,
      reinforce: summary.reinforce.length,
      avoid: summary.avoid.length,
    };
  }

  start(): void {
    this.initialTimer = setTimeout(() => this.runAnalysisPipeline(), 5000);
    this.timer = setInterval(
      () => this.runAnalysisPipeline(),
      ANALYSIS_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runAnalysisPipeline(): Promise<FeedbackSummary | null> {
    if (!this.analyzeFn) return null;
    this.isAnalyzing = true;
    try {
      feedbackOps.add(1, { operation: 'analyze' });
      const analyzeStart = Date.now();
      await this.runMiniAnalysis();
      await this.runFullAnalysis();
      this.lastAnalyzedAt = Date.now();
      const summary = this.store.read().summary;
      feedbackOps.add(1, {
        operation: 'analyze-complete',
        reinforceCount: String(summary?.reinforce.length || 0),
        avoidCount: String(summary?.avoid.length || 0),
        durationMs: String(Date.now() - analyzeStart),
      });
    } catch (error) {
      console.debug('Failed to run feedback analysis pipeline:', error);
    } finally {
      this.isAnalyzing = false;
    }
    return this.store.read().summary;
  }

  /**
   * Fold analysis results onto the CURRENT store rather than writing back the
   * snapshot the analysis was computed from (#2900). An analysis is an LLM
   * round-trip, which is long enough for a user to rate another message;
   * writing the snapshot back discarded that rating with no signal at all,
   * because `JsonFileStore` has no version check and its write is atomic —
   * the result is a well-formed file that is simply missing a rating.
   *
   * Only annotations are folded, and only onto an entry that is still the one
   * that was analyzed: `rateMessage` reuses the id for a re-rated
   * message and clears `analyzedAt`, so matching on id alone would attach a
   * summary of the OLD message content to the NEW rating.
   */
  private foldAnalyzedRatings(
    analyzed: MessageRating[],
    current: FeedbackStore,
  ): FeedbackStore {
    const analyzedById = new Map(analyzed.map((entry) => [entry.id, entry]));
    return {
      ...current,
      ratings: current.ratings.map((entry) => {
        const source = analyzedById.get(entry.id);
        if (
          !source?.analyzedAt ||
          entry.analyzedAt ||
          source.rating !== entry.rating ||
          source.messagePreview !== entry.messagePreview
        ) {
          return entry;
        }
        return {
          ...entry,
          analysis: source.analysis,
          analyzedAt: source.analyzedAt,
        };
      }),
    };
  }

  private async runMiniAnalysis(): Promise<void> {
    if (!this.analyzeFn) return;

    const data = this.store.read();
    if (data.ratings.every((rating) => rating.analyzedAt)) return;

    try {
      const analyzed = await runMiniFeedbackAnalysis(this.analyzeFn, data);
      // Re-read AFTER the await. No await separates this read from the write,
      // so the fold is atomic against other in-process writers.
      this.store.write(
        this.foldAnalyzedRatings(analyzed.ratings, this.store.read()),
      );
    } catch (error) {
      console.debug('Failed to run mini feedback analysis:', error);
    }
  }

  private async runFullAnalysis(): Promise<void> {
    if (!this.analyzeFn) return;

    const data = this.store.read();
    try {
      const summary = await runFullFeedbackAnalysis({
        analyze: this.analyzeFn,
        data,
        maxReinforce: this.maxReinforce,
        maxAvoid: this.maxAvoid,
      });
      if (summary) {
        // Spread the CURRENT store, not `data`: ratings submitted during the
        // analysis above must survive the summary write (#2900).
        this.store.write({ ...this.store.read(), summary });
      }
    } catch (error) {
      console.debug('Failed to run full feedback analysis:', error);
    }
  }

  clearAnalysis(): void {
    const data = this.store.read();
    this.store.write({
      ratings: data.ratings.map((rating) => ({
        ...rating,
        analysis: undefined,
        analyzedAt: undefined,
      })),
      summary: null,
    });
  }
}
