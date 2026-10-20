import {
  type RelatedPanes,
  type RelatedPaneTarget,
  useRelatedPanes,
} from '@kontourai/station-sdk';
import type { createRelatedPanesPaneHost } from '@kontourai/station-sdk/workspace-pane';
import { useEffect, useState } from 'react';

const PLUGIN = 'related-reports';
const REPORT_PANE = `pane:plugin%3A${PLUGIN}:report`;
const LOG_PANE = `pane:plugin%3A${PLUGIN}:log`;

const REPORTS = [
  {
    key: 'weekly',
    title: 'Weekly report',
    body: 'Seven days of work, summarised.',
  },
  {
    key: 'monthly',
    title: 'Monthly report',
    body: 'The month at a glance.',
  },
] as const;

type Report = (typeof REPORTS)[number];
type RelatedHost = Pick<RelatedPanes, 'open' | 'reveal' | 'close' | 'target'>;

/**
 * One controller for both tiers: a direct pane passes the SDK hook's host, a
 * sandboxed frame the client Station injects. Every outcome is a value; an
 * `unavailable` one keeps the report readable here rather than opening
 * nothing.
 */
function reportActions(
  host: RelatedHost,
  report: (
    status: string,
    inline: Report | null,
    handle?: string | null,
  ) => void,
) {
  let handle: string | null = null;
  return {
    async open(target: Report) {
      const outcome = await host.open({
        descriptorId: REPORT_PANE,
        modeId: 'project',
        key: target.key,
        title: target.title,
      });
      if (outcome.status === 'unavailable') {
        report(`${target.title} is shown here (${outcome.reason}).`, target);
        return;
      }
      handle = outcome.handle;
      report(
        `${target.title}: ${outcome.status}, ${outcome.presentation}.`,
        null,
        handle,
      );
    },
    async openLog() {
      const outcome = await host.open({
        descriptorId: LOG_PANE,
        modeId: 'project',
        key: 'log',
      });
      report(
        outcome.status === 'unavailable'
          ? `The log did not open (${outcome.reason}).`
          : `Report log: ${outcome.status}, ${outcome.presentation}.`,
        null,
      );
    },
    async reveal() {
      if (!handle) return;
      const outcome = await host.reveal(handle);
      report(
        outcome.status === 'unavailable'
          ? `Not revealed (${outcome.reason}).`
          : 'Report revealed.',
        null,
        handle,
      );
    },
    async close() {
      if (!handle) return;
      const outcome = await host.close(handle);
      if (outcome.status === 'closed') handle = null;
      report(
        outcome.status === 'unavailable'
          ? `Not closed (${outcome.reason}).`
          : 'Report closed.',
        null,
        handle,
      );
    },
  };
}

function Reports() {
  const related = useRelatedPanes();
  const [status, setStatus] = useState('');
  const [inline, setInline] = useState<Report | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [actions] = useState(() =>
    reportActions(related, (next, shown, opened) => {
      setStatus(next);
      setInline(shown);
      if (opened !== undefined) setHandle(opened);
    }),
  );
  return (
    <section aria-label="Related reports">
      <h2>Reports</h2>
      {!related.supported && (
        <p>This Station opens no related panes; a report opens here.</p>
      )}
      <ul>
        {REPORTS.map((report) => (
          <li key={report.key}>
            <button type="button" onClick={() => void actions.open(report)}>
              Open {report.title}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!handle}
        onClick={() => void actions.reveal()}
      >
        Reveal report
      </button>
      <button
        type="button"
        disabled={!handle}
        onClick={() => void actions.close()}
      >
        Close report
      </button>
      <button type="button" onClick={() => void actions.openLog()}>
        Open report log
      </button>
      <p role="status">{status}</p>
      {inline && <ReportBody report={inline} />}
    </section>
  );
}

function ReportBody({ report }: { report: Report }) {
  return (
    <article aria-label={report.title}>
      <h3>{report.title}</h3>
      <p>{report.body}</p>
    </article>
  );
}

/** A related report: it reads the target it was opened for from its host. */
function ReportPane() {
  const related = useRelatedPanes();
  const [target, setTarget] = useState<RelatedPaneTarget | null>();
  useEffect(() => {
    let current = true;
    void related.target().then((value) => {
      if (current) setTarget(value);
    });
    return () => {
      current = false;
    };
  }, [related]);
  if (target === undefined) return <p role="status">Reading the report…</p>;
  const report = REPORTS.find((candidate) => candidate.key === target?.key);
  return report ? (
    <ReportBody report={report} />
  ) : (
    <p>No report was opened here. Open one from Reports.</p>
  );
}

function ReportLog() {
  return (
    <section aria-label="Report log">
      <h2>Report log</h2>
      <p>A tool Reports opened; it stays with the Tools.</p>
    </section>
  );
}

export const components = {
  reports: Reports,
  report: ReportPane,
  log: ReportLog,
};

export default Reports;

/*
 * The sandboxed tier. A Station that runs this plugin in an isolated frame
 * shares no React or SDK with it, so the frame draws plain DOM, with the same
 * landmarks as the components above, and talks to the host through the client
 * the frame runtime injects. The frame does not say which component it is: a
 * frame opened as a related pane has a target and draws that report or the
 * log; otherwise it draws the list.
 */
declare global {
  interface Window {
    __stationPaneHostOrigin?: string;
    __stationCreateRelatedPanesPaneHost?: typeof createRelatedPanesPaneHost;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function landmark<K extends 'article' | 'section'>(
  tag: K,
  label: string,
  ...children: HTMLElement[]
) {
  const node = element(tag);
  node.setAttribute('aria-label', label);
  node.append(...children);
  return node;
}

function reportElement(report: Report) {
  return landmark(
    'article',
    report.title,
    element('h3', report.title),
    element('p', report.body),
  );
}

async function mountFrame() {
  const origin = window.__stationPaneHostOrigin;
  const createHost = window.__stationCreateRelatedPanesPaneHost;
  const root = document.getElementById('app');
  if (!origin || !createHost || !root) return;
  const host = createHost(window.parent, origin);
  window.addEventListener('pagehide', () => host.dispose(), { once: true });
  const target = await host.target();
  if (target?.descriptorId === LOG_PANE) {
    root.append(
      landmark(
        'section',
        'Report log',
        element('h2', 'Report log'),
        element('p', 'A tool Reports opened; it stays with the Tools.'),
      ),
    );
    return;
  }
  const opened = REPORTS.find((report) => report.key === target?.key);
  if (opened) {
    root.append(reportElement(opened));
    return;
  }
  const status = element('p');
  status.setAttribute('role', 'status');
  const body = element('div');
  const actions = reportActions(host, (next, shown) => {
    status.textContent = next;
    body.replaceChildren(...(shown ? [reportElement(shown)] : []));
  });
  const list = landmark('section', 'Related reports', element('h2', 'Reports'));
  for (const report of REPORTS) {
    const button = element('button', `Open ${report.title}`);
    button.type = 'button';
    button.onclick = () => void actions.open(report);
    list.append(button);
  }
  for (const [label, act] of [
    ['Reveal report', actions.reveal],
    ['Close report', actions.close],
    ['Open report log', actions.openLog],
  ] as const) {
    const button = element('button', label);
    button.type = 'button';
    button.onclick = () => void act();
    list.append(button);
  }
  list.append(status, body);
  root.append(list);
}

// The frame runtime's injected client is the frame tier's mark. Its scripts
// run before the document's body exists, so the frame draws once it loads.
if (typeof window !== 'undefined' && window.__stationCreateRelatedPanesPaneHost)
  window.addEventListener('load', () => void mountFrame(), { once: true });
