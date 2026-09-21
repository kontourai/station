import { environmentId as toEnvironmentId } from '@kontourai/station-contracts/execution-target';
import type { ProjectIdentityView } from '@kontourai/station-contracts/project-identity';
import {
  type DelegatedTaskHandle,
  type DelegationTargetOption,
  isApiRequestScope,
  projectIdentityReadFailure,
  useDelegateOrchestrationTaskMutation,
  useDelegationOptionsQuery,
  usePeerCredentialsQuery,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import {
  useScopedProjectIdentityQuery,
  useScopedProjectQuery,
} from '../../contexts/ProjectsContext';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import {
  peerStationLabel,
  selectablePeerStations,
} from '../../utils/peerEnvironmentOptions';
import { Button } from '../Button';
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

/**
 * Named placement states for personal-peer portable execution (#480/#1964).
 * Every state names what is known; none guesses a target and none falls back
 * to receiver-local slug/path or local execution when portable intent cannot
 * be formed. Eligibility stays "unverified" until an authorized
 * controller-side offer query exists — the Station confirms on submit.
 */
export const PORTABLE_IDENTITY_NOTICE =
  'Checking this Project\u2019s portable identity before placing it on the selected Station.';
export const PORTABLE_IDENTITY_MISSING_NOTICE =
  'This Project has no portable identity on this Station, so it cannot be placed on a paired Station. Its prompt, Project and Station choice are kept.';
export const PORTABLE_IDENTITY_SETUP_GUIDANCE =
  'Prepare one explicitly with `station projects prepare-identity <slug>` and choose its execution resource with `station projects execution-root <slug> --repo-id=<resource-id> --path=<relative-path>`, then retry. Attaching a copy elsewhere is a separate explicit step (`station projects attach`).';
export const PORTABLE_RESOURCE_MISSING_NOTICE =
  'This Project\u2019s portable identity declares no executable resource, so there is nothing to place on the selected Station yet.';
export const PORTABLE_RESOURCE_CHOICE_NOTICE =
  'Choose which Project resource to place on the selected Station.';
export const PORTABLE_SSH_UNSUPPORTED_NOTICE =
  'This Project can\u2019t be placed on an SSH Station in this flow.';
export const PORTABLE_SSH_UNSUPPORTED_GUIDANCE =
  'Choose a paired Station to place this Project, or This Station to run it here. The prompt and Project choice are kept.';
export const PORTABLE_IDENTITY_DENIED_NOTICE =
  'This Station refused to share this Project\u2019s placement details.';
export const PORTABLE_IDENTITY_DENIED_GUIDANCE =
  'Check access and retry \u2014 nothing was sent and the prompt, Project and Station choice are kept.';
export const PORTABLE_IDENTITY_UNAVAILABLE_NOTICE =
  'This Project\u2019s placement details couldn\u2019t be loaded.';
export const PORTABLE_IDENTITY_UNAVAILABLE_GUIDANCE =
  'Retry when ready \u2014 nothing was sent and the prompt, Project and Station choice are kept.';
export const PORTABLE_OFFER_UNVERIFIED_NOTICE =
  'Offer not verified from here \u2014 the selected Station confirms whether it currently offers this Project resource when the task is submitted.';
export const PORTABLE_IDENTITY_STALE_INCARNATION_NOTICE =
  'This Project changed on this Station since its placement details were opened. Nothing was sent; retry to load the current Project.';
export const PORTABLE_AUTHORITY_STALE_NOTICE =
  'Station access changed before the task could start. The draft is kept; choose the Station again and retry.';

/**
 * Placement-surface view of the SDK's discriminated identity-read outcome
 * (#480 review). Only the SDK's `not-prepared` — a 404 carrying the
 * `project_identity_not_prepared` wire code, i.e. the server found the
 * Project and holds no identity record — is a VERIFIED missing identity
 * with prepare guidance. An unverified 404 (old server, proxy, removed
 * Project), a denial, and every other failure refuse visibly with retry
 * and never invent absence or readiness. Branches on transport status +
 * machine code, never on message text.
 */
export type ProjectIdentityFailureKind = 'missing' | 'denied' | 'unavailable';

export function projectIdentityFailureKind(
  error: unknown,
): ProjectIdentityFailureKind {
  const failure = projectIdentityReadFailure(error);
  if (failure === 'not-prepared') return 'missing';
  if (failure === 'denied') return 'denied';
  return 'unavailable';
}

/**
 * A 404 that verifies nothing — an old Station without the identity
 * endpoint, a proxy 404, a non-JSON 404 body, or a removed Project. Treated
 * exactly like any other unavailable read: retry/access guidance only,
 * never an absence claim and never speculative setup help (#480 final
 * review — the unverified 404 has no established diagnosis, so naming the
 * prepare command would expose implementation detail as if it were one).
 */

type PlacementResource = {
  id: string;
  name: string;
};

/** Public repo labels/ids only — never paths, slugs or credentials. */
function placementResources(
  identity: ProjectIdentityView | undefined,
): PlacementResource[] {
  return (identity?.identity.repos ?? []).map((repo) => ({
    id: repo.id,
    name: repo.label ?? repo.id,
  }));
}

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
  const {
    data: environments,
    isSuccess: environmentsLoaded,
    isError: environmentsFailed,
  } = useSshEnvironmentsQuery({
    enabled: isOpen,
  });
  const {
    data: project,
    isSuccess: projectLoaded,
    isError: projectFailed,
    refetch: retryProject,
  } = useScopedProjectQuery(projectSlug ?? '', {
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
  const peerStations = useMemo(
    () => selectablePeerStations(peerCredentialsQuery.data, environments),
    [environments, peerCredentialsQuery.data],
  );
  const requestScope = useHostRequestAuthorityScope();
  // Portable identity loads under the CAPTURED current Home/authority +
  // Project scope, keyed by all three — a late response for a previous
  // Home/authority/Project can never satisfy the current selection. The
  // browser reads the prepared identity only; it never uses a stored peer
  // secret and never prepares/attaches implicitly.
  const {
    data: projectIdentity,
    isSuccess: identityLoaded,
    isError: identityFailed,
    error: identityError,
    refetch: retryIdentity,
  } = useScopedProjectIdentityQuery(projectSlug ?? '', {
    enabled: isOpen && Boolean(projectSlug),
    // Identity-lifetime binding (#480 review): the selected Project's local
    // id joins the cache key and validates the response, so a same-Home
    // same-slug delete/recreate can never serve the previous incarnation's
    // portable id or resources from cache or a late response.
    expectedProjectId: project?.id,
  });
  const configuredEnvironmentId =
    project?.defaultEnvironment?.kind === 'saved'
      ? project.defaultEnvironment.id
      : 'current';
  const defaultEnvironmentExists =
    configuredEnvironmentId === 'current' ||
    environments?.some(
      (environment) =>
        environment.profile.environmentId === configuredEnvironmentId,
    ) ||
    peerStations.some((peer) => peer.environmentId === configuredEnvironmentId);
  const danglingDefaultEnvironment = Boolean(
    environmentsLoaded &&
      peerCredentialsQuery.isSuccess &&
      configuredEnvironmentId !== 'current' &&
      !defaultEnvironmentExists,
  );
  const mutation = useDelegateOrchestrationTaskMutation(apiBase);

  // Null follows the Project default; an explicit choice survives inventory
  // refreshes. Missing inventory must never substitute the current machine.
  const [chosenEnvironmentId, setEnvironmentId] = useState<string | null>(null);
  const environmentId = chosenEnvironmentId ?? configuredEnvironmentId;
  // Only an unset choice follows the default. An unavailable explicit choice
  // stays selected until the user chooses a replacement.
  const [chosenResourceId, setChosenResourceId] = useState<string | null>(null);
  // Set when Home/authority went stale across the submit await: the draft,
  // Project, resource and machine choice are kept; nothing is redispatched.
  const [authorityStale, setAuthorityStale] = useState(false);
  const projectDefaultsUnavailable =
    Boolean(projectSlug) &&
    (!projectLoaded || !project) &&
    chosenEnvironmentId === null;
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
    { enabled: isOpen && !projectDefaultsUnavailable },
  );

  const discoveryMatchesEnvironment =
    environmentId === 'current'
      ? delegationOptions?.environment.kind === 'current'
      : delegationOptions?.environment.id === environmentId;
  const targets = useMemo<TargetOption[]>(() => {
    if (projectDefaultsUnavailable || !discoveryMatchesEnvironment) return [];
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
  }, [
    delegationOptions,
    discoveryMatchesEnvironment,
    projectDefaultsUnavailable,
  ]);

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
  // Public repo labels/ids for the portable placement selector. The declared
  // execution-root repo wins; a sole repo is unambiguous; anything else
  // requires an explicit choice — never a guess.
  const identityResources = useMemo(
    () => placementResources(projectIdentity),
    [projectIdentity],
  );
  const declaredDefaultResourceId =
    projectIdentity?.identity.executionRoot &&
    identityResources.some(
      (resource) =>
        resource.id === projectIdentity.identity.executionRoot?.repoId,
    )
      ? projectIdentity.identity.executionRoot.repoId
      : null;
  const defaultResourceId =
    declaredDefaultResourceId ??
    (identityResources.length === 1 ? identityResources[0].id : null);
  const resourceId = chosenResourceId ?? defaultResourceId;
  const resourceAvailable = identityResources.some(
    (resource) => resource.id === resourceId,
  );
  const resourceChoiceUnavailable =
    chosenResourceId !== null && !resourceAvailable;

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setPrompt(initialPrompt);
      setTarget(defaultTarget);
      setEnvironmentId(null);
      setChosenResourceId(null);
      setAuthorityStale(false);
      setModel(defaultTarget === currentTarget ? (currentModel ?? '') : '');
      setShowRouting(false);
      mutation.reset();
      requestAnimationFrame(() => promptRef.current?.focus());
    }
    if (!isOpen) {
      setEnvironmentId(null);
      setChosenResourceId(null);
    }
    wasOpenRef.current = isOpen;
  }, [
    currentModel,
    currentTarget,
    defaultTarget,
    initialPrompt,
    isOpen,
    mutation.reset,
  ]);

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
        (selectedPeer ? peerStationLabel(selectedPeer) : undefined) ??
        (discoveryMatchesEnvironment
          ? delegationOptions?.environment.name
          : undefined) ??
        'Selected Station');
  // Personal-peer portable placement is ONLY the paired-peer selection for an
  // already-linked Project. Current-Station execution keeps its explicit
  // local workspace semantics. A Project selected for an SSH Station is
  // REFUSED with a named repair state — choosing a transport is not consent
  // to substitute a different same-named Project, so no slug/path/local
  // dispatch is possible there. No-Project SSH delegation is unaffected.
  const isPeerEnvironment = selectedPeer !== undefined;
  const isSshEnvironment =
    selectedEnvironment !== undefined && !isPeerEnvironment;
  const portablePlacement = Boolean(projectSlug) && isPeerEnvironment;
  // SSH + linked Project: blocked outright, never dispatched.
  const sshProjectBlocked = Boolean(projectSlug) && isSshEnvironment;
  const portableProjectId = portablePlacement
    ? projectIdentity?.identity.id
    : undefined;
  const portableIdentityPending =
    portablePlacement && !identityLoaded && !identityFailed;
  const portableIdentityFailure = portablePlacement && identityFailed;
  const identityFailureKind = portableIdentityFailure
    ? projectIdentityFailureKind(identityError)
    : null;
  const portableIdentityMissing = identityFailureKind === 'missing';
  const portableIdentityDenied = identityFailureKind === 'denied';
  const portableIdentityUnavailable = identityFailureKind === 'unavailable';
  const portableResourceMissing =
    portablePlacement && identityLoaded && identityResources.length === 0;
  const portableResourceChoiceRequired =
    portablePlacement &&
    identityLoaded &&
    ((identityResources.length > 1 && !resourceId) ||
      resourceChoiceUnavailable);
  const portableProjectUnavailable =
    portablePlacement && (!projectLoaded || !project?.id);
  const portableProjectInvalid =
    portableProjectUnavailable && (projectFailed || projectLoaded);
  const portableReady =
    portablePlacement &&
    !portableProjectUnavailable &&
    identityLoaded &&
    Boolean(portableProjectId) &&
    resourceAvailable;
  // Defense-in-depth over the SDK key/response binding: cached success data
  // (or a hook caller that did not pass expectedProjectId) could still name
  // a previous incarnation of the SAME slug. The selected Project record is
  // the owner of the answer — mismatch is a named blocked state, never a
  // dispatch and never a fallback to slug/path/local.
  const identityIncarnationMismatch = Boolean(
    portablePlacement &&
      identityLoaded &&
      typeof project?.id === 'string' &&
      projectIdentity?.association.localProjectId !== project.id,
  );
  const portableBlocked =
    portablePlacement && (!portableReady || identityIncarnationMismatch);
  const portableResourceName = portableReady
    ? (identityResources.find((resource) => resource.id === resourceId)?.name ??
      resourceId)
    : null;
  const resolvedModelId = model.trim() || selectedTarget?.defaultModel || '';
  const resolvedModelName = resolvedModelId
    ? (selectedTarget?.models.find(
        (option) =>
          option.id === resolvedModelId ||
          option.originalId === resolvedModelId,
      )?.name ?? resolvedModelId)
    : null;
  const environmentUnavailable = Boolean(
    projectDefaultsUnavailable ||
      (selectedEnvironment &&
        (!selectedEnvironment.profile.environmentId ||
          !selectedEnvironment.profile.verifiedProjectPath)),
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !selectedTarget?.ready ||
      !prompt.trim() ||
      environmentUnavailable ||
      portableBlocked ||
      sshProjectBlocked ||
      isDiscovering ||
      discoveryError
    )
      return;
    // Capture every intent scalar BEFORE the await: a late Home/authority
    // switch must refuse the dispatch, never redirect it, and a stale
    // response after the await must not open a result for the new scope.
    // apiBase + requestScope are frozen as immutable PER-INVOCATION values
    // (scalars only — never the isCurrent function or any credential) and
    // passed through the SDK transport's authority guards, so a rotation
    // across the awaits refuses instead of dispatching the old intent under
    // new credentials, and a late hook re-render cannot redirect it.
    const capturedScope = requestScope;
    const invocationScope = isApiRequestScope(capturedScope)
      ? {
          apiBase: capturedScope.apiBase,
          authorityKey: capturedScope.authorityKey,
        }
      : undefined;
    const invocationApiBase = invocationScope?.apiBase ?? apiBase;
    const capturedPrompt = prompt.trim();
    const capturedEnvironmentId = environmentId;
    const capturedTargetId = selectedTarget.id;
    const capturedTargetName = selectedTarget.name;
    const capturedModel = model.trim();
    const capturedParentTaskId = parentTaskId;
    const capturedWorkspace = projectSlug
      ? portablePlacement && portableProjectId && resourceId
        ? {
            kind: 'project-portable' as const,
            portableProjectId,
            resourceId,
          }
        : { kind: 'project' as const, projectSlug }
      : undefined;
    if (capturedScope?.isCurrent() === false) {
      setAuthorityStale(true);
      return;
    }
    try {
      const task = await mutation.mutateAsync({
        input: {
          prompt: capturedPrompt,
          target: {
            environment:
              capturedEnvironmentId === 'current'
                ? { kind: 'current' }
                : { kind: 'saved', id: toEnvironmentId(capturedEnvironmentId) },
            agent: capturedTargetId,
            ...(capturedModel ? { model: { override: capturedModel } } : {}),
            ...(capturedWorkspace ? { workspace: capturedWorkspace } : {}),
          },
          ...(capturedParentTaskId
            ? { parentTaskId: capturedParentTaskId }
            : {}),
        },
        apiBase: invocationApiBase,
        ...(invocationScope ? { requestScope: invocationScope } : {}),
      });
      if (capturedScope?.isCurrent() === false) {
        // The dispatch already happened under the captured authority; the
        // late UI effect must not: keep the draft and name the staleness.
        setAuthorityStale(true);
        return;
      }
      onDelegated(task, capturedTargetName);
    } catch {
      // React Query exposes the actionable error inline and keeps the draft,
      // Project/resource and machine choice: no automatic redispatch, and a
      // transport failure is never labeled 'not offered'.
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
  // a `PageFrame`) and `SessionsView`'s Activity placement (a plain sibling of
  // `SplitPaneLayout`, inside the frame `PageFrame` marks `inert` while that
  // layout's mobile detail sheet is open — PageFrame.tsx:155). This is a
  // hand-rolled overlay, not a `ResponsiveDialogSurface` consumer, so unlike
  // the other sites in this class it never had a shared portal to inherit;
  // rendered in place on the Activity surface it fell inside the inert subtree, visible
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
                {[
                  resolvedModelName,
                  selectedEnvironmentName,
                  portableResourceName,
                ]
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
          {(projectDefaultsUnavailable || portableProjectUnavailable) && (
            <p
              className="delegation-launcher__hint"
              role={
                projectFailed || portableProjectInvalid ? 'alert' : 'status'
              }
            >
              {portableProjectUnavailable
                ? portableProjectInvalid
                  ? 'Project details could not be verified. Retry before placing this task.'
                  : 'Checking Project details before placing this task.'
                : projectFailed
                  ? 'Project execution defaults could not be loaded.'
                  : 'Checking Project execution defaults before choosing a Station.'}
              {(projectFailed || portableProjectInvalid) && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => void retryProject()}
                >
                  Retry Project
                </Button>
              )}
            </p>
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
          {sshProjectBlocked && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{PORTABLE_SSH_UNSUPPORTED_NOTICE}</span>
              <span className="delegation-launcher__hint">
                {PORTABLE_SSH_UNSUPPORTED_GUIDANCE}
              </span>
            </div>
          )}
          {portableIdentityPending && (
            <p className="delegation-launcher__hint" role="status">
              {PORTABLE_IDENTITY_NOTICE}
            </p>
          )}
          {portableIdentityMissing && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{PORTABLE_IDENTITY_MISSING_NOTICE}</span>
              <span className="delegation-launcher__hint">
                {PORTABLE_IDENTITY_SETUP_GUIDANCE}
              </span>
              <button type="button" onClick={() => void retryIdentity()}>
                Retry Project identity
              </button>
            </div>
          )}
          {portableIdentityDenied && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{PORTABLE_IDENTITY_DENIED_NOTICE}</span>
              <span className="delegation-launcher__hint">
                {PORTABLE_IDENTITY_DENIED_GUIDANCE}
              </span>
              <button type="button" onClick={() => void retryIdentity()}>
                Retry Project identity
              </button>
            </div>
          )}
          {portableIdentityUnavailable && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{PORTABLE_IDENTITY_UNAVAILABLE_NOTICE}</span>
              <span className="delegation-launcher__hint">
                {PORTABLE_IDENTITY_UNAVAILABLE_GUIDANCE}
              </span>
              <button type="button" onClick={() => void retryIdentity()}>
                Retry Project identity
              </button>
            </div>
          )}
          {identityIncarnationMismatch && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{PORTABLE_IDENTITY_STALE_INCARNATION_NOTICE}</span>
              <button type="button" onClick={() => void retryIdentity()}>
                Retry Project identity
              </button>
            </div>
          )}
          {portableResourceMissing && (
            <div className="delegation-launcher__discovery-error" role="alert">
              <span>{PORTABLE_RESOURCE_MISSING_NOTICE}</span>
              <span className="delegation-launcher__hint">
                {PORTABLE_IDENTITY_SETUP_GUIDANCE}
              </span>
            </div>
          )}
          {portableResourceChoiceRequired && (
            <p className="delegation-launcher__hint" role="status">
              {PORTABLE_RESOURCE_CHOICE_NOTICE}
            </p>
          )}
          {portableReady && (
            <p className="delegation-launcher__hint" role="status">
              {PORTABLE_OFFER_UNVERIFIED_NOTICE}
            </p>
          )}
          {portablePlacement &&
            identityLoaded &&
            (identityResources.length > 1 || resourceChoiceUnavailable) && (
              <label className="delegation-launcher__resource">
                Project resource
                <select
                  aria-label="Project resource"
                  value={resourceId ?? ''}
                  onChange={(event) =>
                    setChosenResourceId(event.target.value || null)
                  }
                >
                  <option value="">Choose a resource…</option>
                  {resourceChoiceUnavailable && (
                    <option value={chosenResourceId!} disabled>
                      Selected resource is no longer available
                    </option>
                  )}
                  {identityResources.map((resource) => (
                    <option key={resource.id} value={resource.id}>
                      {resource.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          {authorityStale && (
            <p className="delegation-launcher__error" role="alert">
              {PORTABLE_AUTHORITY_STALE_NOTICE}
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
                      setEnvironmentId(event.target.value);
                      setTarget('');
                      setModel('');
                      setAuthorityStale(false);
                    }}
                  >
                    <option value="current">This Station</option>
                    {environmentId !== 'current' &&
                      !selectedEnvironment &&
                      !selectedPeer && (
                        <option value={environmentId}>
                          {environmentId} — saved environment
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
                        {peerStationLabel(peer)} — Paired Station
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
              environmentUnavailable ||
              portableBlocked ||
              sshProjectBlocked
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
