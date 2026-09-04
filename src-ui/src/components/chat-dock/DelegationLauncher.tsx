import { environmentId as toEnvironmentId } from '@kontourai/station-contracts/execution-target';
import {
  type DelegatedTaskHandle,
  type DelegationTargetOption,
  useDelegateOrchestrationTaskMutation,
  useDelegationOptionsQuery,
  usePeerCredentialsQuery,
  useProjectQuery,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import {
  ENVIRONMENTS_UNAVAILABLE_NOTICE,
  MISSING_ENVIRONMENT_NOTICE,
} from '../EnvironmentPicker';
import { ResponsiveDialogCloseButton } from '../ResponsiveDialogSurface';

interface DelegationLauncherProps {
  isOpen: boolean;
  apiBase: string;
  projectSlug?: string;
  projectName?: string | null;
  currentAgentId?: string;
  currentModel?: string | null;
  parentTaskId?: string;
  parentTaskLabel?: string;
  initialPrompt?: string;
  onClose: () => void;
  onDelegated: (task: DelegatedTaskHandle, targetName: string) => void;
}

type TargetOption = {
  id: DelegationTargetOption['id'];
  value: string;
  name: string;
  detail: string;
  ready: boolean;
  unavailableReason?: string;
  defaultModel?: string;
  models: DelegationTargetOption['models'];
};

export function DelegationLauncher({
  isOpen,
  apiBase,
  projectSlug,
  projectName,
  currentAgentId,
  currentModel,
  parentTaskId,
  parentTaskLabel,
  initialPrompt = '',
  onClose,
  onDelegated,
}: DelegationLauncherProps) {
  const visualViewport = useMobileVisualViewport();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const wasOpenRef = useRef(false);
  const environmentSelectionExplicitRef = useRef(false);
  const {
    data: environments,
    isSuccess: environmentsLoaded,
    isError: environmentsFailed,
  } = useSshEnvironmentsQuery({
    enabled: isOpen,
  });
  const { data: project } = useProjectQuery(projectSlug ?? '', {
    enabled: isOpen && Boolean(projectSlug),
  });
  // #790 (#765 D4): Stations paired via `station environment peers add` are
  // selectable delegation targets. The server's `resolveTarget` already falls
  // back from SSH to the outbound peer-credential store for a
  // `{ kind: 'saved' }` environment id, so listing peers here is the only
  // missing wiring. `GET /api/environments/peers` is `access:manage`-gated
  // for a remote caller — a non-operator browser session 403s, so peers are
  // rendered only on success, exactly like the Computers page.
  const peerCredentialsQuery = usePeerCredentialsQuery({ enabled: isOpen });
  const peerStations = useMemo(() => {
    const sshEnvironmentIds = new Set(
      (environments ?? [])
        .map((environment) => environment.profile.environmentId)
        .filter(Boolean),
    );
    return (peerCredentialsQuery.data ?? []).filter(
      (peer) =>
        // An environmentId with a saved SSH profile resolves through SSH
        // server-side (the peer credential rides that tunnel); its SSH option
        // is already listed, so a second entry would dispatch identically.
        !sshEnvironmentIds.has(peer.environmentId) &&
        // 'current' is this select's sentinel for "This Station"; a peer that
        // somehow stored it could never be dispatched as itself.
        peer.environmentId !== 'current',
    );
  }, [environments, peerCredentialsQuery.data]);
  const configuredEnvironmentId =
    project?.defaultEnvironment?.kind === 'saved'
      ? project.defaultEnvironment.id
      : 'current';
  const defaultEnvironmentExists =
    configuredEnvironmentId === 'current' ||
    environments?.some(
      (environment) =>
        environment.profile.environmentId === configuredEnvironmentId,
    );
  const danglingDefaultEnvironment = Boolean(
    environmentsLoaded &&
      configuredEnvironmentId !== 'current' &&
      !defaultEnvironmentExists,
  );
  const defaultEnvironmentId = danglingDefaultEnvironment
    ? 'current'
    : defaultEnvironmentExists || environmentsFailed
      ? configuredEnvironmentId
      : 'current';
  const mutation = useDelegateOrchestrationTaskMutation(apiBase);

  const [environmentId, setEnvironmentId] = useState('current');
  const {
    data: delegationOptions,
    error: discoveryError,
    isFetching: isDiscovering,
    refetch: retryDiscovery,
  } = useDelegationOptionsQuery(
    environmentId === 'current'
      ? { ...(projectSlug ? { projectSlug } : {}) }
      : { environmentId },
    apiBase,
    { enabled: isOpen },
  );

  const targets = useMemo<TargetOption[]>(() => {
    return (delegationOptions?.targets ?? []).map((option) => ({
      id: option.id,
      value: `agent:${option.id}`,
      name: option.name,
      detail: 'Agent',
      ready: option.ready,
      unavailableReason: option.unavailableReason,
      defaultModel: option.defaultModel,
      models: option.models,
    }));
  }, [delegationOptions]);

  const currentTargetId = currentAgentId;
  const currentTarget = currentTargetId
    ? `agent:${currentTargetId}`
    : undefined;

  const defaultTarget = useMemo(() => {
    const current = currentTarget
      ? targets.find((target) => target.value === currentTarget)
      : undefined;
    return (
      current?.value ?? targets.find((target) => target.ready)?.value ?? ''
    );
  }, [currentTarget, targets]);

  const [prompt, setPrompt] = useState(initialPrompt);
  const [target, setTarget] = useState(defaultTarget);
  const [model, setModel] = useState(currentModel ?? '');
  const [showRouting, setShowRouting] = useState(false);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setPrompt(initialPrompt);
      setTarget(defaultTarget);
      environmentSelectionExplicitRef.current = false;
      setEnvironmentId(defaultEnvironmentId);
      setModel(defaultTarget === currentTarget ? (currentModel ?? '') : '');
      setShowRouting(false);
      mutation.reset();
      requestAnimationFrame(() => promptRef.current?.focus());
    }
    wasOpenRef.current = isOpen;
  }, [
    currentModel,
    currentTarget,
    defaultTarget,
    defaultEnvironmentId,
    initialPrompt,
    isOpen,
    mutation.reset,
  ]);

  useEffect(() => {
    if (!isOpen || environmentSelectionExplicitRef.current) return;
    setEnvironmentId(defaultEnvironmentId);
  }, [defaultEnvironmentId, isOpen]);

  useEffect(() => {
    if (!isOpen || target || !defaultTarget) return;
    setTarget(defaultTarget);
    setModel(
      environmentId === 'current' && defaultTarget === currentTarget
        ? (currentModel ?? '')
        : '',
    );
  }, [
    currentModel,
    currentTarget,
    defaultTarget,
    environmentId,
    isOpen,
    target,
  ]);

  if (!isOpen) return null;

  const selectedTarget = targets.find((option) => option.value === target);
  const unavailableTargets = targets.filter((option) => !option.ready);
  const selectedEnvironment = environments?.find(
    (environment) => environment.profile.environmentId === environmentId,
  );
  const selectedPeer = peerStations.find(
    (peer) => peer.environmentId === environmentId,
  );
  const selectedEnvironmentName =
    environmentId === 'current'
      ? 'This Station'
      : (selectedEnvironment?.profile.name ??
        selectedPeer?.label ??
        selectedPeer?.apiBase ??
        delegationOptions?.environment.name ??
        'Selected Station');
  const resolvedModelId = model.trim() || selectedTarget?.defaultModel || '';
  const resolvedModelName = resolvedModelId
    ? (selectedTarget?.models.find(
        (option) =>
          option.id === resolvedModelId ||
          option.originalId === resolvedModelId,
      )?.name ?? resolvedModelId)
    : null;
  const environmentUnavailable = Boolean(
    selectedEnvironment &&
      (!selectedEnvironment.profile.environmentId ||
        !selectedEnvironment.profile.verifiedProjectPath),
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !selectedTarget?.ready ||
      !prompt.trim() ||
      environmentUnavailable ||
      isDiscovering ||
      discoveryError
    )
      return;
    try {
      const task = await mutation.mutateAsync({
        prompt: prompt.trim(),
        target: {
          environment:
            environmentId === 'current'
              ? { kind: 'current' }
              : { kind: 'saved', id: toEnvironmentId(environmentId) },
          agent: selectedTarget.id,
          ...(model.trim() ? { model: { override: model.trim() } } : {}),
          ...(projectSlug
            ? { workspace: { kind: 'project', projectSlug } }
            : {}),
        },
        ...(parentTaskId ? { parentTaskId } : {}),
      });
      onDelegated(task, selectedTarget.name);
    } catch {
      // React Query exposes the actionable error inline and keeps the draft.
    }
  };

  const containFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]',
      ),
    ).filter(
      (element) =>
        !(element instanceof HTMLButtonElement && element.disabled) &&
        !(element instanceof HTMLInputElement && element.disabled) &&
        !(element instanceof HTMLSelectElement && element.disabled) &&
        !(element instanceof HTMLTextAreaElement && element.disabled) &&
        element.getAttribute('tabindex') !== '-1' &&
        element.getAttribute('aria-hidden') !== 'true',
    );
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // #1180: mounted from both `ChatDock` (a sibling of `<main>`, never inside
  // a `PageFrame`) and `SessionsView`'s `/activity` route (a plain sibling of
  // `SplitPaneLayout`, inside the frame `PageFrame` marks `inert` while that
  // layout's mobile detail sheet is open — PageFrame.tsx:155). This is a
  // hand-rolled overlay, not a `ResponsiveDialogSurface` consumer, so unlike
  // the other sites in this class it never had a shared portal to inherit;
  // rendered in place on `/activity` it fell inside the inert subtree, visible
  // but with `.focus()` a no-op and every control unclickable. `createPortal`
  // to `document.body` — the same escape `ConfirmModal` and `PluginModalStack`
  // (#1131) already use — is unconditional, so the ChatDock mount is
  // unaffected: `.delegation-launcher__overlay` is already `position: fixed;
  // inset: 0` with a global z-index, so moving its DOM location changes
  // nothing visually there. Return focus is already owned by both callers
  // (`ChatDock`'s `restoreComposerMenuFocus`, `SessionsView`'s
  // `captureReturnFocus`/`restoreReturnFocus` around `openDelegation` /
  // `closeDelegation`) via element refs, which resolve the same regardless of
  // where in the DOM this node lives — so nothing else here needed to change.
  return createPortal(
    <div
      className="delegation-launcher__overlay responsive-surface-overlay"
      style={visualViewport.style}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="delegation-launcher"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delegation-launcher-title"
        onKeyDown={containFocus}
        onSubmit={(event) => void submit(event)}
      >
        <header className="delegation-launcher__header">
          <div>
            <h2 id="delegation-launcher-title">Delegate a task</h2>
            <p>
              Start resumable work{projectName ? ` for ${projectName}` : ''}.
            </p>
          </div>
          <ResponsiveDialogCloseButton
            label="Close delegation"
            onClick={onClose}
          />
        </header>

        <div className="delegation-launcher__body">
          {parentTaskId && (
            <div className="delegation-launcher__parent">
              <span>Child worker of</span>
              <strong title={parentTaskLabel ?? parentTaskId}>
                {parentTaskLabel ?? 'this task'}
              </strong>
            </div>
          )}

          <label>
            Task
            <textarea
              ref={promptRef}
              value={prompt}
              rows={5}
              placeholder="Implement the next bounded backlog item and verify it locally…"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <div className="delegation-launcher__routing-summary">
            <div aria-live="polite">
              <span>Running with</span>
              <strong>
                {selectedTarget?.name ??
                  (isDiscovering
                    ? 'Checking available workers…'
                    : 'No ready worker')}
              </strong>
              <small>
                {[resolvedModelName, selectedEnvironmentName]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </div>
            <button
              type="button"
              aria-expanded={showRouting}
              aria-controls="delegation-launcher-routing"
              onClick={() => setShowRouting((value) => !value)}
            >
              {showRouting ? 'Hide routing' : 'Change routing'}
            </button>
          </div>

          {discoveryError && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{discoveryError.message}</span>
              <button type="button" onClick={() => void retryDiscovery()}>
                Try again
              </button>
            </div>
          )}
          {danglingDefaultEnvironment && (
            <p className="delegation-launcher__hint" role="status">
              {MISSING_ENVIRONMENT_NOTICE}
            </p>
          )}
          {environmentsFailed && configuredEnvironmentId !== 'current' && (
            <p className="delegation-launcher__hint" role="alert">
              {ENVIRONMENTS_UNAVAILABLE_NOTICE}
            </p>
          )}
          {showRouting && (
            <div
              id="delegation-launcher-routing"
              className="delegation-launcher__routing"
            >
              <div className="delegation-launcher__grid">
                <label>
                  Worker
                  <select
                    value={target}
                    onChange={(event) => {
                      const nextTarget = event.target.value;
                      setTarget(nextTarget);
                      setModel(
                        nextTarget === currentTarget
                          ? (currentModel ?? '')
                          : '',
                      );
                    }}
                  >
                    {(isDiscovering || targets.length === 0) && (
                      <option value="">
                        {isDiscovering
                          ? 'Checking this Station…'
                          : 'No ready workers'}
                      </option>
                    )}
                    {targets.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={!option.ready}
                      >
                        {option.name} — {option.detail}
                        {!option.ready ? ' (unavailable)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Station
                  <select
                    value={environmentId}
                    onChange={(event) => {
                      environmentSelectionExplicitRef.current = true;
                      setEnvironmentId(event.target.value);
                      setTarget('');
                      setModel('');
                    }}
                  >
                    <option value="current">This Station</option>
                    {environmentsFailed &&
                      configuredEnvironmentId !== 'current' && (
                        <option value={configuredEnvironmentId}>
                          {configuredEnvironmentId} — saved environment
                        </option>
                      )}
                    {(environments ?? [])
                      .filter(
                        (environment) => environment.profile.environmentId,
                      )
                      .map((environment) => (
                        <option
                          key={environment.profile.id}
                          value={environment.profile.environmentId!}
                          disabled={!environment.profile.verifiedProjectPath}
                        >
                          {environment.profile.name} — SSH
                          {!environment.profile.verifiedProjectPath
                            ? ' (verify first)'
                            : environment.state.phase === 'connected'
                              ? ' (connected)'
                              : ' (connects to check)'}
                        </option>
                      ))}
                    {peerStations.map((peer) => (
                      <option
                        key={`peer:${peer.environmentId}`}
                        value={peer.environmentId}
                      >
                        {peer.label ?? peer.apiBase} — Paired Station
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                Model
                <input
                  aria-label="Model"
                  value={model}
                  placeholder="Use worker configuration"
                  list="delegation-launcher-models"
                  onChange={(event) => setModel(event.target.value)}
                />
                {selectedTarget?.models.length ? (
                  <datalist id="delegation-launcher-models">
                    {selectedTarget.models.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </datalist>
                ) : null}
                <span className="delegation-launcher__hint">
                  {resolvedModelName
                    ? `Resolved model: ${resolvedModelName}`
                    : 'The worker chooses from its configured models.'}
                </span>
              </label>

              {unavailableTargets.length > 0 && (
                <details className="delegation-launcher__unavailable">
                  <summary>
                    {unavailableTargets.length} unavailable on{' '}
                    {delegationOptions?.environment.name ?? 'this Station'}
                  </summary>
                  <ul>
                    {unavailableTargets.map((option) => (
                      <li key={option.value}>
                        <strong>{option.name}:</strong>{' '}
                        {option.unavailableReason ?? 'Setup is required.'}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {mutation.error && (
            <p className="delegation-launcher__error" role="alert">
              {mutation.error.message}
            </p>
          )}
        </div>

        <footer className="delegation-launcher__footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="delegation-launcher__submit"
            disabled={
              mutation.isPending ||
              isDiscovering ||
              Boolean(discoveryError) ||
              !prompt.trim() ||
              !selectedTarget?.ready ||
              environmentUnavailable
            }
          >
            {mutation.isPending ? 'Starting…' : 'Delegate'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
