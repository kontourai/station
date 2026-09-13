import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AnalyzeCallback,
  FeedbackStore,
  FeedbackSummary,
  MessageRating,
} from './feedback-service.js';

const analysisText = z.string().trim().min(1);
const miniResponse = z.array(
  z.object({
    index: z.number().int().positive(),
    analysis: analysisText,
  }),
);
const summaryResponse = z.object({
  reinforce: z.array(analysisText),
  avoid: z.array(analysisText),
});
const storedSummary = summaryResponse.extend({
  analyzedCount: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
});

export function parseFeedbackSummary(value: unknown): FeedbackSummary | null {
  const parsed = storedSummary.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function hasFeedbackAnalysis(
  rating: MessageRating,
): rating is MessageRating & { analysis: string } {
  return (
    typeof rating.analysis === 'string' && rating.analysis.trim().length > 0
  );
}

export function needsFeedbackAnalysis(rating: MessageRating): boolean {
  return (
    !hasFeedbackAnalysis(rating) ||
    typeof rating.analyzedAt !== 'string' ||
    !rating.analyzedAt
  );
}

function parseAnalysisResponse<T>(text: string, schema: z.ZodType<T>): T {
  const payload = extractJson(text);
  if (!payload) throw new Error('Feedback analysis did not return JSON.');
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('Feedback analysis returned invalid JSON.');
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error('Feedback analysis returned an invalid result shape.');
  return result.data;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;');
}

export function extractJson(text: string): string | null {
  const start =
    text.indexOf('{') === -1
      ? text.indexOf('[')
      : text.indexOf('[') === -1
        ? text.indexOf('{')
        : Math.min(text.indexOf('{'), text.indexOf('['));
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export async function runMiniFeedbackAnalysis(
  analyze: AnalyzeCallback,
  data: FeedbackStore,
): Promise<FeedbackStore> {
  const pending = data.ratings.filter(needsFeedbackAnalysis);
  if (pending.length === 0) return data;

  const ratingsXml = pending
    .map((rating, index) => {
      const reasonAttr = rating.reason
        ? ` reason="${escapeAttr(rating.reason)}"`
        : '';
      return `  <rating index="${index + 1}" type="${rating.rating}"${reasonAttr}>\n    ${escapeXml(rating.messagePreview)}\n  </rating>`;
    })
    .join('\n');

  const prompt = `You are analyzing agent responses that users have rated with thumbs up or thumbs down.

<ratings count="${pending.length}">
${ratingsXml}
</ratings>

For each rated response, provide a 1-2 sentence summary explaining WHY the user likely rated it that way. Focus on actionable behaviors.

Respond with ONLY a JSON array: [{"index": 1, "analysis": "..."}, ...]`;

  const raw = await analyze(prompt);
  const analyses = parseAnalysisResponse(raw, miniResponse);
  if (!analyses.length)
    throw new Error('Feedback analysis produced no rating analyses.');
  const seen = new Set<number>();

  const analyzedAt = new Date().toISOString();
  const nextRatings = [...data.ratings];
  for (const analysis of analyses) {
    const rating = pending[analysis.index - 1];
    if (!rating || seen.has(analysis.index))
      throw new Error(
        'Feedback analysis returned an invalid or repeated rating index.',
      );
    seen.add(analysis.index);
    const index = nextRatings.findIndex((entry) => entry.id === rating.id);
    if (index >= 0) {
      nextRatings[index] = {
        ...nextRatings[index],
        analysis: analysis.analysis,
        analyzedAt,
      };
    }
  }

  return { ...data, ratings: nextRatings };
}

export async function runFullFeedbackAnalysis(params: {
  analyze: AnalyzeCallback;
  data: FeedbackStore;
  maxReinforce: number;
  maxAvoid: number;
}): Promise<{ summary: FeedbackSummary | null; summaryBasis?: string } | null> {
  const analyzed = params.data.ratings.filter(hasFeedbackAnalysis);
  if (analyzed.length === 0)
    return params.data.summary
      ? { summary: null, summaryBasis: undefined }
      : null;

  const liked = analyzed
    .filter((rating) => rating.rating === 'thumbs_up')
    .map((rating) => rating.analysis);
  const disliked = analyzed
    .filter((rating) => rating.rating === 'thumbs_down')
    .map((rating) => rating.analysis);

  const prompt = `You are aggregating user feedback to identify patterns.

<feedback>
<liked count="${liked.length}">
${liked.map((analysis, index) => `  <analysis index="${index + 1}">${escapeXml(analysis)}</analysis>`).join('\n')}
</liked>
<disliked count="${disliked.length}">
${disliked.map((analysis, index) => `  <analysis index="${index + 1}">${escapeXml(analysis)}</analysis>`).join('\n')}
</disliked>
</feedback>

Identify the TOP ${params.maxReinforce} behaviors users LIKED and TOP ${params.maxAvoid} behaviors users DISLIKED.
Each behavior should be a concise, actionable phrase. Rank by frequency.

Respond with ONLY JSON: {"reinforce": ["behavior 1", ...], "avoid": ["behavior 1", ...]}`;

  const summaryBasis = createHash('sha256').update(prompt).digest('hex');
  if (
    params.data.summaryBasis === summaryBasis &&
    parseFeedbackSummary(params.data.summary)?.analyzedCount === analyzed.length
  )
    return null;
  const raw = await params.analyze(prompt);
  const result = parseAnalysisResponse(raw, summaryResponse);

  return {
    summary: {
      reinforce: result.reinforce.slice(0, params.maxReinforce),
      avoid: result.avoid.slice(0, params.maxAvoid),
      analyzedCount: analyzed.length,
      updatedAt: new Date().toISOString(),
    },
    summaryBasis,
  };
}
