/**
 * FeedbackService — message ratings, automated analysis, and behavior guidelines.
 */

import { join } from 'node:path';
import { feedbackOps } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { JsonFileStore } from '../infra/json-store.js';
import {
  hasFeedbackAnalysis,
  needsFeedbackAnalysis,
  parseFeedbackSummary,
  runFullFeedbackAnalysis,
  runMiniFeedbackAnalysis,
} from './feedback-analysis.js';

const logger = createLogger({ name: 'feedback-service' });

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
  /** Hash of the full summary prompt; absent on legacy stores. */
  summaryBasis?: string;
}

export type AnalyzeCallback = (prompt: string) => Promise<string>;

interface FeedbackDiagnostic {
  isolated: true;
  agentAvailable: boolean;
  syntheticRatingCreated: boolean;
  analysisRan: boolean;
  guidelinesGenerated: boolean;
  guidelinesPreview: string;
}

const ANALYSIS_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_ANALYSIS_DELAY_MS = 5000;

export class FeedbackService {
  private store: JsonFileStore<FeedbackStore>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private analyzeFn: AnalyzeCallback | null = null;
  private maxReinforce = 25;
  private maxAvoid = 25;
  private lastAnalyzedAt: number | null = null;
  private nextAnalysisAt: number | null = null;
  private analysisGeneration = 0;
  private stopped = false;
  private pendingAnalysis: {
    generation: number;
    promise: Promise<FeedbackSummary | null>;
  } | null = null;
  private pendingDiagnostic: {
    generation: number;
    promise: Promise<FeedbackDiagnostic>;
  } | null = null;
  private analysisTail: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.store = new JsonFileStore<FeedbackStore>(
      join(dataDir, 'feedback', 'feedback.json'),
      { ratings: [], summary: null },
    );
  }

  setAnalyzeCallback(fn: AnalyzeCallback): void {
    if (this.analyzeFn !== fn) this.analysisGeneration += 1;
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
      data.summary = null;
      data.summaryBasis = undefined;
      this.analysisGeneration += 1;
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
      data.summary = null;
      data.summaryBasis = undefined;
      this.analysisGeneration += 1;
      this.store.write(data);
      return true;
    }
    return false;
  }

  getRatings(): MessageRating[] {
    return this.store
      .read()
      .ratings.map((rating) =>
        !hasFeedbackAnalysis(rating) &&
        (rating.analysis !== undefined || rating.analyzedAt !== undefined)
          ? { ...rating, analysis: undefined, analyzedAt: undefined }
          : rating,
      );
  }

  getSummary(): FeedbackSummary | null {
    const summary = this.store.read().summary;
    return parseFeedbackSummary(summary);
  }

  hasAnalyzeCallback(): boolean {
    return this.analyzeFn !== null;
  }

  setMaxBehaviors(reinforce: number, avoid: number): void {
    const nextReinforce = Number.isFinite(reinforce)
      ? Math.max(1, Math.min(Math.floor(reinforce), 50))
      : 25;
    const nextAvoid = Number.isFinite(avoid)
      ? Math.max(1, Math.min(Math.floor(avoid), 50))
      : 25;
    if (nextReinforce !== this.maxReinforce || nextAvoid !== this.maxAvoid)
      this.analysisGeneration += 1;
    this.maxReinforce = nextReinforce;
    this.maxAvoid = nextAvoid;
  }

  getStatus() {
    const data = this.store.read();
    return {
      lastAnalyzedAt: this.lastAnalyzedAt,
      nextAnalysisAt: this.nextAnalysisAt,
      isAnalyzing:
        this.pendingAnalysis !== null || this.pendingDiagnostic !== null,
      analyzeCallbackAvailable: this.analyzeFn !== null,
      totalRatings: data.ratings.length,
      pendingAnalysis: data.ratings.filter(needsFeedbackAnalysis).length,
    };
  }

  getBehaviorGuidelines(): string {
    return this.getBehaviorGuidelinesDetailed()?.text ?? '';
  }

  /**
   * archive#2649: the guidelines string plus the reinforce/avoid counts that
   * describe THAT string, from ONE read of the summary — so the per-turn
   * context-injection receipt cannot report counts from a different summary
   * revision than the text actually injected.
   */
  getBehaviorGuidelinesDetailed(): {
    text: string;
    reinforce: number;
    avoid: number;
  } | null {
    return this.formatBehaviorGuidelines(this.getSummary());
  }

  private formatBehaviorGuidelines(summary: FeedbackSummary | null) {
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
    if (this.initialTimer || this.timer) return;
    this.stopped = false;
    const startedAt = Date.now();
    const intervalAt = startedAt + ANALYSIS_INTERVAL_MS;
    this.nextAnalysisAt = startedAt + INITIAL_ANALYSIS_DELAY_MS;
    const scheduledAnalysis = () => {
      void this.runAnalysisPipeline().catch((error) =>
        logger.debug('Failed to run scheduled feedback analysis', { error }),
      );
    };
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.nextAnalysisAt = intervalAt;
      scheduledAnalysis();
    }, INITIAL_ANALYSIS_DELAY_MS);
    this.timer = setInterval(() => {
      this.nextAnalysisAt = Date.now() + ANALYSIS_INTERVAL_MS;
      scheduledAnalysis();
    }, ANALYSIS_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.nextAnalysisAt = null;
    this.analysisGeneration += 1;
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
    if (!this.analyzeFn || this.stopped) return null;
    const generation = this.analysisGeneration;
    if (this.pendingAnalysis?.generation === generation)
      return this.pendingAnalysis.promise;
    const promise = this.queueAnalysis(() =>
      this.executeAnalysisPipeline(generation),
    );
    this.pendingAnalysis = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.pendingAnalysis?.promise === promise)
        this.pendingAnalysis = null;
    }
  }

  private queueAnalysis<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.analysisTail.then(operation);
    // Queue admission waits for settlement; each caller still receives its
    // own result or rejection rather than inheriting a previous failure.
    this.analysisTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async diagnoseAnalysis(): Promise<FeedbackDiagnostic> {
    const generation = this.analysisGeneration;
    if (this.pendingDiagnostic?.generation === generation)
      return this.pendingDiagnostic.promise;
    const promise = this.queueAnalysis(
      async (): Promise<FeedbackDiagnostic> => {
        const current = () => {
          if (this.stopped || generation !== this.analysisGeneration)
            throw new Error('Feedback diagnostic was superseded.');
        };
        current();
        const analyze = this.analyzeFn;
        const result: FeedbackDiagnostic = {
          isolated: true,
          agentAvailable: analyze !== null,
          syntheticRatingCreated: false,
          analysisRan: false,
          guidelinesGenerated: false,
          guidelinesPreview: '',
        };
        if (!analyze) return result;
        const sample: FeedbackStore = {
          ratings: [
            {
              id: '_diagnostic:0',
              agentSlug: '_test',
              conversationId: '_diagnostic',
              messageIndex: 0,
              messagePreview:
                'The assistant gave a clear, concise answer with examples.',
              rating: 'thumbs_up',
              createdAt: new Date().toISOString(),
            },
          ],
          summary: null,
        };
        const analyzed = await runMiniFeedbackAnalysis(analyze, sample);
        current();
        const update = await runFullFeedbackAnalysis({
          analyze,
          data: analyzed,
          maxReinforce: this.maxReinforce,
          maxAvoid: this.maxAvoid,
        });
        current();
        const guidelines = this.formatBehaviorGuidelines(
          update?.summary ?? null,
        );
        return {
          ...result,
          syntheticRatingCreated: true,
          analysisRan: true,
          guidelinesGenerated: guidelines !== null,
          guidelinesPreview: guidelines?.text.slice(0, 300) ?? '',
        };
      },
    );
    this.pendingDiagnostic = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.pendingDiagnostic?.promise === promise)
        this.pendingDiagnostic = null;
    }
  }

  private async executeAnalysisPipeline(
    generation: number,
  ): Promise<FeedbackSummary | null> {
    if (this.stopped || generation !== this.analysisGeneration) return null;
    try {
      feedbackOps.add(1, { operation: 'analyze' });
      const analyzeStart = Date.now();
      await this.runMiniAnalysis(generation);
      if (generation !== this.analysisGeneration) return null;
      await this.runFullAnalysis(generation);
      if (generation !== this.analysisGeneration) return null;
      this.lastAnalyzedAt = Date.now();
      const summary = this.getSummary();
      feedbackOps.add(1, {
        operation: 'analyze-complete',
        reinforceCount: String(summary?.reinforce.length || 0),
        avoidCount: String(summary?.avoid.length || 0),
        durationMs: String(Date.now() - analyzeStart),
      });
      return summary;
    } catch (error) {
      if (generation !== this.analysisGeneration) return null;
      throw error;
    }
  }

  /**
   * Fold analysis results onto the CURRENT store rather than writing back the
   * snapshot the analysis was computed from (archive#2900). An analysis is an LLM
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
          !needsFeedbackAnalysis(entry) ||
          source.rating !== entry.rating ||
          source.messagePreview !== entry.messagePreview ||
          source.reason !== entry.reason
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

  private async runMiniAnalysis(generation: number): Promise<void> {
    if (!this.analyzeFn) return;

    const data = this.store.read();
    if (!data.ratings.some(needsFeedbackAnalysis)) return;

    const analyzed = await runMiniFeedbackAnalysis(this.analyzeFn, data);
    if (generation !== this.analysisGeneration) return;
    // Re-read AFTER the await. No await separates this read from the write,
    // so the fold is atomic against other in-process writers.
    this.store.write(
      this.foldAnalyzedRatings(analyzed.ratings, this.store.read()),
    );
  }

  private async runFullAnalysis(generation: number): Promise<void> {
    if (!this.analyzeFn) return;

    const data = this.store.read();
    const update = await runFullFeedbackAnalysis({
      analyze: this.analyzeFn,
      data,
      maxReinforce: this.maxReinforce,
      maxAvoid: this.maxAvoid,
    });
    if (update && generation === this.analysisGeneration) {
      // Spread the CURRENT store, not `data`: ratings submitted during the
      // analysis above must survive the summary write (archive#2900).
      this.store.write({ ...this.store.read(), ...update });
    }
  }

  clearAnalysis(): void {
    this.analysisGeneration += 1;
    this.lastAnalyzedAt = null;
    const data = this.store.read();
    this.store.write({
      ratings: data.ratings.map((rating) => ({
        ...rating,
        analysis: undefined,
        analyzedAt: undefined,
      })),
      summary: null,
      summaryBasis: undefined,
    });
  }
}
