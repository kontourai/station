import type { ChatMessage, ChatUIState } from '../contexts/active-chats-state';

export type PlanArtifactStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanArtifactStep {
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
  if (fromReasoning) {
    return fromReasoning;
  }

  const text = chat.streamingMessage?.contentParts
    ?.filter((part) => part.type === 'text' && part.content)
    .map((part) => part.content)
    .join('\n');
  return (
    derivePlanArtifactFromText(text, 'assistant', updatedAt) ??
    chat.planArtifact ??
    null
  );
}
