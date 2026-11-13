// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectIconPicker } from '../components/project-icon/ProjectIconPicker';

afterEach(cleanup);
test('only No icon disables detection and detected artwork remains recoverable', () => {
  const onChange = vi.fn();
  const onUseDetected = vi.fn();
  render(
    <ProjectIconPicker
      name="Demo"
      value="🧭"
      onChange={onChange}
      onUseDetected={onUseDetected}
      candidates={[
        {
          relativePath: 'favicon.png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          mediaType: 'image/png',
          source: 'favicon',
        },
      ]}
      fetching={false}
      idPrefix="test"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'No icon' }));
  expect(onChange).toHaveBeenLastCalledWith('', true);
  fireEvent.change(screen.getByLabelText(/Emoji or symbol/), {
    target: { value: '' },
  });
  expect(onChange).toHaveBeenLastCalledWith('', false);
  fireEvent.click(screen.getByRole('button', { name: 'Use detected icon' }));
  expect(onUseDetected).toHaveBeenCalledOnce();
});
