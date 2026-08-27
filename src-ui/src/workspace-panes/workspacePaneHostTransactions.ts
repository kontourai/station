import type {
  WorkspacePaneInstance,
  WorkspacePaneInstanceId,
} from '@kontourai/station-contracts/workspace-pane';
import type {
  WorkspacePaneHostAction,
  WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import type { WorkspacePaneHostOpenPreparation } from './WorkspacePaneHostOpenContext';
import {
  reduceWorkspacePaneHost,
  type WorkspacePaneHostState,
} from './workspacePaneHostReducer';
import { workspacePaneHostCloseSuccessor } from './workspacePaneHostReducerTree';
import {
  hydrateWorkspacePaneHost,
  persistWorkspacePaneHost,
  registerLiveWorkspacePaneHostDocument,
  type WorkspacePaneHostRestoredInstanceAdmission,
  type WorkspacePaneHostStorage,
} from './workspacePaneHostStorage';

export function initialWorkspacePaneHostState({
  document,
  admitRestoredInstance,
  storage,
}: {
  document: WorkspacePaneHostDocumentV1;
  admitRestoredInstance?: WorkspacePaneHostRestoredInstanceAdmission;
  storage?: WorkspacePaneHostStorage;
}): WorkspacePaneHostState {
  try {
    const hydrated = hydrateWorkspacePaneHost(
      storage ?? window.localStorage,
      document.scope,
      document.id,
      document.instances,
      admitRestoredInstance,
    );
    return { document: hydrated.document ?? document, rendererFailures: {} };
  } catch {
    return { document, rendererFailures: {} };
  }
}

export function closeWorkspacePaneHostDocument(
  document: WorkspacePaneHostDocumentV1,
  instanceId: WorkspacePaneInstanceId,
): WorkspacePaneHostDocumentV1 | null {
  const successor = workspacePaneHostCloseSuccessor(document, instanceId);
  if (!successor || document.instances.length <= 1) return null;
  const next = reduceWorkspacePaneHost(
    { document, rendererFailures: {} },
    { type: 'close', instanceId },
  ).document;
  return next === document ? null : next;
}

function rollbackPreparedHostDocument(
  storage: WorkspacePaneHostStorage,
  owner: symbol,
  before: WorkspacePaneHostDocumentV1,
): boolean {
  registerLiveWorkspacePaneHostDocument(storage, owner, before);
  // A failed durable rollback leaves the prepared superset in storage. It
  // still protects every prior state reference, while hydration quarantines
  // the uncommitted occurrence whose state was never written.
  return persistWorkspacePaneHost(storage, before);
}

function rollbackPreparedOpen(
  storage: WorkspacePaneHostStorage,
  owner: symbol,
  before: WorkspacePaneHostDocumentV1,
  preparation?: WorkspacePaneHostOpenPreparation,
): void {
  try {
    rollbackPreparedHostDocument(storage, owner, before);
  } finally {
    try {
      preparation?.rollback();
    } catch {
      // A caller rollback cannot make a rejected host occurrence authoritative.
    }
  }
}

/**
 * Stages host persistence before the caller writes pane state, and rolls both
 * back on failure. Keeping this transaction pure of React state makes its
 * ordering testable independently of host rendering.
 */
export function prepareWorkspacePaneHostOpen({
  state,
  instance,
  storage,
  owner,
  preparation,
  action,
}: {
  state: WorkspacePaneHostState;
  instance: WorkspacePaneInstance;
  storage: WorkspacePaneHostStorage;
  owner: symbol;
  preparation?: WorkspacePaneHostOpenPreparation;
  action?: Extract<
    WorkspacePaneHostAction,
    { type: 'add-existing-instance' } | { type: 'split' }
  >;
}): WorkspacePaneHostState | null {
  const before = state.document;
  if (
    before.instances.some(
      (candidate) => candidate.instanceId === instance.instanceId,
    )
  )
    return null;
  const nextState = reduceWorkspacePaneHost(
    state,
    action ?? { type: 'add-existing-instance', instance },
  );
  const next = nextState.document;
  if (
    next.instances.length !== before.instances.length + 1 ||
    !next.instances.some(
      (candidate) => candidate.instanceId === instance.instanceId,
    )
  )
    return null;
  try {
    if (
      !persistWorkspacePaneHost(storage, next) ||
      !registerLiveWorkspacePaneHostDocument(storage, owner, next)
    ) {
      rollbackPreparedOpen(storage, owner, before, preparation);
      return null;
    }
    if (!(preparation?.prepare() ?? true)) {
      rollbackPreparedOpen(storage, owner, before, preparation);
      return null;
    }
    return nextState;
  } catch {
    rollbackPreparedOpen(storage, owner, before, preparation);
    return null;
  }
}
