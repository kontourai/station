import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { Notification } from '@kontourai/station-contracts/notification';
import {
  type AttentionItem,
  type OrchestrationSessionSummary,
  useDevicePresentation,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import { type ComponentType, useCallback, useMemo } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { sessionsByThreadId } from '../../utils/answerability';
import { sessionProjectLabel, sessionTitle } from '../../utils/sessionDisplay';
import {
  AgentGlyph,
  EngineGlyph,
  FolderGlyph,
  MessageGlyph,
  MonitorGlyph,
} from '../icons/Glyph';

/**
 * Where a notification comes from: which Station runs the work, which
 * Project and chat it belongs to, and which agent and engine are doing it.
 *
 * Every part is read from a contract field — the item's own fields first,
 * then the session it names in the shared sessions read — and a part nothing
 * carries is left out, never guessed. An item whose session this Station
 * cannot read renders only what the item itself says.
 */
export interface InboxContextPart {
  kind: 'station' | 'project' | 'chat' | 'agent' | 'engine';
  label: string;
  value: string;
  /** A Station part naming ANOTHER Station than the one being read. */
  remote?: boolean;
  /** The engine without its model, for the tray's one-line form. */
  brief?: string;
}

const PART_LABEL: Record<InboxContextPart['kind'], string> = {
  station: 'Station',
  project: 'Project',
  chat: 'Chat',
  agent: 'Agent',
  engine: 'Engine',
};

const PART_GLYPH: Record<
  InboxContextPart['kind'],
  ComponentType<{ className?: string }>
> = {
  station: MonitorGlyph,
  project: FolderGlyph,
  chat: MessageGlyph,
  agent: AgentGlyph,
  engine: EngineGlyph,
};

interface ContextFacts {
  /** The row's own headline, so a chat title that repeats it is dropped. */
  title: string;
  session?: OrchestrationSessionSummary;
  projectSlug?: string;
  /** A paired or SSH Station that runs the work, as the item names it. */
  environmentName?: string;
  engine?: string;
  agent?: string;
  /** This Station's own name, for work that runs here. */
  localStationName?: string;
}

export function inboxContextParts(facts: ContextFacts): InboxContextPart[] {
  const { session } = facts;
  const parts: InboxContextPart[] = [];
  const push = (
    kind: InboxContextPart['kind'],
    value?: string | null,
    remote?: boolean,
  ) => {
    const trimmed = value?.trim();
    if (trimmed)
      parts.push({
        kind,
        label: PART_LABEL[kind],
        value: trimmed,
        ...(remote ? { remote } : {}),
      });
  };
  const delegatedKind = session?.delegation?.environmentKind;
  const runsElsewhere =
    Boolean(facts.environmentName) ||
    (delegatedKind !== undefined && delegatedKind !== 'current');
  // Remote work keeps saying so even when its Station sent no display name.
  const remote = runsElsewhere
    ? (facts.environmentName ??
      session?.delegation?.environmentName ??
      'Another Station')
    : undefined;
  // Only a row that names work (a session, or a Station it runs on) has a
  // Station to report; a plain job notification is not "running" anywhere.
  push(
    'station',
    remote ?? (session ? facts.localStationName : undefined),
    Boolean(remote),
  );
  push(
    'project',
    facts.projectSlug ?? (session ? sessionProjectLabel(session) : null),
  );
  if (session) {
    const chat = sessionTitle(session);
    if (chat !== facts.title) push('chat', chat);
  }
  const engine = facts.engine ?? session?.provider;
  const agent = facts.agent ?? session?.assignedAgentSlug;
  // An agent named for its engine ("codex" on Codex) says nothing new.
  if (agent && agent.toLowerCase() !== engine?.toLowerCase())
    push('agent', agent);
  if (engine) {
    const label = engineDisplayLabel(engine) ?? engine;
    push('engine', session?.model ? `${label} · ${session.model}` : label);
    const last = parts.at(-1);
    if (last?.kind === 'engine') last.brief = label;
  }
  return parts;
}

/** The session an attention item is about, by the ids its contract carries. */
function attentionThreadId(item: AttentionItem): string | undefined {
  if ('requestReference' in item && item.requestReference)
    return item.requestReference.threadId;
  if ('inputReference' in item && item.inputReference)
    return item.inputReference.threadId;
  if ('threadId' in item.source && typeof item.source.threadId === 'string')
    return item.source.threadId;
  return item.sessionId;
}

function notificationThreadId(notification: Notification): string | undefined {
  const metadata = notification.metadata ?? {};
  for (const key of ['threadId', 'sessionId', 'conversationId'] as const) {
    const value = metadata[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function metadataString(
  notification: Notification,
  key: string,
): string | undefined {
  const value = notification.metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * One resolver for both row families, reading the SAME shared sessions query
 * the answerability annotation reads, so the inbox costs no extra fetch.
 */
export function useInboxContext() {
  const sessionsQuery = useOrchestrationSessionsQuery();
  // The SDK hook bound to the same api base the inbox reads, so this joins
  // the one in-flight system-status query rather than starting another.
  const { apiBase } = useApiBase();
  const device = useDevicePresentation(apiBase);
  const sessions = useMemo(
    () => sessionsByThreadId(sessionsQuery.data ?? []),
    [sessionsQuery.data],
  );
  const localStationName = device?.hostName;
  const forAttention = useCallback(
    (item: AttentionItem): InboxContextPart[] => {
      const threadId = attentionThreadId(item);
      return inboxContextParts({
        title: item.title,
        session: threadId ? sessions.get(threadId) : undefined,
        projectSlug: item.projectSlug,
        environmentName:
          'environmentKind' in item && item.environmentKind === 'peer'
            ? item.environmentName
            : undefined,
        engine: 'engine' in item ? item.engine : undefined,
        agent: 'agent' in item ? item.agent : undefined,
        localStationName,
      });
    },
    [localStationName, sessions],
  );
  const forNotification = useCallback(
    (notification: Notification): InboxContextPart[] => {
      const threadId = notificationThreadId(notification);
      return inboxContextParts({
        title: notification.title,
        session: threadId ? sessions.get(threadId) : undefined,
        projectSlug: metadataString(notification, 'projectSlug'),
        localStationName,
      });
    },
    [localStationName, sessions],
  );
  return { forAttention, forNotification };
}

/** The context line: one glyph-led chip per known part. */
export function InboxContextLine({
  parts: allParts,
  className = 'inbox-context',
  compact = false,
}: {
  parts: readonly InboxContextPart[];
  className?: string;
  /**
   * The tray's one-line form: what identifies the work — its Project, chat
   * and engine, and its Station only when that is another one. The page
   * shows every part.
   */
  compact?: boolean;
}) {
  const parts = compact
    ? allParts.filter(
        (part) =>
          part.kind === 'project' ||
          part.kind === 'chat' ||
          part.kind === 'engine' ||
          (part.kind === 'station' && part.remote),
      )
    : allParts;
  if (parts.length === 0) return null;
  return (
    <ul className={className} data-testid="inbox-context">
      {parts.map((part) => {
        const Glyph = PART_GLYPH[part.kind];
        return (
          <li
            key={part.kind}
            className={`inbox-context__part inbox-context__part--${part.kind}`}
            title={`${part.label}: ${part.value}`}
          >
            <Glyph className="inbox-context__glyph" />
            <span className="sr-only">{part.label}: </span>
            <span className="inbox-context__value">
              {compact ? (part.brief ?? part.value) : part.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
