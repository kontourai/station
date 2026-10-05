// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { HomeWorkItem } from '../../../views/home/home-view-model';
import { buildHomeWorkItems } from '../../../views/home/home-view-model';
import { buildWorkFacts } from '../../../views/home/work-facts';
import { renderHomeWorkRow } from '../HomeWorkRow';

const AT = '2026-08-24T12:00:00.000Z';

const summary = {
  provider: 'bedrock',
  threadId: 'accent-row',
  status: 'ready',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  createdAt: AT,
  updatedAt: AT,
  isLoaded: true,
  isPersisted: true,
  eventCount: 2,
  lifecycleState: 'completed',
  hasActiveTurn: false,
  projectSlug: 'station',
} satisfies OrchestrationSessionSummary as OrchestrationSessionSummary;

/** The row's project mark (icon or colour swatch), if it draws one. */
function markFor(
  task: HomeWorkItem,
  icons: ReadonlyMap<string, string> = new Map(),
): HTMLElement | null {
  const sessions = [summary];
  const items = buildHomeWorkItems({ chats: {}, agents: [], sessions });
  const { container } = render(
    <ul>
      {renderHomeWorkRow({
        task: { ...task, stableId: task.id },
        isWoken: false,
        agents: [],
        onOpen: () => {},
        context: {
          now: Date.parse(AT),
          workFacts: buildWorkFacts({ items, sessions }),
          detailsFor: null,
          setDetailsFor: () => {},
          chrome: 'hover',
          projectAccentBySlug: new Map([['station', 'var(--accent-orange)']]),
          projectIconBySlug: icons,
        },
      })}
    </ul>,
  );
  return container.querySelector<HTMLElement>('.inbox-row__project-accent');
}

describe("Home rows take a project's colour and icon only for this Station's projects", () => {
  afterEach(cleanup);

  const icons = new Map([['station', '🚀']]);
  const [local] = buildHomeWorkItems({
    chats: {},
    agents: [],
    sessions: [summary],
  });
  // The same thread, read from a peer Station: built by the real writer so
  // the remote item has exactly the shape Home renders.
  const remote = buildHomeWorkItems({
    chats: {},
    agents: [],
    sessions: [],
    remoteEnvironments: [
      {
        environmentId: 'peer-1',
        environmentName: 'Peer Station',
        sessions: [summary],
      },
    ],
  }).find((item) => item.environmentId === 'peer-1');

  test('a local row whose project is known wears its colour', () => {
    expect(local.projectSlug).toBe('station');
    const mark = markFor(local);
    expect(mark?.dataset.projectIcon).toBe('dot');
  });

  test('a local row whose project has an icon wears the icon', () => {
    const mark = markFor(local, icons);
    expect(mark).not.toBeNull();
    expect(mark?.classList.contains('project-icon--icon')).toBe(true);
    expect(mark?.textContent).toContain('🚀');
  });

  test("a remote row with the same slug names another Station's project, so it has neither colour nor icon", () => {
    expect(remote).toBeDefined();
    expect(remote?.projectSlug).toBe('station');
    expect(remote?.environmentId).toBe('peer-1');
    expect(markFor(remote as HomeWorkItem, icons)).toBeNull();
  });
});
