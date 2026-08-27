import {
  useNavigation,
  type WorkspaceComponentProps,
} from '@kontourai/station-sdk';
import './layout.css';

const files = [
  { path: 'src/app.ts', status: 'modified' },
  { path: 'src/runtime/session.ts', status: 'added' },
  { path: 'tests/session.spec.ts', status: 'added' },
];

function CodingWorkspace({ onShowChat }: WorkspaceComponentProps) {
  const { setDockState } = useNavigation();

  const askAboutCode = () => {
    setDockState(true);
    onShowChat?.();
  };

  return (
    <main className="coding-shell">
      <section className="coding-sidebar" aria-label="Files">
        <div className="coding-heading">
          <h1>Files</h1>
          <span className="coding-sample-badge">Sample data</span>
        </div>
        <p className="coding-supporting-copy">
          Replace these placeholders with files from your project provider.
        </p>
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              <span>{file.path}</span>
              <code>{file.status}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="coding-main">
        <section className="coding-terminal" aria-label="Terminal output">
          <div className="coding-terminal__bar">sample terminal output</div>
          <pre>{`$ npm test
PASS tests/session.spec.ts
3 tests passed`}</pre>
        </section>
        <button className="coding-primary" type="button" onClick={askAboutCode}>
          Ask agent about this workspace
        </button>
      </section>
    </main>
  );
}

function CodingDiffReview() {
  return (
    <main className="coding-shell coding-shell--diff">
      <section className="coding-main">
        <div className="coding-heading">
          <h1>Diff review</h1>
          <span className="coding-sample-badge">Sample data</span>
        </div>
        <p className="coding-supporting-copy">
          This preview demonstrates the review surface; it is not your current
          Git diff.
        </p>
        <section className="coding-diff" aria-label="Diff preview">
          <pre>{`+ export function createSession(input) {
+  return { id: crypto.randomUUID(), ...input };
 }`}</pre>
        </section>
        <div className="coding-review-grid">
          <article>
            <h2>Behavior</h2>
            <p>Describe expected user-visible behavior before editing.</p>
          </article>
          <article>
            <h2>Tests</h2>
            <p>Add focused tests next to the surface being changed.</p>
          </article>
          <article>
            <h2>Verification</h2>
            <p>Record command evidence in the final report.</p>
          </article>
        </div>
      </section>
    </main>
  );
}

export const components = {
  'coding-workspace': CodingWorkspace,
  'coding-diff-review': CodingDiffReview,
};

export default CodingWorkspace;
