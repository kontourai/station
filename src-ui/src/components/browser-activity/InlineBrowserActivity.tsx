import { authenticatedFetch } from '@kontourai/station-sdk';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useOpenBrowserSessionInRegion } from '../../contexts/useOpenInRegion';
import { BrowserSessionSurface } from '../../float-over-chat/BrowserSessionSurface';
import { browserShownSourceKey } from '../../float-over-chat/floatSource';
import {
  closeFloat,
  getFloatingSource,
  openFloat,
  useFloatStoreVersion,
} from '../../float-over-chat/floatStore';
import { useInlineSourceVisibility } from '../../float-over-chat/shownSources';
import { useBrowserSessionReads } from '../../float-over-chat/useBrowserSessionReads';
import type { LiveSurfaceControlState } from '../../live-surface/LiveSurfaceCanvas';
import { Button } from '../Button';
import type { BrowserActivityScope } from '../chat/BrowserActivityContext';
import { ErrorState, SkeletonBlock } from '../state';
import './InlineBrowserActivity.css';

export function InlineBrowserActivity({
  scope,
  browserSessionId,
  active,
  toolCount,
  status,
  children,
}: {
  scope: BrowserActivityScope;
  browserSessionId: string | null;
  active: boolean;
  toolCount: number;
  status: string;
  children?: ReactNode;
}) {
  const [showCurrent, setShowCurrent] = useState(false);
  useFloatStoreVersion();
  const currentFloat = getFloatingSource(scope.conversationKey);
  const floating =
    currentFloat?.kind === 'browser' &&
    currentFloat.browserSessionId === browserSessionId;
  const ref = useRef<HTMLDivElement>(null);
  const openBrowser = useOpenBrowserSessionInRegion();
  const hostScope = useHostRequestAuthorityScope();
  const transport = useCallback<typeof authenticatedFetch>(
    (input, init) =>
      authenticatedFetch(input, { ...init, requestScope: scope.requestScope }),
    [scope.requestScope],
  );
  const enabled =
    (active || showCurrent) &&
    !!browserSessionId &&
    scope.apiBase === scope.requestScope.apiBase &&
    hostScope?.apiBase === scope.apiBase &&
    hostScope.authorityKey === scope.requestScope.authorityKey;
  const { access, sessions } = useBrowserSessionReads(
    scope.apiBase,
    scope.requestScope.authorityKey,
    scope.projectSlug,
    transport,
    enabled,
  );
  const session =
    enabled && access.isSuccess
      ? sessions.data?.list.find(
          (row) =>
            row.browserSessionId === browserSessionId &&
            row.projectId === access.data?.projectId &&
            row.projectSlug === scope.projectSlug &&
            row.principalKey === access.data?.principalKey &&
            row.threadId !== undefined &&
            scope.threadIds.includes(row.threadId) &&
            row.state === 'live' &&
            !!row.surfaceId,
        )
      : undefined;
  const key =
    session && !floating
      ? browserShownSourceKey(
          session.browserSessionId,
          scope.apiBase,
          scope.requestScope.authorityKey,
        )
      : null;
  const { visible, paneShown, onScreen } = useInlineSourceVisibility(key, ref);
  const onControlState = useCallback(
    (_state: LiveSurfaceControlState) => {},
    [],
  );
  const openInPanel =
    session &&
    openBrowser &&
    hostScope?.apiBase === scope.apiBase &&
    hostScope.authorityKey === scope.requestScope.authorityKey
      ? () => {
          const request = {
            projectId: session.projectId,
            browserSessionId: session.browserSessionId,
          };
          const result = openBrowser(request, { region: 'right' });
          return !result.ok && result.reason === 'region-unavailable'
            ? openBrowser(request)
            : result;
        }
      : null;
  return (
    <section className="inline-browser-activity">
      <div className="inline-browser-activity__heading">
        <strong>Browser activity</strong>
        <span>
          {status} · {toolCount} {toolCount === 1 ? 'tool call' : 'tool calls'}
        </span>
      </div>
      {!active && !showCurrent && browserSessionId && (
        <Button variant="secondary" onClick={() => setShowCurrent(true)}>
          Open current session
        </Button>
      )}
      {(active || showCurrent) && (
        <div ref={ref}>
          {!active && <p>Current browser session</p>}
          {(access.isLoading ||
            (access.isSuccess &&
              !!access.data.principalKey &&
              sessions.isLoading)) &&
          enabled ? (
            <SkeletonBlock label="Loading browser activity" />
          ) : null}
          {(access.isError || sessions.isError) && (
            <ErrorState
              variant="compact"
              title="Browser activity unavailable"
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    void access.refetch();
                    void sessions.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            />
          )}
          {enabled &&
            access.isSuccess &&
            (!access.data.principalKey || sessions.isSuccess) &&
            !session && (
              <p>Browser session is unavailable for this conversation.</p>
            )}
          {session && !floating && visible && (
            <div
              className="inline-browser-activity__viewport"
              style={{
                aspectRatio: `${session.viewport.width} / ${session.viewport.height}`,
              }}
            >
              <BrowserSessionSurface
                session={session}
                apiBase={scope.apiBase}
                authorityKey={scope.requestScope.authorityKey}
                transport={transport}
                agentActionsEnabled={
                  access.data?.experiencePreviewEnabled === true
                }
                onControlState={onControlState}
                openInPanel={openInPanel}
                hostControls={false}
              />
            </div>
          )}
          {session && (floating || !visible) && (
            <p>
              {floating
                ? 'Browser is floating.'
                : paneShown
                  ? 'Browser is shown in a pane.'
                  : !onScreen
                    ? 'Browser is outside the visible area.'
                    : 'Browser is shown in another activity.'}
            </p>
          )}
          {session && (
            <div className="inline-browser-activity__actions">
              {floating ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    closeFloat(scope.conversationKey);
                  }}
                >
                  Bring back
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    openFloat(
                      scope.conversationKey,
                      {
                        kind: 'browser',
                        browserSessionId: session.browserSessionId,
                        surfaceId: session.surfaceId!,
                      },
                      { requested: true },
                    );
                  }}
                >
                  Float
                </Button>
              )}
              {openInPanel && (
                <Button variant="secondary" onClick={() => void openInPanel()}>
                  Open in pane
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <div className="inline-browser-activity__steps">{children}</div>
    </section>
  );
}
