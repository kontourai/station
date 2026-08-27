import { Empty, FilteredEmpty } from '../../components/state';
import { getScheduleStarterTemplates } from './utils';

export function ScheduleEmptyState({
  filterText,
  onSelectTemplate,
  onClearFilter,
}: {
  filterText: string;
  onSelectTemplate: (template: {
    name: string;
    cron: string;
    prompt: string;
  }) => void;
  onClearFilter: () => void;
}) {
  if (filterText) {
    return (
      <FilteredEmpty
        query={filterText}
        noun="scheduled jobs"
        variant="prominent"
        onClear={onClearFilter}
      />
    );
  }

  return (
    <Empty
      variant="prominent"
      label="No scheduled jobs yet. Pick a template to get started:"
      action={
        <>
          <div className="schedule__starters">
            {getScheduleStarterTemplates().map((template) => (
              <button
                type="button"
                key={template.name}
                onClick={() =>
                  onSelectTemplate({
                    name: template.name,
                    cron: template.cron,
                    prompt: template.prompt,
                  })
                }
                className="schedule__starter-btn"
              >
                <div className="schedule__starter-label">{template.label}</div>
                <div className="schedule__starter-meta">{template.meta}</div>
              </button>
            ))}
          </div>
          <p className="schedule__starter-hint">
            Templates pre-fill the form — you choose the agent and schedule.
          </p>
        </>
      }
    />
  );
}
