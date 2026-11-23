import type { OutsideClientReviewAction } from '@kontourai/station-sdk';
import { Field, Select } from '@kontourai/ui/react';
import { type RefObject, useId, useState } from 'react';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';

type ScopeAction = Extract<
  OutsideClientReviewAction,
  { operation: 'approve' | 'change' }
>;

export type OutsideClientScopeTarget =
  | Pick<
      Extract<ScopeAction, { operation: 'approve' }>,
      'operation' | 'requestId' | 'clientId' | 'expectedRequestFingerprint'
    >
  | (Pick<
      Extract<ScopeAction, { operation: 'change' }>,
      'operation' | 'grantId' | 'expectedVersion' | 'expectedDigest'
    > & {
      currentProjectId: string;
      currentExpiry: number;
    });

const hour = 60 * 60 * 1000;
const durations = [
  { value: hour, label: '1 hour' },
  { value: 24 * hour, label: '1 day' },
  { value: 7 * 24 * hour, label: '7 days' },
];

export function OutsideClientScopeReview({
  formId,
  target,
  scopeForm,
  onSubmit,
}: {
  formId: string;
  target: OutsideClientScopeTarget;
  scopeForm: RefObject<HTMLFormElement | null>;
  onSubmit: (action: ScopeAction) => void;
}) {
  const id = useId();
  const projects = useScopedProjectsQuery();
  const [chosenProject, setChosenProject] = useState<string>();
  const [duration, setDuration] = useState('');
  const currentProjectId =
    target.operation === 'change' ? target.currentProjectId : '';
  const projectId = chosenProject ?? currentProjectId;
  const project = projects.data?.find((entry) => entry.id === projectId);
  const scope =
    projectId === 'global'
      ? { kind: 'global' as const }
      : project && projects.isSuccess
        ? {
            kind: 'project' as const,
            slug: project.slug,
            expectedId: project.id,
          }
        : undefined;
  const [openedAt] = useState(Date.now);
  const expiryCeiling =
    target.operation === 'change' ? target.currentExpiry : Infinity;
  const options = durations.filter(
    ({ value }) => openedAt + value < expiryCeiling,
  );

  return (
    <form
      id={formId}
      ref={scopeForm}
      className="content-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!scope || !duration) return;
        const expiresAt =
          duration === 'keep'
            ? expiryCeiling
            : Math.min(Date.now() + Number(duration), expiryCeiling);
        const selection = {
          project: scope,
          accessLevel: 'read-only' as const,
          expiresAt,
        };
        if (target.operation === 'approve') {
          onSubmit({ ...target, ...selection, supersessions: [] });
        } else {
          onSubmit({
            operation: 'change',
            grantId: target.grantId,
            expectedVersion: target.expectedVersion,
            expectedDigest: target.expectedDigest,
            ...selection,
          });
        }
      }}
    >
      <Field label="Scope" htmlFor={`${id}-scope`}>
        <Select
          id={`${id}-scope`}
          required
          value={projectId === 'global' || project ? projectId : ''}
          onChange={(event) => setChosenProject(event.target.value)}
        >
          <option value="">Choose a scope</option>
          <option value="global">Work outside Projects</option>
          {projects.isSuccess &&
            projects.data?.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name || entry.slug}
              </option>
            ))}
        </Select>
      </Field>
      {projects.isError && (
        <p role="status">Project scopes are temporarily unavailable.</p>
      )}
      <Field label="Expires after" htmlFor={`${id}-expiry`}>
        <Select
          id={`${id}-expiry`}
          required
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
        >
          <option value="">Choose an expiry</option>
          {target.operation === 'change' && (
            <option value="keep">Keep current expiry</option>
          )}
          {options.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
    </form>
  );
}
