/**
 * @vitest-environment jsdom
 *
 * docs/design/event-content-spill.md: a plan whose entries, or one entry's
 * text, are stored out of line shows the previews, then the whole plan once
 * the person loads it. The artifact comes from the real canonical builder
 * the `plan.updated` handler uses; the SDK query is a controllable stand-in.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  isSessionTape,
  tapeFromSessionEvents,
} from '../hooks/orchestration/replay/tape';

const query = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@kontourai/station-sdk/runtime-event-content', () => ({
  useResolvedRuntimeEventValueQuery: () => ({
    data: query.data,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../components/chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children?: string }) => <div>{children}</div>,
}));

const { WorkflowPlanPanel, toWorkflowPlanArtifact } = await import(
  '../components/flow/WorkflowPlanPanel'
);
const { canonicalPlanArtifact } = await import('../utils/planArtifacts');

const LONG_STEP = 'Migrate every caller of the old API. '.repeat(800);
const ref = (preview: string, char = 'a') => ({
  $stationContent: 1,
  ref: `sha256-${char.repeat(64)}`,
  kind: 'string',
  bytes: LONG_STEP.length,
  length: LONG_STEP.length,
  preview,
});

afterEach(cleanup);
beforeEach(() => {
  query.data = undefined;
});

describe('a plan stored out of line', () => {
  test('an entry whose text is a reference shows its preview as text, then the whole step on load', () => {
    const entries = [
      { content: 'Read the plan', status: 'completed' },
      { content: ref('Migrate every caller…'), status: 'in_progress' },
    ];
    const artifact = canonicalPlanArtifact(
      entries,
      '2026-10-26T00:00:00.000Z',
      'thread-plan',
    );
    // A label is text, never the reference object.
    expect(artifact.steps.map((step) => typeof step.content)).toEqual([
      'string',
      'string',
    ]);
    expect(artifact.spilled).toEqual({ threadId: 'thread-plan', entries });
    query.data = [
      { content: 'Read the plan', status: 'completed' },
      { content: LONG_STEP, status: 'in_progress' },
    ];
    const view = render(
      <WorkflowPlanPanel artifact={toWorkflowPlanArtifact(artifact)} />,
    );
    expect(view.container.textContent).not.toContain('$stationContent');
    expect(view.container.textContent).not.toContain(LONG_STEP.trim());
    fireEvent.click(screen.getByRole('button', { name: 'Load full content' }));
    expect(view.container.textContent).toContain(LONG_STEP.trim());
    expect(
      screen.queryByRole('button', { name: 'Load full content' }),
    ).toBeNull();
  });

  test('a whole-list reference loads into steps', () => {
    const artifact = canonicalPlanArtifact(
      ref('[{"content":"Step one"…', 'b'),
      '2026-10-26T00:00:00.000Z',
      'thread-plan',
    );
    expect(artifact.steps).toEqual([]);
    query.data = [
      { content: 'Step one', status: 'completed' },
      { content: 'Step two', status: 'pending' },
    ];
    const view = render(
      <WorkflowPlanPanel artifact={toWorkflowPlanArtifact(artifact)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load full content' }));
    expect(view.container.textContent).toContain('Step two');
  });

  test('an inline plan offers no load action', () => {
    const artifact = canonicalPlanArtifact(
      [{ content: 'Read the plan', status: 'pending' }],
      '2026-10-26T00:00:00.000Z',
      'thread-plan',
    );
    expect(artifact.spilled).toBeUndefined();
    render(<WorkflowPlanPanel artifact={toWorkflowPlanArtifact(artifact)} />);
    expect(
      screen.queryByRole('button', { name: 'Load full content' }),
    ).toBeNull();
  });

  test('a replay tape accepts an entry whose text is a reference', () => {
    // A tape as read from a file: untyped JSON in the recorded shape.
    const tapeWith = (content: unknown) => ({
      ...tapeFromSessionEvents(
        { threadId: 'thread-plan', agentSlug: 'acp' },
        [],
      ),
      events: [
        {
          eventId: 'e1',
          provider: 'acp',
          threadId: 'thread-plan',
          createdAt: '2026-10-26T00:00:00.000Z',
          method: 'plan.updated',
          entries: [{ content, status: 'pending' }],
        },
      ],
    });
    expect(isSessionTape(tapeWith(ref('Migrate…')))).toBe(true);
    expect(isSessionTape(tapeWith('Migrate'))).toBe(true);
    // The validator reaches the entry: other objects are still refused.
    expect(isSessionTape(tapeWith({ text: 'Migrate' }))).toBe(false);
  });
});
