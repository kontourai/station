import { isCanonicalWorkspaceActivityPaneInstance } from '@kontourai/station-contracts/workspace-activity-pane';
import { useConversationInventoryQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import type { BuiltinWorkspacePaneProps } from '../../workspace-panes/builtinWorkspacePaneRegistry';
import { WorkspacePaneBindingUnavailable } from '../../workspace-panes/WorkspacePaneBindingUnavailable';
import { SessionsView } from '../SessionsView';
import { useActivityWorkspacePaneBinding } from './ActivityWorkspacePaneBinding';

/**
 * The built-in Activity Workspace Pane renderer — the ONE mounter of the
 * sessions surface (`SessionsView`), pinned by
 * `__tests__/activity-surface-single-mounter.test.ts`. Every placement
 * (the Activity region shell, the Developer archive embed)
 * reaches the surface through this renderer and its canonical-occurrence
 * check, so the pre-pane route/surface split cannot silently re-form.
 *
 * Like Home, Activity binds no Project, so it never consults
 * `useWorkspacePaneBoundIdentity` — there is no captured identity whose
 * resolution could fail. Its one derivable failure is the occurrence check
 * every built-in performs: a placed instance that is not Activity's
 * canonical one does not match the renderer it was opened with, and says so.
 *
 * A missing context binding renders nothing rather than narrating a state no
 * supported host produces — the same programming-error stance as Home's
 * renderer: this context's only producers are Activity's placements.
 *
 * Placement belongs to shell chrome. This renderer contributes only Activity
 * content, regardless of whether a route or region host mounts it.
 */
export function ActivityWorkspacePane({ instance }: BuiltinWorkspacePaneProps) {
  const binding = useActivityWorkspacePaneBinding();
  const showSurface = useShowSurface();
  // #3159: rows the conversation inventory marks referenceable can be
  // dragged onto a composer of the same Station access scope.
  const requestAuthority = useHostRequestAuthorityScope();
  const inventory = useConversationInventoryQuery();
  const referenceApiBase = requestAuthority?.apiBase;
  const referenceAuthorityKey = requestAuthority?.authorityKey;
  const referenceDrag = useMemo(() => {
    if (referenceApiBase === undefined || referenceAuthorityKey === undefined)
      return undefined;
    const referenceable = new Set(
      (inventory.data ?? [])
        .filter((conversation) => conversation.referenceEligibility?.eligible)
        .map((conversation) => conversation.id),
    );
    return {
      scope: { apiBase: referenceApiBase, authorityKey: referenceAuthorityKey },
      isReferenceable: (conversationId: string) =>
        referenceable.has(conversationId),
    };
  }, [referenceApiBase, referenceAuthorityKey, inventory.data]);
  if (!isCanonicalWorkspaceActivityPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (!binding) return null;
  return (
    <SessionsView
      onOpenInChat={(threadId) => showSurface('chat', { session: threadId })}
      apiBase={binding.apiBase}
      sessionId={binding.sessionId}
      focusHint={binding.focusHint}
      intentToken={binding.intentToken}
      onFocusConsumed={binding.onFocusConsumed}
      referenceDrag={referenceDrag}
    />
  );
}
