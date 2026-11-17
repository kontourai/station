import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { lazy, Suspense, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { openExternalLink } from '../../platform/openExternalLink';
import { ActionRow } from '../ActionRow';
import { type AgentFixRoute, AgentReadinessCell } from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { Button } from '../Button';
import { SkeletonBlock } from '../state';

const EnginePicker = lazy(() =>
  import('../EnginePicker').then((module) => ({
    default: module.EnginePicker,
  })),
);

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
  const [choosingStationEngine, setChoosingStationEngine] = useState(false);
  return (
    <section className="chat-start__setup" aria-label="Set up an engine">
      <div className="chat-start__recent-heading">
        <h4>Connect an engine or model to start chatting</h4>
        <Button variant="link" pending={busy} onClick={onCheck}>
          Check again
        </Button>
      </div>
      <ul className="chat-start__setup-agents">
        {agents.map((agent) => {
          const connection = connections.find(
            (entry) => entry.id === agent.execution?.agentConnectionId,
          );
          const prerequisites =
            connection?.prerequisites.filter(
              (item) => item.status !== 'installed',
            ) ?? [];
          const runnability = agentRunnability(agent);
          const reason = runnability.runnable ? undefined : runnability.reason;
          const canSignIn =
            connection?.type === 'claude' || connection?.type === 'codex';
          return (
            <li className="chat-start__setup-agent" key={agent.slug}>
              <span className="chat-start__setup-agent-row">
                <strong>{agent.name}</strong>
                <AgentReadinessCell
                  agent={agent}
                  agentName={agent.name}
                  devicePresentation={devicePresentation}
                  fixDisabled={busy}
                  compact
                  part={agent.slug === 'station' ? 'status' : 'both'}
                  onFix={(route) => onRepair(agent, route)}
                />
                {agent.slug === 'station' && (
                  <Button
                    variant="link"
                    disabled={busy}
                    onClick={() => setChoosingStationEngine(true)}
                  >
                    Choose AI for Station
                  </Button>
                )}
              </span>
              {(reason || prerequisites.length > 0 || canSignIn) && (
                <details className="chat-start__setup-details">
                  <summary>Details</summary>
                  {reason && <p>{reason}</p>}
                  {prerequisites.map((item) => (
                    <div key={item.id}>
                      <p>
                        <strong>{item.name}</strong> {item.description}
                      </p>
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
                    </div>
                  ))}
                  {canSignIn && (
                    <Button variant="link" onClick={() => onSetup(agent)}>
                      Sign in or manage accounts
                    </Button>
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {choosingStationEngine && (
        <Suspense
          fallback={<SkeletonBlock count={1} label="Opening engine choices" />}
        >
          <EnginePicker
            title="Choose what powers the Station agent"
            description="Choose an engine or model connection for the Station agent."
            onDismiss={() => setChoosingStationEngine(false)}
            onChosen={() => {
              setChoosingStationEngine(false);
              onCheck();
            }}
          />
        </Suspense>
      )}
      <ActionRow
        className="chat-start__setup-actions"
        primary={
          <Button variant="primary" onClick={() => onSetup()}>
            Set up an engine
          </Button>
        }
        secondary={
          <Button variant="secondary" onClick={onModels}>
            Add a model connection
          </Button>
        }
        overflowLabel="More setup actions"
      />
    </section>
  );
}
