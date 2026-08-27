import { useProjectsQuery } from '@kontourai/station-sdk';
import { AgentEditorIdentityFields } from './AgentEditorIdentityFields';
import { AgentEditorProjectOwnership } from './AgentEditorProjectOwnership';
import type { AgentEditorFormProps } from './types';

type BasicTabProps = Pick<
  AgentEditorFormProps,
  'form' | 'setForm' | 'isCreating' | 'locked' | 'validationErrors'
>;

export function AgentEditorBasicTab(props: BasicTabProps) {
  const { data: projects = [] } = useProjectsQuery() as {
    data?: Array<{ slug: string; name: string }>;
  };

  return (
    <div className="agent-editor__section">
      <AgentEditorIdentityFields {...props} />
      <AgentEditorProjectOwnership
        form={props.form}
        setForm={props.setForm}
        locked={props.locked}
        projects={projects}
      />
    </div>
  );
}
