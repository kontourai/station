import type {
  ChatMessage,
  ChatUIState,
  StreamingMessage,
} from '../contexts/active-chats-state';

type PlanArtifactStepStatus = 'pending' | 'in_progress' | 'completed';

interface PlanArtifactStep {
  content: string;
  status: PlanArtifactStepStatus;
}

export interface PlanArtifact {
  source: 'assistant' | 'reasoning' | 'canonical';
  rawText: string;
  steps: PlanArtifactStep[];
  updatedAt: string;
}

const LINE_STATUS_PATTERNS: Array<{
  match: RegExp;
  resolveStatus: (captures: RegExpMatchArray) => PlanArtifactStepStatus | null;
}> = [
  {
    match: /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/,
    resolveStatus: (captures) =>
      captures[1]?.toLowerCase() === 'x' ? 'completed' : 'pending',
  },
  {
    match: /^\s*(\u{2705}|\u{2611}\u{fe0f}|\u{2714}\u{fe0f})\s+(.+)$/u,
    resolveStatus: () => 'completed',
  },
  {
    match: /^\s*(\u{1f504}|\u{23f3})\s+(.+)$/u,
    resolveStatus: () => 'in_progress',
  },
  {
    match: /^\s*(\u{2b1c}|\u{25a1})\s+(.+)$/u,
    resolveStatus: () => 'pending',
  },
  {
    match: /^\s*\d+[.)]\s+(.+)$/,
    resolveStatus: () => 'pending',
  },
  {
    match: /^\s*[-*]\s+(.+)$/,
    resolveStatus: () => 'pending',
  },
];

/**
 * Every character any `LINE_STATUS_PATTERNS` entry can begin a step with.
 *
 * A streamed answer is re-derived at line boundaries with the accumulated
 * text, and the parse below splits it into lines and runs six regexes over
 * each one. Prose that contains none of these characters cannot produce a
 * single step, so the scan is skipped rather than performed and discarded.
 *
 * This must stay a SUPERSET of what the patterns match: a family dropped from
 * here is a plan that silently stops rendering, which is why the tests walk
 * every pattern rather than a sample.
 */
const PLAN_MARKER_CHARACTERS =
  /[-*\d\u2705\u2611\u2714\u23f3\u2b1c\u25a1]|\u{1f504}/u;

function hasPlanMarker(text: string): boolean {
  return PLAN_MARKER_CHARACTERS.test(text);
}

function normalizePlanLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parsePlanSteps(text: string): PlanArtifactStep[] {
  const steps: PlanArtifactStep[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    for (const pattern of LINE_STATUS_PATTERNS) {
      const match = line.match(pattern.match);
      if (!match) continue;
      const content = normalizePlanLine(match[match.length - 1] || '');
      if (!content) break;
      const status = pattern.resolveStatus(match);
      if (!status) break;
      steps.push({ content, status });
      break;
    }
  }

  return steps;
}

function looksLikePlan(text: string, steps: PlanArtifactStep[]): boolean {
  if (steps.length >= 2) {
    return true;
  }

  if (steps.length === 1) {
    return /\b(plan|steps?|todo|next)\b/i.test(text);
  }

  return false;
}

export function derivePlanArtifactFromText(
  text: string | null | undefined,
  source: PlanArtifact['source'],
  updatedAt: string = new Date().toISOString(),
): PlanArtifact | null {
  const rawText = text?.trim();
  if (!rawText) {
    return null;
  }
  // No character any step pattern can start with — `parsePlanSteps` would
  // walk every line and find nothing.
  if (!hasPlanMarker(rawText)) {
    return null;
  }

  const steps = parsePlanSteps(rawText);
  if (!looksLikePlan(rawText, steps)) {
    return null;
  }

  return {
    source,
    rawText,
    steps,
    updatedAt,
  };
}

function derivePlanArtifactFromMessage(
  message: Pick<ChatMessage, 'role' | 'content' | 'contentParts'>,
): PlanArtifact | null {
  if (message.role !== 'assistant') {
    return null;
  }

  const reasoningText = message.contentParts
    ?.filter((part) => part.type === 'reasoning' && part.content)
    .map((part) => part.content)
    .join('\n')
    .trim();
  const fromReasoning = derivePlanArtifactFromText(reasoningText, 'reasoning');
  if (fromReasoning) {
    return fromReasoning;
  }

  const assistantText = message.contentParts
    ?.filter((part) => part.type === 'text' && part.content)
    .map((part) => part.content)
    .join('\n')
    .trim();

  return derivePlanArtifactFromText(
    assistantText || message.content,
    'assistant',
  );
}

