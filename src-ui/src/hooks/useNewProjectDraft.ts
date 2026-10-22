import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import { useEffect } from 'react';
import {
  deriveProjectSlug,
  inferProjectNameFromPath,
  normalizeWorkingDirectory,
} from '../components/modals/project-form-utils';
import { useProjectDraftState } from './useProjectDraftState';

function useProjectDraftValues(partition?: string) {
  const [name, setName] = useProjectDraftState('', partition);
  const [icon, setIcon] = useProjectDraftState('', partition);
  const [description, setDescription] = useProjectDraftState('', partition);
  const [directory, setDirectory] = useProjectDraftState('', partition);
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
    repositoryAcquisition,
    setRepositoryAcquisition,
    icon,
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
export function useNewProjectDraft(isOpen: boolean, partition?: string) {
  const draft = useProjectDraftValues(partition);
  const normalizedDirectory = normalizeWorkingDirectory(draft.directory);
  const derivedName = inferProjectNameFromPath(normalizedDirectory);
  const reset = () => {
    draft.setName('');
    draft.setIcon('');
    draft.setDescription('');
    draft.setDefaultEnvironment({ kind: 'current' });
    draft.setDirectory('');
    draft.setRepositoryAcquisition(null);
    draft.setNameTouched(false);
    draft.setShowIconChoices(false);
  };

  useDraftReset(isOpen, reset);
  // #3552: "Add a project for this folder" opens New project at
  // `/projects/new?directory=<folder>`, with that folder already chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per opening.
  useEffect(() => {
    if (!isOpen) return;
    const requested = new URLSearchParams(window.location.search).get(
      'directory',
    );
    if (requested) draft.setDirectory(requested);
  }, [isOpen]);
  useDerivedProjectName(isOpen, draft.nameTouched, draft.setName, derivedName);

  // The name and slug the submission will carry, derived once here so the
  // pre-POST duplicate check and the request itself cannot disagree.
  const resolvedName = draft.name.trim() || derivedName;

  return {
    ...draft,
    derivedName,
    derivedSlug: deriveProjectSlug(resolvedName),
    normalizedDirectory,
    resolvedName,
  };
}
