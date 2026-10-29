import { K, OP, SPAN } from '@shared/monitoring-keys';
import type { MonitoringEvent } from '../contexts/MonitoringContext';

/** Relative time presets — single source of truth for the 4x duplicated ms calc */
export const RELATIVE_TIME_OPTIONS = [
  { value: '5m' as const, label: 'Last 5 minutes', ms: 5 * 60 * 1000 },
  { value: '15m' as const, label: 'Last 15 minutes', ms: 15 * 60 * 1000 },
  { value: '1h' as const, label: 'Last 1 hour', ms: 60 * 60 * 1000 },
  { value: '6h' as const, label: 'Last 6 hours', ms: 6 * 60 * 60 * 1000 },
  { value: '24h' as const, label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d' as const, label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  {
    value: '30d' as const,
    label: 'Last 30 days',
    ms: 30 * 24 * 60 * 60 * 1000,
  },
] as const;

export type RelativeTimeValue = (typeof RELATIVE_TIME_OPTIONS)[number]['value'];

/** Derive a display-friendly event type from OTel attributes */
export function getEventType(event: MonitoringEvent): string {
  const op = event[K.OP_NAME];
  const kind = event[K.SPAN_KIND];
  if (op === OP.INVOKE_AGENT && kind === SPAN.START) return 'agent-start';
  if (op === OP.INVOKE_AGENT && kind === SPAN.END) return 'agent-complete';
  if (op === OP.EXECUTE_TOOL && kind === SPAN.START) return 'tool-call';
  if (op === OP.EXECUTE_TOOL && kind === SPAN.END) return 'tool-result';
  if (op === OP.INVOKE_AGENT && kind === SPAN.LOG) return 'agent-health';
  if (event[K.REASONING_TEXT]) return 'reasoning';
  if (event[K.AT_EVENT_ID]) return 'agent-telemetry';
  return `${op}-${kind}`;
}

/** Event type filter groups */
export const EVENT_TYPE_GROUPS = {
  Agent: ['agent-start', 'agent-complete'],
  Tool: ['tool-call', 'tool-result'],
  Reasoning: ['reasoning'],
  Planning: ['planning'],
  Health: ['agent-health'],
} as const;

/**
 * The categorical series palette (`--series-1..6`, measured per theme in
 * index.css), so agent and conversation accents follow light/dark and
 * palette themes. These are only ever painted through CSS (`style`,
 * `color-mix()`), where a var() reference resolves; they were literal dark
 * hexes, which no theme could reach.
 */
const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
] as const;

function seriesColorFor(key: string): string {
  const hash = key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return SERIES_COLORS[hash % SERIES_COLORS.length];
}

/** Consistent series color for an agent slug. */
export function getAgentColor(agentSlug: string): string {
  return seriesColorFor(agentSlug);
}

/** Consistent series color for a conversation ID. */
export function getConversationColor(conversationId: string): string {
  return seriesColorFor(conversationId);
}
