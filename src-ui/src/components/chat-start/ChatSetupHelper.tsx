import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import type { AgentData } from '../../contexts/AgentsContext';
import { openExternalLink } from '../../platform/openExternalLink';
import { type AgentFixRoute, AgentReadinessCell } from '../AgentReadinessCell';
import { Button } from '../Button';

/** Setup guidance reads server prerequisites; installation and sign-in remain explicit actions. */
export function ChatSetupHelper({
  agents,
  connections,
  devicePresentation,
  busy,
  onRepair,
  onSetup,
  onModels,
  onCheck,
}: {
  agents: AgentData[];
  connections: AgentConnectionView[];
  devicePresentation?: DevicePresentation;
  busy: boolean;
  onRepair: (agent: AgentData, route: AgentFixRoute) => void;
  onSetup: (agent?: AgentData) => void;
  onModels: () => void;
  onCheck: () => void;
}) {
  return (
    <section className="chat-start__setup" aria-label="Set up an AI connection">
      <div className="chat-start__recent-heading">
        <h4>Let’s connect your AI</h4>
        <Button variant="link" pending={busy} onClick={onCheck}>
          Check again
        </Button>
      </div>
      <p>
        Connect an AI app or a model account. Your message stays here while you
        finish setup.
      </p>
      {agents.map((agent) => {
        const connection = connections.find(
          (entry) => entry.id === agent.execution?.agentConnectionId,
        );
        const prerequisites =
          connection?.prerequisites.filter(
            (item) => item.status !== 'installed',
          ) ?? [];
        return (
          <div className="chat-start__setup-agent" key={agent.slug}>
            <strong>{agent.name}</strong>
            <AgentReadinessCell
              agent={agent}
              agentName={agent.name}
              devicePresentation={devicePresentation}
              fixDisabled={busy}
              onFix={(route) => onRepair(agent, route)}
            />
            {prerequisites.map((item) => (
              <details key={item.id}>
                <summary>{item.name}</summary>
                <p>{item.description}</p>
                {item.installGuide && (
                  <>
                    <ol>
                      {item.installGuide.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    {item.installGuide.commands?.map((command) => (
                      <pre key={command}>
                        <code>{command}</code>
                      </pre>
                    ))}
                    {item.installGuide.links?.map((link) => (
                      <Button
                        key={link}
                        variant="link"
                        onClick={() => void openExternalLink(link)}
                      >
                        Open installation guide
                      </Button>
                    ))}
                  </>
                )}
              </details>
            ))}
            {(connection?.type === 'claude' ||
              connection?.type === 'codex') && (
              <Button variant="link" onClick={() => onSetup(agent)}>
                Sign in or manage accounts
              </Button>
            )}
          </div>
        );
      })}
      <div className="chat-start__controls">
        <Button onClick={() => onSetup()}>Set up an AI app</Button>
        <Button variant="link" onClick={onModels}>
          Connect a model account
        </Button>
      </div>
      <p>
        Apps run on the computer hosting Station. Follow its installation guide
        there, then return to recheck detection and sign-in.
      </p>
    </section>
  );
}
