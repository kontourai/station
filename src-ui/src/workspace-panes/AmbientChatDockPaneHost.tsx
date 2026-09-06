import {
  createWorkspaceChatPaneInstance,
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  type WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import type { ReactNode } from 'react';
import { DockShell } from '../components/chat-dock/DockShell';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { reportRegionClearance } from '../regions/region-clearance';
import type { DockMode } from '../types';
import { WorkspacePaneHost } from './WorkspacePaneHost';

/**
 * The document id half of Chat's persisted dock state,
 * `station:workspace-pane-host:v2:ambient:chat-dock`
 * (`workspacePaneHostStorageKey`). The key is a user's dock state on disk:
 * renaming it resets every device's dock, so it is pinned by
 * `AmbientChatDockPaneHost.test.tsx` and named in `docs/design/placement.md`.
 */
export const AMBIENT_CHAT_DOCK_DOCUMENT_ID = 'chat-dock';

/**
 * The shell has one projectless chat occurrence. Its placement capability is
 * declared by the descriptor; this document supplies the distinct ambient
 * host identity that persists it per device. Today the document holds only
 * that one instance — it is Chat's own state store and the prototype of a
 * per-region pane-host document (`docs/design/placement.md`, "Direction").
 *
 * Throws rather than returning null, the same way the Chat descriptor itself
 * refuses to parse: both inputs are code-owned constants, so a failure here is
 * a build that shipped an invalid built-in, not a runtime condition. Returning
 * null would make the dock silently absent — and an absent affordance is
 * indistinguishable from one Station never had.
 */
export function createAmbientChatDockPaneDocument(): WorkspacePaneHostDocumentV1 {
  const chat = createWorkspaceChatPaneInstance();
  if (!chat) throw new Error('Invalid built-in ambient Chat dock occurrence');
  const document = createWorkspacePaneHostBaselineDocument(
    AMBIENT_CHAT_DOCK_DOCUMENT_ID,
    { kind: 'ambient' },
    [chat],
  );
  if (!document)
    throw new Error('Invalid built-in ambient Chat dock host document');
  return document;
}

const ambientChatDockPaneDocument = createAmbientChatDockPaneDocument();

/**
 * Chat is the only pane this host renders (#928 C2b deleted the legacy
 * docked-Home path; Home and Activity are region surfaces with their own
 * shells). The persisted document is admitted one instance at a time, and
 * only the canonical Chat occurrence passes: a document a previous build
 * persisted with a Home or Activity occupant restores as the Chat baseline
 * rather than rendering a pane this host has no branch for.
 *
 * Returns a parsed instance rather than the untrusted persisted object — a
 * cast would let an unparsed candidate alias straight into the host document.
 * `ProjectLayoutRenderer`'s admission does the same for the same reason.
 */
function admitsAmbientChatInstance(
  candidate: unknown,
): WorkspacePaneInstance | null {
  const instance = parseWorkspacePaneInstance(candidate);
  return instance && isAmbientChatInstance(instance) ? instance : null;
}

function isAmbientChatInstance(instance: WorkspacePaneInstance): boolean {
  return (
    instance.descriptorId === WORKSPACE_CHAT_PANE_DESCRIPTOR.id &&
    isCanonicalWorkspaceChatPaneInstance(instance)
  );
}

/**
 * The ambient shell mounts Chat through the same host/frame lifecycle as
 * every pane: `DockShell` (the one dock chrome shell — root box, resize
 * handle, geometry/snap/drag state, `dock.toggle`/`dock.maximize`) around a
 * chromeless `WorkspacePaneHost` holding Chat's persisted document. The
 * shell's geometry report goes to the clearance reducer, one entry per
 * rendered region (#928; the reducer is the one writer of the CSS variables,
 * archive#3902/archive#3929).
 */
export function AmbientChatDockPaneHost({
  regionId,
  onRequestAuth,
  renderChatPane,
}: {
  regionId?: DockMode;
  onRequestAuth?: () => Promise<boolean> | undefined;
  renderChatPane(
    instance: WorkspacePaneInstance,
    onRequestAuth: (() => Promise<boolean> | undefined) | undefined,
    shellChrome: DockShellChrome,
  ): ReactNode;
}) {
  return (
    <DockShell
      regionId={regionId}
      onRenderedRegionGeometryChange={reportRegionClearance}
    >
      {(shellChrome) => (
        <WorkspacePaneHost
          document={ambientChatDockPaneDocument}
          presentation="chromeless"
          admitRestoredInstance={admitsAmbientChatInstance}
          admitOpenInstance={isAmbientChatInstance}
          renderPane={(instance) =>
            isAmbientChatInstance(instance)
              ? renderChatPane(instance, onRequestAuth, shellChrome)
              : null
          }
        />
      )}
    </DockShell>
  );
}
