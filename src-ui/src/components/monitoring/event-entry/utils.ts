import { K } from '../../../../../src-shared/monitoring-keys';
import type { MonitoringEvent } from '../../../contexts/MonitoringContext';

export function buildEventTimestampTitle(event: MonitoringEvent): string {
  if (!event.timestamp) {
    return 'No timestamp';
  }
  return new Date(event.timestamp).toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
  });
}

export function buildToolInputDisplay(event: Partial<MonitoringEvent>): {
  text: string;
  label: string;
} | null {
  const args = event[K.TOOL_CALL_ARGS];
  if (!args) return null;

  const hasContent =
    typeof args === 'string'
      ? args.length > 0
      : Object.keys(args as Record<string, unknown>).length > 0;
  if (!hasContent) return null;

  return {
    text: typeof args === 'string' ? args : JSON.stringify(args, null, 2),
    label:
      typeof args === 'string'
        ? `${args.length} chars`
        : `${Object.keys(args as Record<string, unknown>).length} params`,
  };
}

export function getArtifactSummary(event: Partial<MonitoringEvent>): {
  finalOutput: string | null;
  toolCalls: Array<{ type: string; name?: string; content?: unknown }>;
} | null {
  const artifacts = event[K.ARTIFACTS] as
    | Array<{ type: string; name?: string; content?: unknown }>
    | undefined;
  if (!artifacts) return null;

  const textArtifacts = artifacts.filter(
    (artifact) => artifact.type === 'text',
  );
  const finalOutput =
    textArtifacts.length > 0
      ? String(textArtifacts[textArtifacts.length - 1].content ?? '')
      : null;

  return {
    finalOutput,
    toolCalls: artifacts.filter((artifact) => artifact.type === 'tool-call'),
  };
}

export function getTotalChars(event: Partial<MonitoringEvent>): number | null {
  if (
    event[K.INPUT_CHARS] === undefined ||
    event[K.OUTPUT_CHARS] === undefined
  ) {
    return null;
  }

  return (event[K.INPUT_CHARS] as number) + (event[K.OUTPUT_CHARS] as number);
}

export function getTotalTokens(event: Partial<MonitoringEvent>): number | null {
  if (
    event[K.INPUT_TOKENS] === undefined ||
    event[K.OUTPUT_TOKENS] === undefined
  ) {
    return null;
  }

  return (
    ((event[K.INPUT_TOKENS] as number) || 0) +
    ((event[K.OUTPUT_TOKENS] as number) || 0)
  );
}
