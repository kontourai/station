import {
  WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
  type WorkspaceBrowserPreviewState,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { useCallback, useEffect, useState } from 'react';
import type { NativeCapabilityStatus } from '../platform/native';
import { nativePlatformPromise } from '../platform/native';
import { BrowserPreviewPane } from './BrowserPreviewPane';
import { isCanonicalBrowserPreviewPaneInstance } from './browserPreviewPaneInstance';
import {
  readBrowserPreviewPaneState,
  writeBrowserPreviewPaneState,
} from './browserPreviewPaneStateStorage';
import type { BuiltinWorkspacePaneProps } from './builtinWorkspacePaneRegistry';
import { useWorkspacePaneBoundIdentity } from './useWorkspacePaneBoundIdentity';
import { WorkspacePaneBindingUnavailable } from './WorkspacePaneBindingUnavailable';

/**
 * Bridges strict durable metadata into the UI-local renderer projection. A
 * restored occurrence always starts loading; prior rendering outcomes are not
 * retained as health evidence.
 */
export function BrowserPreviewWorkspacePane({
  instance,
}: BuiltinWorkspacePaneProps) {
  const identity = useWorkspacePaneBoundIdentity(instance, false);
  const projectId = identity.state === 'resolved' ? identity.project.id : '';
  const [revision, setRevision] = useState(0);
  const [externalAction, setExternalAction] = useState<NativeCapabilityStatus>({
    id: 'local-browser-preview',
    state: 'disabled',
    reason:
      'Station is checking whether the native external-open action is available.',
  });
  const state = readBrowserPreviewPaneState(
    window.localStorage,
    instance.stateKey,
  );
  const paneState = state;
  const canonicalInstance = Boolean(
    paneState &&
      instance.boundContext?.projectId === projectId &&
      isCanonicalBrowserPreviewPaneInstance(instance, paneState),
  );
  const saveAddress = useCallback(
    (requestedUrl: string) => {
      if (!state) return false;
      const next = {
        ...state,
        requestedUrl,
        updatedAt: new Date().toISOString(),
      };
      const written = writeBrowserPreviewPaneState(
        window.localStorage,
        instance.stateKey,
        next,
      );
      if (written) setRevision((current) => current + 1);
      return written;
    },
    [instance.stateKey, state],
  );
  useEffect(() => {
    if (!canonicalInstance) return;
    let disposed = false;
    void nativePlatformPromise
      .then((native) => {
        if (disposed) return;
        setExternalAction(native.capability('local-browser-preview'));
      })
      .catch(() => {
        if (disposed) return;
        setExternalAction({
          id: 'local-browser-preview',
          state: 'disabled',
          reason: 'Station could not verify the native external-open action.',
        });
      });
    return () => {
      disposed = true;
    };
  }, [canonicalInstance]);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!paneState || !canonicalInstance)
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-state-mismatch' }}
      />
    );
  const preview: WorkspaceBrowserPreviewState = {
    contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
    requestedUrl: paneState.requestedUrl,
    currentUrl: paneState.requestedUrl,
    status:
      externalAction.state === 'enabled'
        ? 'external-action-ready'
        : 'unavailable',
    historyCapability: 'unavailable',
    viewportPreference: paneState.viewportPreference,
    updatedAt: paneState.updatedAt,
    identity: { projectId },
  };

  return (
    <BrowserPreviewPane
      key={`${instance.instanceId}:${revision}`}
      preview={preview}
      onOpenExternal={async (url) => {
        const native = await nativePlatformPromise;
        return native.openLocalBrowserPreview(url);
      }}
      onDiscoverNativeTarget={
        externalAction.state === 'enabled'
          ? async (url) => {
              const native = await nativePlatformPromise;
              return native.discoverLocalBrowserPreviewTarget(url);
            }
          : undefined
      }
      onOpenNativeWindow={
        externalAction.state === 'enabled'
          ? async (grantId) => {
              const native = await nativePlatformPromise;
              return native.openLocalBrowserPreviewWindow(grantId);
            }
          : undefined
      }
      onChangeAddress={saveAddress}
      unavailableReason={
        externalAction.state === 'enabled' ? undefined : externalAction.reason
      }
    />
  );
}
