import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { lazy, Suspense, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { openExternalLink } from '../../platform/openExternalLink';
import { type AgentFixRoute, AgentReadinessCell } from '../AgentReadinessCell';
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
        <h4>Connect an engine or model</h4>
        <Button variant="link" pending={busy} onClick={onCheck}>
          Check again
        </Button>
      </div>
      <p>
        Set up an engine or add a model connection. Your message stays here.
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
              part={agent.slug === 'station' ? 'status' : 'both'}
              onFix={(route) => onRepair(agent, route)}
            />
            {agent.slug === 'station' && (
              <Button
                disabled={busy}
                onClick={() => setChoosingStationEngine(true)}
              >
                Choose AI for Station
              </Button>
            )}
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
      <div className="chat-start__controls">
        <Button onClick={() => onSetup()}>Set up an engine</Button>
        <Button variant="link" onClick={onModels}>
          Add a model connection
        </Button>
      </div>
      <p>
        Install engines on the computer running Station, then select Check
        again.
      </p>
    </section>
  );
}
