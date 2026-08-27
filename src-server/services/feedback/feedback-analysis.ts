import type {
  AnalyzeCallback,
  FeedbackStore,
  FeedbackSummary,
  MessageRating,
} from './feedback-service.js';

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
  const pending = data.ratings.filter((rating) => !rating.analyzedAt);
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
  const analyses = JSON.parse(extractJson(raw) || '[]') as Array<{
    index: number;
    analysis: string;
  }>;

  const analyzedAt = new Date().toISOString();
  const nextRatings = [...data.ratings];
  for (const analysis of analyses) {
    const rating = pending[analysis.index - 1];
    if (!rating || !analysis.analysis) continue;
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
}): Promise<FeedbackSummary | null> {
  const analyzed = params.data.ratings.filter(
    (rating): rating is MessageRating & { analysis: string } =>
      typeof rating.analysis === 'string' && rating.analysis.length > 0,
  );
  if (analyzed.length === 0) return null;

  if (
    params.data.summary &&
    params.data.summary.analyzedCount === analyzed.length
  ) {
    return params.data.summary;
  }

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

  const raw = await params.analyze(prompt);
  const result = JSON.parse(extractJson(raw) || '{}') as {
    reinforce?: string[];
    avoid?: string[];
  };

  return {
    reinforce: (result.reinforce || []).slice(0, params.maxReinforce),
    avoid: (result.avoid || []).slice(0, params.maxAvoid),
    analyzedCount: analyzed.length,
    updatedAt: new Date().toISOString(),
  };
}
