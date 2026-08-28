import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  AgentEditorLoadFailureState,
  AgentEditorLoadingState,
  AgentEditorNotFoundState,
  AgentEditorStartingPoints,
} from '../views/agent-editor/AgentEditorStateViews';

describe('agent editor state views', () => {
  // the detail pane used to render the bare string "Loading
  // agent..." — one of eleven loading treatments across 28 routes. It now
  // renders the shared region skeleton, and the wait names itself in the
  // accessible label rather than as visible one-off copy.
  test('AgentEditorLoadingState renders the shared region skeleton', () => {
    const markup = renderToStaticMarkup(createElement(AgentEditorLoadingState));
    expect(markup).toContain('skeleton-block');
    expect(markup).toContain('aria-label="Loading agent"');
    expect(markup).not.toContain('Loading agent...');
  });

  test('AgentEditorNotFoundState renders the recovery action', () => {
    expect(
      renderToStaticMarkup(
        createElement(AgentEditorNotFoundState, {
          selectedSlug: 'planner',
          onDeselect: () => {},
        }),
      ),
    ).toContain(
      'The agent &quot;planner&quot; doesn&#x27;t exist or was deleted.',
    );
  });

  test('AgentEditorLoadFailureState renders retry and escape actions', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditorLoadFailureState, {
        selectedSlug: 'planner',
        error: 'Failed to fetch agent',
        onRetry: () => {},
        onDeselect: () => {},
      }),
    );

    expect(markup).toContain('Couldn’t load agent');
    expect(markup).toContain('Failed to fetch agent');
    expect(markup).toContain('Retry');
    expect(markup).toContain('Back to agents');
  });

  test('AgentEditorStartingPoints renders engine-shaped starting points', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditorStartingPoints, {
        onStartModel: () => {},
        onStartCli: () => {},
        onCopy: () => {},
        copyDisabled: false,
      }),
    );

    expect(markup).toContain('Chat with a model');
    expect(markup).toContain('Wrap an installed agent CLI');
    expect(markup).toContain('Copy an existing agent');
  });

  // §4: nothing to copy is a DISABLED card that says so, not a card that
  // opens an empty picker.
  test('AgentEditorStartingPoints disables Copy when there is nothing to copy', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditorStartingPoints, {
        onStartModel: () => {},
        onStartCli: () => {},
        onCopy: () => {},
        copyDisabled: true,
      }),
    );

    expect(markup).toContain('You have no agents to copy yet.');
    expect(markup).toContain('disabled=""');
  });
});
