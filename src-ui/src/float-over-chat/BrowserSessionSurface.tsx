import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceControlState,
} from '../live-surface/LiveSurfaceCanvas';
import {
  BrowserImmersiveNav,
  type BrowserNavAction,
} from '../workspace-panes/browser-pane/BrowserImmersiveNav';
import { BrowserPageDialog } from '../workspace-panes/browser-pane/BrowserPageDialog';
import {
  browserPaneApi,
  describeBrowserFailure,
} from '../workspace-panes/browser-pane/browserPaneApi';
import type { FloatFetch } from './FloatOverChatHost';
import './BrowserSessionSurface.css';

export function browserSessionHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function BrowserSessionSurface({
  session,
  apiBase,
  authorityKey,
  transport,
  agentActionsEnabled,
  onControlState,
  openInPanel,
  hostControls = true,
}: {
  session: BrowserSessionView;
  apiBase: string;
  authorityKey: string;
  transport: FloatFetch;
  agentActionsEnabled: boolean;
  onControlState: (state: LiveSurfaceControlState) => void;
  openInPanel: (() => unknown) | null;
  hostControls?: boolean;
}) {
  const host = browserSessionHost(session.url);
  const queryClient = useQueryClient();
  const [control, setControl] = useState<LiveSurfaceControlState | null>(null);
  const pendingDialog = session.pendingDialog;
  // One stable reporter per upstream callback: the canvas re-reports its
  // control state whenever this prop changes, so a fresh closure per render
  // would loop (report → state → render → new closure → report).
  const reporters = useRef(
    new WeakMap<
      (state: LiveSurfaceControlState) => void,
      (state: LiveSurfaceControlState) => void
    >(),
  );
  const reportControl = (
    upstream: (state: LiveSurfaceControlState) => void,
  ) => {
    let reporter = reporters.current.get(upstream);
    if (!reporter) {
      reporter = (state) => {
        upstream(state);
        setControl(state);
      };
      reporters.current.set(upstream, reporter);
    }
    return reporter;
  };
  const answer = useMutation({
    mutationFn: (reply: {
      dialogId: string;
      accept: boolean;
      promptText?: string;
    }) =>
      browserPaneApi(apiBase, transport).answerDialog(
        session.browserSessionId,
        reply,
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: [
          'float-over-chat',
          apiBase,
          'sessions',
          session.projectSlug,
          authorityKey,
        ],
      }),
  });
  const navigate = useMutation({
    mutationFn: (action: BrowserNavAction) =>
      browserPaneApi(apiBase, transport).history(
        session.browserSessionId,
        action,
        session.generation,
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: [
          'float-over-chat',
          apiBase,
          'sessions',
          session.projectSlug,
          authorityKey,
        ],
      }),
  });
  return (
    <div className="float-over-chat__browser">
      <LiveSurfaceCanvas
        apiBase={apiBase}
        surfaceId={session.surfaceId!}
        label={`Browser: ${host}`}
        transport={transport}
        hostControls={hostControls}
        inputRequiresLease
        agentActionsEnabled={agentActionsEnabled}
        onControlState={reportControl(onControlState)}
        renderImmersiveActions={() => (
          <BrowserImmersiveNav
            part="address"
            host={host}
            disabled={control?.tone !== 'you' || navigate.isPending}
            onAction={(action) => navigate.mutate(action)}
          />
        )}
        renderImmersiveMenu={() => (
          <BrowserImmersiveNav
            part="navigation"
            host={host}
            disabled={control?.tone !== 'you' || navigate.isPending}
            onAction={(action) => navigate.mutate(action)}
          />
        )}
        // A dialog the page holds for the person driving from here is
        // answered here too: otherwise the float is a page that refuses
        // every click for no visible reason (#90). Drawn by the live
        // view, so it stays over the page in full screen as well.
        overlay={
          pendingDialog ? (
            <div className="float-over-chat__dialog-layer float-over-chat__dialog-layer--compact">
              <BrowserPageDialog
                compact
                key={pendingDialog.dialogId}
                dialog={pendingDialog}
                pageHost={host}
                pending={answer.isPending}
                error={
                  answer.isError ? describeBrowserFailure(answer.error) : null
                }
                onAnswer={(reply) =>
                  answer.mutate({
                    dialogId: pendingDialog.dialogId,
                    ...reply,
                  })
                }
                {...(openInPanel
                  ? { onOpenInPane: () => void openInPanel() }
                  : {})}
                {...(control?.tone === 'you'
                  ? { onKeepAlive: () => void control.keepControlAlive() }
                  : {})}
              />
            </div>
          ) : null
        }
      />
    </div>
  );
}
