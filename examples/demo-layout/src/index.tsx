import {
  useAgents,
  useAuth,
  useNavigation,
  type WorkspaceComponentProps,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import './layout.css';

function Welcome({ onShowChat }: WorkspaceComponentProps) {
  const agents = useAgents();
  const { status, provider, user } = useAuth();
  const { setDockState } = useNavigation();
  const authSummary =
    provider || status !== 'valid'
      ? `${status}${provider ? ` (${provider})` : ''}`
      : 'Local session';

  return (
    <main className="demo-shell">
      <h1 className="demo-title">👋 Welcome to Station</h1>
      <p className="demo-intro">
        This example plugin demonstrates agent discovery, authentication state,
        chat navigation, and local notes.
      </p>

      <div className="demo-card-grid">
        <Card title="🤖 Agents" value={`${agents.length} discovered`}>
          <p className="demo-card-copy">
            A discovered definition may still need a connected provider.
          </p>
          <ul className="demo-agent-list">
            {agents.map((a) => (
              <li key={a.slug}>
                {a.name} ({a.slug})
              </li>
            ))}
          </ul>
        </Card>

        <Card title="🔐 Auth" value={authSummary}>
          <p className="demo-card-copy demo-card-copy--flush">
            {provider && user?.alias
              ? `Signed in as ${user.name || user.alias}`
              : user?.alias
                ? `Your profile: ${user.name || user.alias}`
                : provider
                  ? 'No provider identity configured'
                  : 'No external auth provider configured'}
          </p>
        </Card>
      </div>

      <div className="demo-action-row">
        <button
          type="button"
          onClick={() => {
            setDockState(true);
            onShowChat?.();
          }}
          className="demo-primary"
        >
          💬 Open Chat
        </button>
      </div>

      <section className="demo-next-steps">
        <strong>Getting Started</strong>
        <ol>
          <li>
            Install a plugin:{' '}
            <code>station plugin install &lt;path-or-url&gt;</code>
          </li>
          <li>Review any requested permissions in System → Plugins</li>
          <li>Add its layout from the project layout picker</li>
        </ol>
      </section>
    </main>
  );
}

function Notes() {
  const [notes, setNotes] = useState(() => {
    try {
      return localStorage.getItem('station-demo-notes') || '';
    } catch {
      return '';
    }
  });

  const save = (value: string) => {
    setNotes(value);
    try {
      localStorage.setItem('station-demo-notes', value);
    } catch {}
  };

  return (
    <main className="demo-notes">
      <h2>📝 Notes</h2>
      <textarea
        value={notes}
        onChange={(e) => save(e.target.value)}
        placeholder="Type your notes here..."
        className="demo-notes-input"
      />
    </main>
  );
}

function Card({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="demo-card">
      <div className="demo-card-label">{title}</div>
      <div className="demo-card-value">{value}</div>
      {children}
    </section>
  );
}

export const components = {
  'demo-layout-welcome': Welcome,
  'demo-layout-notes': Notes,
};

export default Welcome;