export function deriveLatestPlanArtifactFromMessages(
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'contentParts'>>,
): PlanArtifact | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const artifact = derivePlanArtifactFromMessage(messages[index]!);
    if (artifact) {
      return artifact;
    }
  }

  return null;
}

export function derivePlanArtifactFromStreamingState(
  chat: Pick<ChatUIState, 'streamingMessage' | 'planArtifact'>,
  updatedAt?: string,
): PlanArtifact | null {
  const reasoningText = chat.streamingMessage?.contentParts
    ?.filter((part) => part.type === 'reasoning' && part.content)
    .map((part) => part.content)
    .join('\n');
  const fromReasoning = derivePlanArtifactFromText(
    reasoningText,
    'reasoning',
    updatedAt,
  );
  const text = fromReasoning
    ? undefined
    : chat.streamingMessage?.contentParts
        ?.filter((part) => part.type === 'text' && part.content)
        .map((part) => part.content)
        .join('\n');
  const next =
    fromReasoning ?? derivePlanArtifactFromText(text, 'assistant', updatedAt);
  const previous = chat.planArtifact;
  // rawText is rendered and downloadable; equal steps alone cannot make two
  // artifacts interchangeable (headings and explanatory prose may differ).
  if (
    next &&
    previous?.source === next.source &&
    previous.rawText === next.rawText
  )
    return previous;
  return next ?? previous ?? null;
}

interface StreamingPlanText {
  raw: string;
  pending: string;
  steps: PlanArtifactStep[];
  hasKeyword: boolean;
}
const streamingPlans = new WeakMap<
  StreamingMessage,
  { text: StreamingPlanText; reasoning: StreamingPlanText }
>();
const PLAN_KEYWORD = /\b(plan|steps?|todo|next)\b/i;

function appendPlanText(scan: StreamingPlanText, delta: string): void {
  scan.raw += delta;
  scan.pending += delta;
  if (!delta.includes('\n')) return;
  const lines = scan.pending.split('\n');
  scan.pending = lines.pop()!;
  for (const line of lines) {
    scan.steps.push(...parsePlanSteps(line));
    scan.hasKeyword ||= PLAN_KEYWORD.test(line);
  }
}

function createPlanScan(
  message: StreamingMessage | undefined,
  type: 'text' | 'reasoning',
): StreamingPlanText {
  const scan: StreamingPlanText = {
    raw: '',
    pending: '',
    steps: [],
    hasKeyword: false,
  };
  appendPlanText(
    scan,
    message?.contentParts
      ?.filter((part) => part.type === type && part.content)
      .map((part) => part.content)
      .join('\n') ?? '',
  );
  return scan;
}

/** Consume each completed line once; the final unterminated line remains live.
 * Weak keys tie parser lifetime to the streaming shell, never to chat history.
 */
export function derivePlanArtifactFromStreamingDelta(
  chat: Pick<ChatUIState, 'streamingMessage' | 'planArtifact'>,
  next: StreamingMessage,
  type: 'text' | 'reasoning',
  delta: string,
  updatedAt: string,
): PlanArtifact | null | undefined {
  const previous = chat.streamingMessage;
  const scans = (previous && streamingPlans.get(previous)) ?? {
    text: createPlanScan(previous, 'text'),
    reasoning: createPlanScan(previous, 'reasoning'),
  };
  if (previous) streamingPlans.delete(previous);
  const scan = scans[type];
  const tail = previous?.contentParts?.at(-1);
  const separator =
    scan.raw && (tail?.type !== type || !tail.content) ? '\n' : '';
  if (delta) appendPlanText(scan, separator + delta);
  streamingPlans.set(next, scans);
  if (!delta.includes('\n')) return chat.planArtifact;

  const artifact = (
    value: StreamingPlanText,
    source: PlanArtifact['source'],
  ): PlanArtifact | null => {
    const steps = [...value.steps, ...parsePlanSteps(value.pending)];
    if (
      steps.length < 2 &&
      !(
        steps.length === 1 &&
        (value.hasKeyword || PLAN_KEYWORD.test(value.pending))
      )
    )
      return null;
    return { source, rawText: value.raw.trim(), steps, updatedAt };
  };
  const result =
    artifact(scans.reasoning, 'reasoning') ?? artifact(scans.text, 'assistant');
  if (
    result &&
    result.source === chat.planArtifact?.source &&
    result.rawText === chat.planArtifact.rawText
  )
    return chat.planArtifact;
  return result ?? chat.planArtifact ?? null;
}
