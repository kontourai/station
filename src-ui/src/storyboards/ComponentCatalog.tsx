import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '../components/Button';
import { DisclosureToggle } from '../components/DisclosureToggle';
import { Empty, ErrorState, SkeletonList } from '../components/state';
import '../index.css';
import '../tailwind.css';
import './component-catalog.css';
import { ActionRowStory, SettingsControlStory } from './ControlsStories';

const sources = Object.keys(
  import.meta.glob(
    [
      '../**/*.tsx',
      '!../storyboards/**',
      '../../../packages/{sdk,connect,basis-pane,board-pane}/src/**/*.tsx',
      '!**/__tests__/**',
      '!**/*.test.tsx',
      '!**/*.spec.tsx',
    ],
    { query: '?url', import: 'default' },
  ),
).sort();

const stories = [
  {
    id: 'inbox',
    title: 'Inbox Task rows',
    files: ['../components/chat-dock/ChatDockInboxRows.tsx'],
  },
  {
    id: 'button',
    title: 'Buttons',
    files: [
      '../components/Button.tsx',
      '../../../packages/sdk/src/components/ActionControl.tsx',
    ],
  },
  {
    id: 'disclosure',
    title: 'Disclosure',
    files: ['../components/DisclosureToggle.tsx'],
  },
  {
    id: 'action-row',
    title: 'Action rows and overflow menus',
    files: [
      '../components/ActionRow.tsx',
      '../components/ActionOverflowMenu.tsx',
    ],
  },
  {
    id: 'settings-controls',
    title: 'Settings controls',
    files: [
      '../components/Toggle.tsx',
      '../components/IconButton.tsx',
      '../components/ProvenanceBadge.tsx',
    ],
  },
  {
    id: 'states',
    title: 'Empty, error and loading states',
    files: [
      '../components/Skeleton.tsx',
      '../components/state/Empty.tsx',
      '../components/state/ErrorState.tsx',
      '../../../packages/sdk/src/components/ErrorState.tsx',
    ],
  },
];

const storyBySource = new Map(
  stories.flatMap((story) => story.files.map((path) => [path, story] as const)),
);

function Catalog() {
  const [query, setQuery] = useState('');
  const [gapsOnly, setGapsOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [light, setLight] = useState(false);
  const [phone, setPhone] = useState(false);
  const [result, setResult] = useState('');
  const [retrying, setRetrying] = useState(false);
  const visible = sources.filter(
    (source) =>
      source.toLowerCase().includes(query.trim().toLowerCase()) &&
      (!gapsOnly || !storyBySource.has(source)),
  );
  const covered = sources.filter((source) => storyBySource.has(source)).length;

  return (
    <>
      <h1>Station UI catalog</h1>
      <div className="catalog-controls">
        <Button
          variant="ghost"
          aria-pressed={phone}
          onClick={() => setPhone(!phone)}
        >
          Phone width
        </Button>
        <Button
          variant="ghost"
          aria-pressed={light}
          onClick={() => {
            document.documentElement.dataset.theme = light ? 'dark' : 'light';
            setLight(!light);
          }}
        >
          Light theme
        </Button>
      </div>
      <nav aria-label="Component stories">
        <ul>
          {stories.map((story) => (
            <li key={story.id}>
              <a href={`#${story.id}`}>{story.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div
        className={
          phone
            ? 'catalog-examples catalog-examples--phone'
            : 'catalog-examples'
        }
      >
        <section id="inbox">
          <h2>Inbox Task rows</h2>
          <p>
            Compare the current rows and the layout proposal with the same
            fixtures.
          </p>
          <a href="/inbox-storyboard.html">Open Inbox comparison</a>
        </section>
        <section id="button">
          <h2>Buttons</h2>
          <div className="catalog-controls">
            <Button onClick={() => setResult('Changes saved')}>
              Save changes
            </Button>
            <Button
              variant="secondary"
              onClick={() => setResult('Editing paused')}
            >
              Pause
            </Button>
          </div>
          <Button disabled>Unavailable</Button>
          <p role="status">{result}</p>
        </section>
        <section id="disclosure">
          <h2>Disclosure</h2>
          <DisclosureToggle
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            controls="catalog-disclosure"
          >
            Snoozed · 2
          </DisclosureToggle>
          <ul id="catalog-disclosure" hidden={!expanded}>
            <li>Review release notes</li>
            <li>Check the nightly report</li>
          </ul>
        </section>
        <section id="action-row">
          <h2>Action rows and overflow menus</h2>
          <ActionRowStory />
        </section>
        <section id="settings-controls">
          <h2>Settings controls</h2>
          <SettingsControlStory />
        </section>
        <section id="states">
          <h2>Empty, error and loading states</h2>
          <SkeletonList count={2} label="Loading Tasks" />
          <Empty variant="compact" label="No open Tasks" />
          <ErrorState
            variant="compact"
            title="Could not load Tasks"
            action={
              <Button variant="secondary" onClick={() => setRetrying(true)}>
                Retry
              </Button>
            }
          />
          {retrying && <p role="status">Retry started</p>}
        </section>
      </div>
      <section>
        <h2>UI source inventory</h2>
        <p>
          {covered} of {sources.length} TSX files mapped to a story. The list
          includes composed views and implementation files.
        </p>
        <label>
          Filter source files{' '}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={gapsOnly}
            onChange={(event) => setGapsOnly(event.target.checked)}
          />{' '}
          Unmapped only
        </label>
        <details open>
          <summary>{visible.length} matching files</summary>
          <ul className="catalog-inventory">
            {visible.map((source) => {
              const story = storyBySource.get(source);
              return (
                <li key={source}>
                  <code>{source.replace(/^\.\.\/(?:\.\.\/\.\.\/)?/, '')}</code>
                  {story ? (
                    <a href={`#${story.id}`}>{story.title}</a>
                  ) : (
                    <span>Unmapped</span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      </section>
    </>
  );
}

const root = document.getElementById('root');
if (import.meta.env.DEV && root) createRoot(root).render(<Catalog />);
