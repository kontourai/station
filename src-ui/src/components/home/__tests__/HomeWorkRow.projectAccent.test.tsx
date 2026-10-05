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

function swatchFor(task: HomeWorkItem): HTMLElement | null {
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
          chrome: 'pointer',
          projectAccentBySlug: new Map([['station', 'var(--accent-orange)']]),
        },
      })}
    </ul>,
  );
  return container.querySelector<HTMLElement>('.inbox-row__project-accent');
}

describe("Home rows take a project's colour only for this Station's projects", () => {
  afterEach(cleanup);

  const [local] = buildHomeWorkItems({
    chats: {},
    agents: [],
    sessions: [summary],
  });

  test('a local row whose project is known wears its colour', () => {
    expect(local.projectSlug).toBe('station');
    expect(swatchFor(local)).not.toBeNull();
  });

  test("a remote row with the same slug names another Station's project, so it has no colour", () => {
    const remote: HomeWorkItem = {
      ...local,
      id: 'remote:peer-1:accent-row',
      orchestrationThreadId: undefined,
      environmentId: 'peer-1',
      environmentLabel: 'Peer Station',
    };
    expect(swatchFor(remote)).toBeNull();
  });
});
