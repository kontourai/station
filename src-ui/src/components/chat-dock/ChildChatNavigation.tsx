import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import {
  applyReturnFocus,
  captureReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';
import { Button } from '../Button';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';
import { registerDialogHistory } from '../dialog-history';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';
import {
  ChildChatContext,
  type ChildChatController,
  ChildChatCoveredContext,
  ChildChatPresentationContext,
  type ChildChatTarget,
} from './ChildChatNavigationContext';
import './ChildChatNavigation.css';

const loadEngineTranscript = () =>
  import('../../workspace-panes/agents/ChildWorkTranscript').then((module) => ({
    default: module.ChildWorkTranscript,
  }));
const loadSessionTranscript = () =>
  import('../conversation/ConversationReader').then((module) => ({
    default: module.SessionConversationReader,
  }));

/** A stack belongs to one mounted chat pane. Ancestor readers remain mounted. */
export function ChildChatNavigation({
  rootKey,
  title,
  children,
  initialChild,
  controllerRef,
  onCoveredChange,
  onBeforeChildOpen,
  onInitialChildConsumed,
  dockOutlet = false,
}: {
  dockOutlet?: boolean;
  rootKey: string;
  title: string;
  children: ReactNode;
  initialChild?: ChildChatTarget;
  onCoveredChange?: (covered: boolean) => void;
  onBeforeChildOpen?: () => void;
  onInitialChildConsumed?: () => void;
  controllerRef?: RefObject<ChildChatController | null>;
}) {
  const [state, setState] = useState<{
    root: string;
    entries: ChildChatTarget[];
  }>({ root: rootKey, entries: initialChild ? [initialChild] : [] });
  const entries = state.root === rootKey ? state.entries : [];
  const covered = entries.length > 0;
  useLayoutEffect(() => {
    onCoveredChange?.(covered);
  }, [onCoveredChange, covered]);
  const root = useRef(rootKey);
  root.current = rootKey;
  const initial = useRef<ChildChatTarget | undefined>(undefined);
  const consumeInitial = useRef(onInitialChildConsumed);
  consumeInitial.current = onInitialChildConsumed;
  useLayoutEffect(() => {
    if (!initialChild) {
      initial.current = undefined;
      return;
    }
    if (initial.current === initialChild) return;
    initial.current = initialChild;
    setState({ root: rootKey, entries: [initialChild] });
    consumeInitial.current?.();
  }, [initialChild, rootKey]);
  const pop = (index: number) => {
    const focus = captureReturnFocus(entries[index]?.returnFocus ?? null);
    setState({ root: rootKey, entries: entries.slice(0, index) });
    requestAnimationFrame(() => applyReturnFocus(focus));
  };
  const push = (target: ChildChatTarget) => {
    onBeforeChildOpen?.();
    setState((current) => ({
      root: root.current,
      entries: [
        ...(current.root === root.current ? current.entries : []),
        {
          ...target,
          returnFocus:
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : undefined,
        },
      ],
    }));
  };
  useLayoutEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      open: push,
      reset: () => {
        initial.current = initialChild;
        setState({ root: root.current, entries: [] });
        if (initialChild) consumeInitial.current?.();
      },
    };
    return () => {
      controllerRef.current = null;
    };
  });
  const popRef = useRef(pop);
  popRef.current = pop;
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = shell.current;
    if (!entries.length || !element) return;
    element.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      popRef.current(entries.length - 1);
    };
    element.addEventListener('keydown', onEscape);
    return () => element.removeEventListener('keydown', onEscape);
  }, [entries.length]);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const trail = covered ? (
    <nav
      data-no-dock-drag=""
      className="child-chat-trail"
      aria-label="Chat breadcrumb"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          pop(entries.length - 1);
        }
      }}
    >
      <Button
        variant="ghost"
        onClick={() => pop(entries.length - 1)}
        aria-label="Back to parent chat"
      >
        ‹
      </Button>
      {[{ title }, ...entries].map((entry, index) => (
        <span className="child-chat-trail__segment" key={index}>
          {index > 0 && <span aria-hidden="true"> › </span>}
          {index < entries.length ? (
            <Button variant="ghost" onClick={() => pop(index)}>
              <span className="child-chat-trail__label">{entry.title}</span>
            </Button>
          ) : (
            <span aria-current="page">{entry.title}</span>
          )}
        </span>
      ))}
    </nav>
  ) : null;
  const pane =
    entries.length > 0 ? (
      <div
        className="child-chat-pane"
        ref={shell}
        tabIndex={-1}
        onTouchStart={(event) => {
          const point = event.touches[0];
          touch.current =
            point && point.clientX < 44
              ? { x: point.clientX, y: point.clientY }
              : null;
        }}
        onTouchEnd={(event) => {
          const point = event.changedTouches[0];
          const start = touch.current;
          touch.current = null;
          if (
            point &&
            start &&
            point.clientX - start.x > 80 &&
            Math.abs(point.clientY - start.y) < 60
          )
            pop(entries.length - 1);
        }}
      >
        {entries.map((entry, index) => (
          <div
            className="child-chat-pane__reader"
            hidden={index !== entries.length - 1}
            inert={index !== entries.length - 1}
            key={`${index}:${entry.threadId}:${entry.childId ?? ''}`}
          >
            <ChildHistoryLayer close={() => popRef.current(index)} />
            <ConversationConnectionProvider
              value={{ ...entry.connection, record: { readOnly: true } }}
            >
              <LiveChildReader entry={entry} index={index} />
            </ConversationConnectionProvider>
          </div>
        ))}
      </div>
    ) : null;
  return (
    <ChildChatContext.Provider value={push}>
      <ChildChatCoveredContext.Provider value={covered}>
        <ChildChatPresentationContext.Provider value={{ trail, pane }}>
          <div
            className="child-chat-root"
            hidden={!dockOutlet && covered}
            inert={!dockOutlet && covered}
          >
            {children}
          </div>
          {!dockOutlet && (
            <>
              {trail}
              {pane}
            </>
          )}
        </ChildChatPresentationContext.Provider>
      </ChildChatCoveredContext.Provider>
    </ChildChatContext.Provider>
  );
}

