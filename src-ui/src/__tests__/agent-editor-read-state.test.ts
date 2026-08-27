import { describe, expect, test } from 'vitest';
import { resolveAgentEditorReadState } from '../views/agent-editor/agentEditorReadState';

describe('agent editor read state', () => {
  test('blocks editing when the initial entity read fails', () => {
    expect(
      resolveAgentEditorReadState({
        hasLoadedAgent: false,
        loadError: new Error('Failed to fetch agent'),
        isLoading: false,
        isFetching: false,
        isCreating: false,
      }),
    ).toMatchObject({
      blockingLoadError: 'Failed to fetch agent',
      notFound: false,
      visibleRefreshError: null,
    });
  });

  test('keeps a previously loaded form visible when only refresh fails', () => {
    expect(
      resolveAgentEditorReadState({
        hasLoadedAgent: true,
        loadError: new Error('Connection lost'),
        isLoading: false,
        isFetching: false,
        isCreating: false,
      }),
    ).toMatchObject({
      blockingLoadError: null,
      notFound: false,
      visibleRefreshError: 'Connection lost',
    });
  });

  test('routes an explicit missing entity to the not-found state', () => {
    expect(
      resolveAgentEditorReadState({
        hasLoadedAgent: false,
        loadError: 'Agent not found',
        isLoading: false,
        isFetching: false,
        isCreating: false,
      }),
    ).toMatchObject({
      blockingLoadError: null,
      notFound: true,
    });
  });
});
