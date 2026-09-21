import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { AgentEditorIdentityFields } from './AgentEditorIdentityFields';
import { AgentEditorProjectOwnership } from './AgentEditorProjectOwnership';
import type { AgentEditorFormProps } from './types';

type BasicTabProps = Pick<
  AgentEditorFormProps,
  'form' | 'setForm' | 'isCreating' | 'locked' | 'validationErrors'
>;

export function AgentEditorBasicTab(props: BasicTabProps) {
  const { data: projects = [] } = useScopedProjectsQuery() as {
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
