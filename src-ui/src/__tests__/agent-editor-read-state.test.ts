import { describe, expect, test } from 'vitest';
import { resolveAgentEditorReadState } from '../views/agent-editor/agentEditorReadState';

describe('agent editor read state', () => {
  test('blocks editing when the initial entity read fails', () => {
    expect(
      resolveAgentEditorReadState({
        hasLoadedAgent: false,
        loadError: new Error('Failed to fetch agent'),
        isPending: false,
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
        isPending: false,
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
        isPending: false,
        isFetching: false,
        isCreating: false,
      }),
    ).toMatchObject({
      blockingLoadError: null,
      notFound: true,
    });
  });

  test('keeps the initial read blocking throughout a retry delay', () => {
    expect(
      resolveAgentEditorReadState({
        hasLoadedAgent: false,
        loadError: null,
        isPending: true,
        // React Query is not fetching while it waits to retry, but the
        // initial detail question still has no answer.
        isFetching: false,
        isCreating: false,
      }),
    ).toMatchObject({
      blockingLoadError: null,
      editorIsLoading: true,
      notFound: false,
    });
  });
});
