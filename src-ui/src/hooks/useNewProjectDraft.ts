import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import { useEffect, useState } from 'react';
import {
  deriveProjectSlug,
  inferProjectNameFromPath,
  normalizeWorkingDirectory,
} from '../components/modals/project-form-utils';

function useProjectDraftValues() {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [description, setDescription] = useState('');
  const [directory, setDirectory] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [showIconChoices, setShowIconChoices] = useState(false);
  const [defaultEnvironment, setDefaultEnvironment] = useState<EnvironmentRef>({
    kind: 'current',
  });

  return {
    description,
    defaultEnvironment,
    directory,
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
export function useNewProjectDraft(isOpen: boolean) {
  const draft = useProjectDraftValues();
  const normalizedDirectory = normalizeWorkingDirectory(draft.directory);
  const derivedName = inferProjectNameFromPath(normalizedDirectory);
  const reset = () => {
    draft.setName('');
    draft.setIcon('');
    draft.setDescription('');
    draft.setDefaultEnvironment({ kind: 'current' });
    draft.setDirectory('');
    draft.setNameTouched(false);
    draft.setShowIconChoices(false);
  };

  useDraftReset(isOpen, reset);
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
