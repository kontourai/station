import { authenticatedFetch } from '@kontourai/station-sdk';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useOpenBrowserSessionInRegion } from '../../contexts/useOpenInRegion';
import {
  BrowserSessionSurface,
  browserSessionHost,
} from '../../float-over-chat/BrowserSessionSurface';
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
import {
  DRIVER_TEXT,
  LiveSurfaceViewerControls,
} from '../../live-surface/LiveSurfaceViewerControls';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import type { BrowserActivityScope } from '../chat/BrowserActivityContext';
import {
  callLabel,
  classifyToolCall,
  toolCallPhase,
} from '../chat/tool-call-labels';
import type { ToolCallLike } from '../chat/tool-call-runs';
import { toolDisplayView } from '../chat/tool-display-view';
import { ErrorState, SkeletonBlock } from '../state';
import './InlineBrowserActivity.css';

export function InlineBrowserActivity({
  scope,
  browserSessionId,
  active,
  toolCount,
  status,
  steps,
  children,
}: {
  scope: BrowserActivityScope;
  browserSessionId: string | null;
  active: boolean;
  toolCount: number;
  status: string;
  steps?: ToolCallLike[];
  children?: ReactNode;
}) {
  const [showCurrent, setShowCurrent] = useState(false);
  const [control, setControl] = useState<LiveSurfaceControlState | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
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
    (state: LiveSurfaceControlState) => setControl(state),
    [],
  );
  const changeControl = (action: () => Promise<void>) => {
    setControlError(null);
    void action().catch(() =>
      setControlError('Could not change browser control. Try again.'),
    );
  };
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
  const placementAction = session ? (
    floating ? (
      <Button
        variant="secondary"
        className="inline-browser-activity__control"
        onClick={() => {
          closeFloat(scope.conversationKey);
        }}
      >
        Bring back
      </Button>
    ) : (
      <Button
        variant="secondary"
        className="inline-browser-activity__control"
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
    )
  ) : null;
  const host = session ? browserSessionHost(session.url) : '';
  const heading = (
    <div className="inline-browser-activity__heading">
      <strong>
        {active ? session?.title || host || 'Browser' : 'Browsed'}
      </strong>
      {active && host && session?.title && session.title !== host && (
        <span>{host}</span>
      )}
      {!active && (
        <span>
          {toolCount} {toolCount === 1 ? 'action' : 'actions'}
        </span>
      )}
      {status && <span>{status}</span>}
    </div>
  );
  const paneAction = openInPanel ? (
    <Button
      variant="secondary"
      className="inline-browser-activity__control"
      onClick={() => void openInPanel()}
    >
      Open in pane
    </Button>
  ) : null;
  return (
    <section className="inline-browser-activity" data-active={active}>
      {!(session && !floating && visible && control) && heading}
      {!active && !showCurrent && browserSessionId && (
        <details>
          <summary className="inline-browser-activity__control">
            Current session
          </summary>
          <Button variant="secondary" onClick={() => setShowCurrent(true)}>
            Open current session
          </Button>
        </details>
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
          {session && !floating && visible && control && (
            <LiveSurfaceViewerControls
              label="Browser activity controls"
              className="inline-browser-activity__toolbar"
              actionClassName="inline-browser-activity__control"
              status={DRIVER_TEXT[control.tone]}
              tone={control.tone}
              onClaim={
                control.status === 'live' && control.tone !== 'you'
                  ? () => changeControl(control.claimControl)
                  : null
              }
              onRelease={
                control.tone === 'you'
                  ? () => changeControl(control.releaseControl)
                  : null
              }
              onToggleImmersive={
                control.immersive
                  ? control.exitImmersive
                  : control.enterImmersive
              }
              leading={heading}
              menu={
                <>
                  {paneAction}
                  {placementAction}
                </>
              }
              immersive={control.immersive}
            />
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
                hostControls
              />
            </div>
          )}
          {controlError && (
            <ErrorState variant="compact" title={controlError} />
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
          {session && (floating || !visible || !control) && (
            <ActionRow
              overflowLabel="More browser activity actions"
              primary={paneAction ?? placementAction}
              secondary={paneAction ? placementAction : undefined}
            />
          )}
        </div>
      )}
      {active && steps && (
        <ol
          className="inline-browser-activity__chips"
          aria-label="Browser actions"
        >
          {steps.map((part, index) => {
            const phase = toolCallPhase(part);
            const view = toolDisplayView(part);
            const label = callLabel(
              classifyToolCall({
                ...part,
                args: view.args,
                toolName: view.toolName,
              }),
              view.toolName,
              view.args,
              phase,
            );
            return (
              <li
                key={JSON.stringify([
                  part.toolCallId,
                  part.sourceEventId,
                  index,
                ])}
                className="inline-browser-activity__chip"
                aria-current={
                  index === steps.length - 1 &&
                  (phase === 'running' || phase === 'proposed')
                    ? 'step'
                    : undefined
                }
              >
                {label}
                {phase === 'failed'
                  ? ' · Failed'
                  : phase === 'proposed'
                    ? ' · Approval needed'
                    : ''}
              </li>
            );
          })}
        </ol>
      )}
      {children && (
        <div className="inline-browser-activity__steps">{children}</div>
      )}
    </section>
  );
}
