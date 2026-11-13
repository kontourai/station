import {
  applyReturnFocus,
  captureReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../Button';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';
import {
  ChildChatContext,
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
}: {
  rootKey: string;
  title: string;
  children: ReactNode;
  initialChild?: ChildChatTarget;
  controllerRef?: RefObject<((target: ChildChatTarget) => void) | null>;
}) {
  const [state, setState] = useState<{
    root: string;
    entries: ChildChatTarget[];
  }>({ root: rootKey, entries: initialChild ? [initialChild] : [] });
  const entries = state.root === rootKey ? state.entries : [];
  const root = useRef(rootKey);
  root.current = rootKey;
  const initial = useRef(initialChild);
  useEffect(() => {
    if (initial.current === initialChild) return;
    initial.current = initialChild;
    setState({ root: rootKey, entries: initialChild ? [initialChild] : [] });
  }, [initialChild, rootKey]);
  const pop = (index: number) => {
    const focus = captureReturnFocus(entries[index]?.returnFocus ?? null);
    setState({ root: rootKey, entries: entries.slice(0, index) });
    requestAnimationFrame(() => applyReturnFocus(focus));
  };
  const push = (target: ChildChatTarget) =>
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
  useLayoutEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = push;
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
  return (
    <ChildChatContext.Provider value={push}>
      <div
        className="child-chat-root"
        hidden={entries.length > 0}
        inert={entries.length > 0}
      >
        {children}
      </div>
      {entries.length > 0 && (
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
          <nav className="child-chat-trail" aria-label="Chat breadcrumb">
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
                    {entry.title}
                  </Button>
                ) : (
                  <span aria-current="page">{entry.title}</span>
                )}
              </span>
            ))}
          </nav>
          {entries.map((entry, index) => (
            <div
              className="child-chat-pane__reader"
              hidden={index !== entries.length - 1}
              inert={index !== entries.length - 1}
              key={`${index}:${entry.threadId}:${entry.childId ?? ''}`}
            >
              <ConversationConnectionProvider
                value={{ ...entry.connection, record: { readOnly: true } }}
              >
                {entry.childId ? (
                  <LazyBoundary
                    load={loadEngineTranscript}
                    componentProps={{
                      id: `child-chat-${index}`,
                      threadId: entry.threadId,
                      childId: entry.childId,
                      running: entry.running ?? false,
                      revision: entry.revision ?? '',
                    }}
                    pending={
                      <SkeletonBlock count={2} label="Reading subagent" />
                    }
                  />
                ) : (
                  <LazyBoundary
                    load={loadSessionTranscript}
                    componentProps={{
                      session: { threadId: entry.threadId },
                      agentLabel: entry.title,
                      isStreaming: entry.running ?? true,
                    }}
                    pending={
                      <SkeletonBlock count={2} label="Reading delegate" />
                    }
                  />
                )}
              </ConversationConnectionProvider>
            </div>
          ))}
        </div>
      )}
    </ChildChatContext.Provider>
  );
}