function ChildHistoryLayer({ close }: { close: () => void }) {
  const id = useId();
  const latest = useRef(close);
  latest.current = close;
  useEffect(
    () => registerDialogHistory(`child-chat-${id}`, () => latest.current()),
    [id],
  );
  return null;
}

function LiveChildReader({
  entry,
  index,
}: {
  entry: ChildChatTarget;
  index: number;
}) {
  const read = useCallback(
    () => childWorkGlobalStore.getPartition(entry.connection.apiBase),
    [entry.connection.apiBase],
  );
  const global = useSyncExternalStore(
    childWorkGlobalStore.subscribe,
    read,
    read,
  );
  const observed = Object.values(global.registry.items).find(
    (item) =>
      item.reporterThreadId === entry.threadId &&
      item.childId === entry.childId,
  );
  const [observe, setObserve] = useState(true);
  const sessions = useOrchestrationSessionsQuery(
    {
      readTarget: entry.connection.station,
      enabled: observe,
      // An external child intent may be newer than the cached parent inventory.
      refetchOnMount: 'always',
      retry: false,
    },
    entry.connection.requestScope,
  );
  const parent = sessions.data?.find(
    (session) => session.threadId === entry.threadId,
  );
  const reported = parent?.childWork?.children;
  const reportedItem =
    reported?.observability === 'reported'
      ? [...reported.running, ...(reported.settled ?? [])].find(
          (item) => item.childId === entry.childId,
        )
      : undefined;
  const item =
    observed?.status !== 'running' && observed
      ? observed
      : reportedItem?.status !== 'running' && reportedItem
        ? reportedItem
        : (observed ?? reportedItem);
  const running = entry.childId
    ? item?.status === 'running'
    : parent?.childWork?.asChild?.status === 'running';
  useEffect(() => {
    if (sessions.isSuccess || observed) setObserve(running);
  }, [running, sessions.isSuccess, observed]);
  const revision = JSON.stringify(item ?? parent?.childWork?.asChild ?? null);
  return entry.childId ? (
    <LazyBoundary
      load={loadEngineTranscript}
      componentProps={{
        id: `child-chat-${index}`,
        threadId: entry.threadId,
        childId: entry.childId,
        title: item?.title ?? entry.title,
        engineId: entry.engineId ?? parent?.provider,
        running,
        revision,
      }}
      pending={<SkeletonBlock count={2} label="Reading subagent" />}
    />
  ) : (
    <LazyBoundary
      load={loadSessionTranscript}
      componentProps={{
        session: { threadId: entry.threadId },
        agentLabel: entry.title,
        isStreaming: running,
      }}
      pending={<SkeletonBlock count={2} label="Reading delegate" />}
    />
  );
}
