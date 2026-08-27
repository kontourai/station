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

/** Consistent color for agent slug (avoids filter colors) */
export function getAgentColor(agentSlug: string): string {
  const colors = [
    '#ef4444',
    '#22c55e',
    '#a855f7',
    '#f97316',
    '#14b8a6',
    '#ec4899',
  ];
  const hash = agentSlug
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

/** Consistent color for conversation ID */
export function getConversationColor(conversationId: string): string {
  const colors = [
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#f59e0b',
    '#10b981',
    '#06b6d4',
  ];
  const hash = conversationId
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}
