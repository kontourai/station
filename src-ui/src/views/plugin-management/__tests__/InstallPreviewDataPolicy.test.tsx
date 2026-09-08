/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { InstallPreviewModal } from '../InstallPreviewModal';

test('installation preserves data by default and requires an explicit reset choice', () => {
  const confirm = vi.fn();
  render(
    <InstallPreviewModal
      previewData={{
        valid: true,
        existingDataScope: true,
        components: [],
        conflicts: [],
      }}
      previewSkips={new Set()}
      installPending={false}
      onClose={vi.fn()}
      onToggleSkip={vi.fn()}
      onConfirm={confirm}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
  expect(confirm).toHaveBeenLastCalledWith('preserve');
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'Start with new data and retain the current data separately',
    }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm Install with New Data' }),
  );
  expect(confirm).toHaveBeenLastCalledWith('retain-and-reset');
});
