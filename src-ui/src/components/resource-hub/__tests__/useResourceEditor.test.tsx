/**
 * @vitest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { navigationStore } from '../../../contexts/navigation-store';
import { useResourceEditor } from '../useResourceEditor';

interface Resource {
  id: string;
  name: string;
}

function Editor({
  source,
  saving = false,
}: {
  source: Resource | null;
  saving?: boolean;
}) {
  const editor = useResourceEditor<Resource>({
    source,
    identity: (resource) => resource.id,
    clone: (resource) => ({ ...resource }),
    isSaving: () => saving,
  });
  return (
    <>
      <output data-testid="draft">{editor.draft?.name ?? 'none'}</output>
      <output data-testid="dirty">{String(editor.dirty)}</output>
      <button
        type="button"
        onClick={() =>
          editor.update((current) => ({ ...current, name: 'Edited' }))
        }
      >
        Edit
      </button>
      <button
        type="button"
        onClick={() => editor.saved({ id: 'a', name: 'Saved' })}
      >
        Saved
      </button>
      <button type="button" onClick={editor.reset}>
        Reset
      </button>
      <button
        type="button"
        onClick={() => navigationStore.navigate('/connections/engines/a/usage')}
      >
        Same resource tab
      </button>
      <button
        type="button"
        onClick={() => navigationStore.navigate('/elsewhere')}
      >
        Leave
      </button>
      <editor.DiscardModal />
    </>
  );
}

const draft = () => screen.getByTestId('draft').textContent;
const dirty = () => screen.getByTestId('dirty').textContent;

afterEach(() => {
  // Leave no guard registered for the next test.
  if (screen.queryByText('Unsaved Changes'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
});

describe('useResourceEditor', () => {
  test('seeds from the source, and an edit makes it dirty', () => {
    render(<Editor source={{ id: 'a', name: 'Server' }} />);
    expect([draft(), dirty()]).toEqual(['Server', 'false']);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect([draft(), dirty()]).toEqual(['Edited', 'true']);
  });

  test('a refetch of the same resource keeps unsaved edits; a different one re-seeds', () => {
    const { rerender } = render(
      <Editor source={{ id: 'a', name: 'Server' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    rerender(<Editor source={{ id: 'a', name: 'Refetched' }} />);
    expect([draft(), dirty()]).toEqual(['Edited', 'true']);
    rerender(<Editor source={{ id: 'b', name: 'Other' }} />);
    expect([draft(), dirty()]).toEqual(['Other', 'false']);
  });

  test('a clean draft follows a refetch', () => {
    const { rerender } = render(
      <Editor source={{ id: 'a', name: 'Server' }} />,
    );
    rerender(<Editor source={{ id: 'a', name: 'Refetched' }} />);
    expect([draft(), dirty()]).toEqual(['Refetched', 'false']);
  });

  test('saved makes the result the clean copy, before any refetch', () => {
    render(<Editor source={{ id: 'a', name: 'Server' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
    expect([draft(), dirty()]).toEqual(['Saved', 'false']);
  });

  test('reset returns to the server copy', () => {
    render(<Editor source={{ id: 'a', name: 'Server' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect([draft(), dirty()]).toEqual(['Server', 'false']);
  });

  test('while dirty, leaving asks; a route change within the resource does not', () => {
    act(() => navigationStore.navigate('/connections/engines/a'));
    render(<Editor source={{ id: 'a', name: 'Server' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Same resource tab' }));
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
    expect(window.location.pathname).toBe('/connections/engines/a/usage');
    expect(draft()).toBe('Edited');

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    expect(window.location.pathname).toBe('/connections/engines/a/usage');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(window.location.pathname).toBe('/elsewhere');
    // Discard discarded: the draft is the server copy again.
    expect([draft(), dirty()]).toEqual(['Server', 'false']);
  });

  test('Discard waits while a save is in flight', () => {
    act(() => navigationStore.navigate('/connections/engines/a'));
    const { rerender } = render(
      <Editor source={{ id: 'a', name: 'Server' }} saving />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // Refused: the save may still land, so the edit and the route stay.
    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    expect(window.location.pathname).toBe('/connections/engines/a');
    expect([draft(), dirty()]).toEqual(['Edited', 'true']);

    rerender(<Editor source={{ id: 'a', name: 'Server' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(window.location.pathname).toBe('/elsewhere');
    expect([draft(), dirty()]).toEqual(['Server', 'false']);
  });

  test('Back between tabs of the same record does not ask', async () => {
    act(() => navigationStore.navigate('/connections/engines/a'));
    act(() => navigationStore.navigate('/connections/engines/a/settings'));
    render(<Editor source={{ id: 'a', name: 'Server' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    act(() => window.history.back());
    await waitFor(() =>
      expect(window.location.pathname).toBe('/connections/engines/a'),
    );
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
    expect(draft()).toBe('Edited');
  });

  test('a clean editor registers no guard', () => {
    act(() => navigationStore.navigate('/connections/engines/a'));
    render(<Editor source={{ id: 'a', name: 'Server' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
    expect(window.location.pathname).toBe('/elsewhere');
  });
});
