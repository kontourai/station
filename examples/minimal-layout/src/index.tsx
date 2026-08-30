import {
  type LayoutComponent,
  type LayoutComponentProps,
  useAgents,
  useNavigation,
  useToast,
} from '@kontourai/station-sdk';
import './layout.css';

/**
 * Minimal Workspace - Example plugin component
 *
 * Demonstrates basic SDK usage:
 * - Accessing agents via useAgents()
 * - Controlling chat dock via useNavigation()
 * - Showing notifications via useToast()
 */
function MinimalWorkspace({ layout, onShowChat }: LayoutComponentProps) {
  const agents = useAgents();
  const { setDockState } = useNavigation();
  const { showToast } = useToast();

  const handleOpenChat = () => {
    setDockState(true);
    onShowChat?.();
    showToast({
      type: 'info',
      message: 'Chat dock opened',
    });
  };

  return (
    <main className="minimal-shell">
      <section className="minimal-panel">
        <p className="minimal-kicker">Minimal plugin starter</p>
        <h1>{layout?.name || 'Minimal Layout'}</h1>
        <p>{layout?.description || 'A minimal layout plugin example'}</p>

        <div className="minimal-section">
          <h2>Discovered agents</h2>
          <p className="minimal-hint">
            Definitions can appear before their provider is connected or ready.
          </p>
          <ul>
            {agents.map((agent: { slug: string; name: string }) => (
              <li key={agent.slug}>
                {agent.name} ({agent.slug})
              </li>
            ))}
          </ul>
        </div>
        <div className="minimal-section">
          <button
            type="button"
            onClick={handleOpenChat}
            className="minimal-primary"
          >
            Open Chat Dock
          </button>
        </div>
      </section>
    </main>
  );
}

export const components = {
  'minimal-workspace': MinimalWorkspace,
} satisfies Record<string, LayoutComponent>;

export default MinimalWorkspace;
