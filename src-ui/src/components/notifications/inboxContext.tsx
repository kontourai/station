import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { Notification } from '@kontourai/station-contracts/notification';
import {
  type AttentionItem,
  type OrchestrationSessionSummary,
  useDevicePresentation,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import {
  type ComponentProps,
  type ComponentType,
  useCallback,
  useMemo,
} from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { sessionsByThreadId } from '../../utils/answerability';
import { notificationSessionTitle } from '../../utils/notifications';
import { sessionProjectLabel, sessionTitle } from '../../utils/sessionDisplay';
import { AgentIcon } from '../icons/AgentIcon';
import {
  AgentGlyph,
  EngineGlyph,
  FolderGlyph,
  MessageGlyph,
  MonitorGlyph,
} from '../icons/Glyph';
import { displayableProjectIcon, ProjectIcon } from '../icons/ProjectIcon';

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
  agent?: ComponentProps<typeof AgentIcon>['agent'];
  projectIcon?: string;
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
  body?: string;
  chatTitle?: string;
  session?: OrchestrationSessionSummary;
  projectSlug?: string;
  /** A paired or SSH Station that runs the work, as the item names it. */
  environmentName?: string;
  engine?: string;
  agent?: string;
  agentIdentity?: ComponentProps<typeof AgentIcon>['agent'];
  projectIdentity?: { name: string; icon?: string };
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
    facts.projectIdentity?.name ??
      facts.projectSlug ??
      (session ? sessionProjectLabel(session) : null),
  );
  const project = parts.at(-1);
  if (project?.kind === 'project')
    project.projectIcon = facts.projectIdentity?.icon;
  const chat = facts.chatTitle ?? (session ? sessionTitle(session) : undefined);
  if (chat && chat !== facts.title && !facts.body?.includes(`“${chat}”`))
    push('chat', chat);
  const engine = facts.engine ?? session?.provider;
  const agent = facts.agent ?? session?.assignedAgentSlug;
  // An agent named for its engine ("codex" on Codex) says nothing new.
  if (
    agent &&
    (facts.agentIdentity || agent.toLowerCase() !== engine?.toLowerCase())
  ) {
    push('agent', facts.agentIdentity?.name ?? agent);
    const part = parts.at(-1);
    if (part?.kind === 'agent')
      part.agent = facts.agentIdentity ?? { name: agent, slug: agent };
  }
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
  const agents = useAgents();
  const { projects } = useProjects();
  const identities = useCallback(
    (
      session: OrchestrationSessionSummary | undefined,
      agent?: string,
      slug?: string,
      id?: string,
      remote = false,
    ) => {
      if (
        remote ||
        (session?.delegation?.environmentKind &&
          session.delegation.environmentKind !== 'current')
      )
        return {};
      const agentSlug = agent ?? session?.assignedAgentSlug;
      const projectSlug =
        slug ?? session?.delegation?.projectSlug ?? session?.projectSlug;
      const project = projectSlug
        ? projects.find((candidate) => candidate.slug === projectSlug)
        : projects.find((candidate) => candidate.id === id);
      return {
        agentIdentity: agents.find((candidate) => candidate.slug === agentSlug),
        projectIdentity: project && {
          name: project.name,
          icon: displayableProjectIcon(
            project.icon ??
              (project.iconDisabled ? undefined : project.derivedIcon),
          ),
        },
      };
    },
    [agents, projects],
  );
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
      const session = threadId ? sessions.get(threadId) : undefined;
      const agent = 'agent' in item ? item.agent : undefined;
      const remote =
        'environmentKind' in item && item.environmentKind === 'peer';
      return inboxContextParts({
        title: item.title,
        session,
        projectSlug: item.projectSlug,
        ...identities(session, agent, item.projectSlug, undefined, remote),
        environmentName: remote
          ? (item.environmentName ?? 'Another Station')
          : undefined,
        engine: 'engine' in item ? item.engine : undefined,
        agent,
        localStationName,
      });
    },
    [identities, localStationName, sessions],
  );
  const forNotification = useCallback(
    (notification: Notification): InboxContextPart[] => {
      const envelope = readNotificationEnvelope(notification);
      const source = envelope?.source;
      const target = envelope?.target;
      const threadId =
        notificationThreadId(notification) ??
        (target?.kind === 'session' ? target.sessionId : undefined) ??
        (source?.kind === 'agent' ? source.sessionId : undefined);
      const session = threadId ? sessions.get(threadId) : undefined;
      const agent = source?.kind === 'agent' ? source.agent : undefined;
      const projectId =
        source?.kind === 'agent' || source?.kind === 'system'
          ? source.projectId
          : undefined;
      const projectSlug = metadataString(notification, 'projectSlug');
      const title = notificationSessionTitle(notification);
      return inboxContextParts({
        title: title ?? notification.title,
        body: title ? undefined : notification.body,
        agent,
        ...identities(session, agent, projectSlug, projectId),
        chatTitle: metadataString(notification, 'chatTitle'),
        session,
        projectSlug,
        localStationName,
      });
    },
    [identities, localStationName, sessions],
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
   * The tray shows the work’s identity and names a Station when it runs remotely. The page
   * shows every part.
   */
  compact?: boolean;
}) {
  const parts = compact
    ? allParts.filter(
        (part) =>
          part.kind === 'project' ||
          part.kind === 'chat' ||
          part.kind === 'agent' ||
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
            {part.agent ? (
              <AgentIcon
                agent={part.agent}
                size={14}
                className="inbox-context__glyph"
                fallbackGlyph
              />
            ) : part.projectIcon ? (
              <ProjectIcon
                project={{ name: part.value, icon: part.projectIcon }}
                size={14}
                className="inbox-context__glyph"
              />
            ) : (
              <Glyph className="inbox-context__glyph" />
            )}
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
