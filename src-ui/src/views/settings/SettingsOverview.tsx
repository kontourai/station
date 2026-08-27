interface SettingsOverviewProps {
  connectionName?: string;
  validationIssueCount: number;
  hasUnsavedChanges: boolean;
  hrefForView: (view: string) => string;
  onNavigate: (view: string) => void;
}

const SUMMARY_CARDS = [
  {
    view: 'station-config',
    eyebrow: 'Station',
    title: 'Station configuration',
    description: 'Core behavior, approvals, registries, and host diagnostics.',
  },
  {
    view: 'agent-defaults',
    eyebrow: 'Defaults',
    title: 'Agent starting points',
    description:
      'Models, agent instructions, region, and turn limits used by default.',
  },
  {
    view: 'appearance',
    eyebrow: 'This device',
    title: 'Personal experience',
    description: 'Theme, accessibility, notifications, voice, and shortcuts.',
  },
  {
    view: 'knowledge',
    eyebrow: 'Knowledge',
    title: 'Personal knowledge store',
    description: 'Connect the information Station can use across your work.',
  },
] as const;

export function SettingsOverview({
  connectionName,
  validationIssueCount,
  hasUnsavedChanges,
  hrefForView,
  onNavigate,
}: SettingsOverviewProps) {
  const ready = validationIssueCount === 0;
  return (
    <section
      id="section-overview"
      className="settings-overview"
      aria-labelledby="settings-overview-title"
    >
      <div className="settings-overview__hero">
        <div>
          <div className="settings-overview__eyebrow">Overview</div>
          <h2 id="settings-overview-title">
            {ready ? 'Your settings are ready' : 'Settings need attention'}
          </h2>
          <p>
            See what applies to the Station, your defaults, and this device,
            then jump directly to the setting you need.
          </p>
        </div>
        <span
          className={`settings-overview__health settings-overview__health--${ready ? 'ready' : 'attention'}`}
        >
          {ready ? 'Ready' : 'Review needed'}
        </span>
      </div>

      <div className="settings-overview__stats">
        <div className="settings-overview__stat">
          <span>Station</span>
          <strong>{connectionName || 'Current Station'}</strong>
        </div>
        <div className="settings-overview__stat">
          <span>Validation</span>
          <strong>
            {validationIssueCount === 0
              ? 'No issues'
              : `${validationIssueCount} issue${validationIssueCount === 1 ? '' : 's'}`}
          </strong>
        </div>
        <div className="settings-overview__stat">
          <span>Changes</span>
          <strong>{hasUnsavedChanges ? 'Unsaved' : 'All saved'}</strong>
        </div>
      </div>

      <div className="settings-overview__cards">
        {SUMMARY_CARDS.map((card) => (
          <a
            key={card.view}
            className="settings-overview__card"
            href={hrefForView(card.view)}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(card.view);
            }}
          >
            <span>{card.eyebrow}</span>
            <strong>{card.title}</strong>
            <p>{card.description}</p>
            <em>Open settings →</em>
          </a>
        ))}
      </div>
    </section>
  );
}
