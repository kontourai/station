// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

function Form() {
  const [disabled, setDisabled] = useState(false);
  return (
    <ProjectIconPicker
      name="Demo"
      value=""
      iconDisabled={disabled}
      onChange={(_, next) => setDisabled(next ?? false)}
      onUseDetected={() => setDisabled(false)}
      candidates={[
        {
          relativePath: 'favicon.png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          mediaType: 'image/png',
          source: 'favicon',
        },
      ]}
      fetching={false}
      idPrefix="pending"
    />
  );
}

test('detected and hidden choices reflect the pending form selection', () => {
  render(<Form />);
  const detected = screen.getByRole('button', { name: 'Use detected icon' });
  const none = screen.getByRole('button', { name: 'No icon' });
  expect(detected.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByText(/Without one/)).toBeNull();
  fireEvent.click(none);
  expect(none.getAttribute('aria-pressed')).toBe('true');
  expect(detected.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(detected);
  expect(none.getAttribute('aria-pressed')).toBe('false');
  expect(detected.getAttribute('aria-pressed')).toBe('true');
});
