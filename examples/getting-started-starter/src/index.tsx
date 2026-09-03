import {
  useAgents,
  useNavigation,
  useToast,
  type WorkspaceComponentProps,
} from '@kontourai/station-sdk';
import './layout.css';

function GettingStartedHome({ onShowChat }: WorkspaceComponentProps) {
  const agents = useAgents();
  const { setDockState } = useNavigation();
  const { showToast } = useToast();

  const openChat = () => {
    setDockState(true);
    onShowChat?.();
    showToast({
      type: 'info',
      message: 'Chat dock opened from the starter plugin.',
    });
  };

  return (
    <main className="starter-shell starter-shell--home">
      <section className="starter-intro">
        <p className="starter-kicker">Default Workspace Pane starter</p>
        <h1>Build a useful workspace first.</h1>
        <p>
          This starter keeps the plugin small while showing the SDK hooks most
          UI plugins need on day one: agents, navigation, chat, and toasts.
        </p>
        <button className="starter-primary" type="button" onClick={openChat}>
          Open chat dock
        </button>
      </section>

      <section className="starter-panel" aria-label="Discovered agents">
        <h2>Discovered agents</h2>
        <p className="starter-panel__hint">
          Definitions appear here before every provider is connected or ready.
        </p>
        {agents.length > 0 ? (
          <ul className="starter-list">
            {agents.map((agent) => (
              <li key={agent.slug}>
                <span>{agent.name}</span>
                <code>{agent.slug}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No agent definitions were discovered.</p>
        )}
      </section>
    </main>
  );
}

function SDKPatterns() {
  return (
    <main className="starter-shell">
      <section className="starter-panel starter-panel--wide">
        <h1>SDK patterns to copy</h1>
        <div className="starter-grid">
          <article>
            <h2>Read Station context</h2>
            <p>
              Use SDK hooks to read agents and project context instead of
              calling app internals directly.
            </p>
          </article>
          <article>
            <h2>Control chat deliberately</h2>
            <p>
              Open the dock from explicit user actions so the host shell stays
              predictable.
            </p>
          </article>
          <article>
            <h2>Keep state local first</h2>
            <p>
              Start with component state or local storage, then graduate to
              plugin providers when the data has a real lifecycle.
            </p>
          </article>
        </div>
      </section>
    </main>
  );
}

export const components = {
  'getting-started-home': GettingStartedHome,
  'getting-started-patterns': SDKPatterns,
};

export default GettingStartedHome;
