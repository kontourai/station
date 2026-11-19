import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import type { ProjectStartIntent } from '@kontourai/station-contracts/project';
import { useEffect } from 'react';
import {
  deriveProjectSlug,
  inferProjectNameFromPath,
  normalizeWorkingDirectory,
} from '../components/modals/project-form-utils';
import {
  PROJECT_CONTINUATION_PARAM,
  readProjectContinuationDraft,
} from '../lib/continue-in-project';
import type { ProjectRecoveryScope } from '../lib/project-onboarding-recovery';
import { useProjectDraftState } from './useProjectDraftState';

function useProjectDraftValues(partition?: string) {
  const [name, setName] = useProjectDraftState('', partition);
  const [icon, setIcon] = useProjectDraftState('', partition);
  const [iconDisabled, setIconDisabled] = useProjectDraftState(
    false,
    partition,
  );
  const [description, setDescription] = useProjectDraftState('', partition);
  const [directory, setDirectory] = useProjectDraftState('', partition);
  const [startIntent, setStartIntent] =
    useProjectDraftState<ProjectStartIntent>('blank', partition);
  const [repositoryAcquisition, setRepositoryAcquisition] =
    useProjectDraftState<{
      id: string;
      directory: string;
      recoveryKey: string;
    } | null>(null, partition);
  const [nameTouched, setNameTouched] = useProjectDraftState(false, partition);
  const [showIconChoices, setShowIconChoices] = useProjectDraftState(
    false,
    partition,
  );
  const [defaultEnvironment, setDefaultEnvironment] =
    useProjectDraftState<EnvironmentRef>({ kind: 'current' }, partition);

  return {
    description,
    defaultEnvironment,
    directory,
    startIntent,
    setStartIntent,
    repositoryAcquisition,
    setRepositoryAcquisition,
    icon,
    iconDisabled,
    setIconDisabled,
    name,
    nameTouched,
    setDescription,
    setDefaultEnvironment,
    setDirectory,
    setIcon,
    setName,
    setNameTouched,
    setShowIconChoices,
    showIconChoices,
  };
}

function useDraftReset(isOpen: boolean, reset: () => void) {
  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);
}

function useDerivedProjectName(
  isOpen: boolean,
  nameTouched: boolean,
  setName: (name: string) => void,
  derivedName: string,
) {
  useEffect(() => {
    if (isOpen && !nameTouched) setName(derivedName);
  }, [derivedName, isOpen, nameTouched, setName]);
}

/** Form-only state. Starter selection and submission live in dedicated hooks. */
export function useNewProjectDraft(
  isOpen: boolean,
  partition?: string,
  scope?: ProjectRecoveryScope,
) {
  const draft = useProjectDraftValues(partition);
  const [continuationId, setContinuationId] = useProjectDraftState<
    string | null
  >(null, partition);
  const normalizedDirectory = normalizeWorkingDirectory(draft.directory);
  const derivedName = inferProjectNameFromPath(normalizedDirectory);
  const reset = () => {
    setContinuationId(null);
    draft.setName('');
    draft.setIcon('');
    draft.setIconDisabled(false);
    draft.setDescription('');
    draft.setDefaultEnvironment({ kind: 'current' });
    draft.setDirectory('');
    draft.setStartIntent('blank');
    draft.setRepositoryAcquisition(null);
    draft.setNameTouched(false);
    draft.setShowIconChoices(false);
  };

  useDraftReset(isOpen, reset);
  useDerivedProjectName(isOpen, draft.nameTouched, draft.setName, derivedName);
  // #3552: "Add a project for this folder" opens New project at
  // `/projects/new?directory=<folder>`, with that folder already chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefill once per opening and draft partition so typing cannot reload it.
  useEffect(() => {
    if (!isOpen || window.location.pathname !== '/projects/new') return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get(PROJECT_CONTINUATION_PARAM);
    const prefill =
      token === null
        ? {
            name: params.get('name'),
            description: params.get('description'),
            directory: params.get('directory'),
          }
        : scope
          ? readProjectContinuationDraft(scope, token)
          : undefined;
    setContinuationId(prefill ? token : null);
    if (!prefill) return;
    if (prefill.name) {
      draft.setName(prefill.name);
      draft.setNameTouched(true);
    }
    if (prefill.description) draft.setDescription(prefill.description);
    if (prefill.directory) {
      draft.setStartIntent('workspace');
      draft.setDirectory(prefill.directory);
    }
  }, [isOpen, partition]);

  // The name and slug the submission will carry, derived once here so the
  // pre-POST duplicate check and the request itself cannot disagree.
  const resolvedName = draft.name.trim() || derivedName;

  return {
    ...draft,
    continuationId,
    derivedName,
    derivedSlug: deriveProjectSlug(resolvedName),
    normalizedDirectory,
    resolvedName,
  };
}
