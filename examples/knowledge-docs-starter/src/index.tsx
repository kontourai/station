import {
  type LayoutComponent,
  useNavigation,
  type WorkspaceComponentProps,
} from '@kontourai/station-sdk';
import './layout.css';

const documents = [
  { name: 'product-brief.md', status: 'indexed', chunks: 12 },
  { name: 'support-runbook.md', status: 'indexed', chunks: 8 },
  { name: 'api-reference.md', status: 'pending review', chunks: 18 },
];

function KnowledgeLibrary() {
  return (
    <main className="docs-shell">
      <section className="docs-panel docs-panel--wide">
        <div className="docs-heading">
          <h1>Document library</h1>
          <span className="docs-sample-badge">Sample data</span>
        </div>
        <p>
          These placeholder documents demonstrate an intake queue. Connect a
          provider to display real sources and indexing status.
        </p>
        <ul className="docs-list">
          {documents.map((document) => (
            <li key={document.name}>
              <span>{document.name}</span>
              <code>
                {document.status} / {document.chunks} chunks
              </code>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function KnowledgeAsk({ onShowChat }: WorkspaceComponentProps) {
  const { setDockState } = useNavigation();

  const askQuestion = () => {
    setDockState(true);
    onShowChat?.();
  };

  return (
    <main className="docs-shell">
      <section className="docs-panel docs-panel--wide">
        <div className="docs-heading">
          <h1>Ask the docs</h1>
          <span className="docs-sample-badge">Starter pattern</span>
        </div>
        <p>
          Route source-backed questions to chat while keeping the visible
          workspace focused on document scope and citation quality.
        </p>
        <button className="docs-primary" type="button" onClick={askQuestion}>
          Ask with selected sources
        </button>
      </section>
    </main>
  );
}

function KnowledgeSources() {
  return (
    <main className="docs-shell">
      <section className="docs-panel docs-panel--wide">
        <div className="docs-heading">
          <h1>Source coverage</h1>
          <span className="docs-sample-badge">Starter pattern</span>
        </div>
        <div className="docs-grid">
          <article>
            <h2>Freshness</h2>
            <p>Show when each source was indexed or synced.</p>
          </article>
          <article>
            <h2>Confidence</h2>
            <p>Separate cited answers from unsupported summaries.</p>
          </article>
          <article>
            <h2>Ownership</h2>
            <p>Keep document stewards visible during review.</p>
          </article>
        </div>
      </section>
    </main>
  );
}

export const components = {
  'knowledge-library': KnowledgeLibrary,
  'knowledge-ask': KnowledgeAsk,
  'knowledge-sources': KnowledgeSources,
} satisfies Record<string, LayoutComponent>;

export default KnowledgeLibrary;
