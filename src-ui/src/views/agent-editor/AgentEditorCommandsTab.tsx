import type { SlashCommand } from '@kontourai/station-contracts/agent';
import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import type { NavigationView } from '../../types';

const READONLY_TRAILER =
  "These authored commands are saved with the agent, but this engine won't deliver them.";

export function AgentEditorCommandsTab({
  commands,
  finding,
  onNavigate,
}: {
  commands: Record<string, SlashCommand>;
  finding?: AgentEngineValidationFinding;
  onNavigate: (view: NavigationView) => void;
}) {
  return (
    <div className="agent-editor__section">
      {finding && (
        <div className="agent-editor__capability-banner" role="status">
          {finding.message}. {READONLY_TRAILER}
        </div>
      )}
      <div className="editor-field">
        <div className="editor-label-row">
          <span className="editor-label">Authored commands</span>
          <button
            type="button"
            className="editor-enrich-btn"
            onClick={() => onNavigate({ type: 'guidance', tab: 'commands' })}
          >
            Browse command catalog
          </button>
        </div>
        <span className="editor-hint">
          Use Browse command catalog to inspect every available command.
        </span>
        <div className="editor__tools-list">
          {Object.entries(commands).map(([id, command]) => (
            <div className="editor__tools-item" key={id}>
              <div>
                <strong>/{command.name || id}</strong>
                {command.description && <div>{command.description}</div>}
              </div>
              <pre className="editor-hint">{command.prompt}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
