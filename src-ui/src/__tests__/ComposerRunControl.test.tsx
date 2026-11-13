// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ComposerChoice } from '../components/ComposerChoice';
import { ComposerRunControl } from '../components/ComposerRunControl';

afterEach(cleanup);

test('one setup button names current choices, opens every picker, and tracks changes', () => {
  const choose = vi.fn();
  const view = (approval: string) => (
    <ComposerRunControl label="Writer · Sonnet" icon={<span>marks</span>}>
      {[
        'Agent: Writer',
        'Model: Sonnet',
        `Approval: ${approval}`,
        'Session mode: Plan',
      ].map((label) => (
        <ComposerChoice
          key={label.split(':')[0]}
          aria-label={label}
          caption={label.split(':')[0]}
          value={label.split(':')[1]}
          onClick={choose}
        />
      ))}
    </ComposerRunControl>
  );
  const result = render(view('Ask'));
  const trigger = screen.getByTestId('run-setup-trigger');
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(trigger.getAttribute('aria-label')).toContain(
    'Writer · Sonnet; Ask; Plan',
  );
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Run setup' })).toBeTruthy();
  for (const name of [
    'Agent: Writer',
    'Model: Sonnet',
    'Approval: Ask',
    'Session mode: Plan',
  ])
    fireEvent.click(screen.getByRole('button', { name }));
  expect(choose).toHaveBeenCalledTimes(4);
  result.rerender(view('Set by engine'));
  fireEvent.click(screen.getByRole('button', { name: 'Close run setup' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(trigger.getAttribute('aria-label')).toContain('Set by engine');
  expect(trigger.getAttribute('aria-label')).not.toContain('; Ask');
});

test('omits absent controls and keeps the visible label first', () => {
  render(
    <ComposerRunControl label="Choose agent" icon={null}>
      <span />
    </ComposerRunControl>,
  );
  expect(
    screen.getByTestId('run-setup-trigger').getAttribute('aria-label'),
  ).toBe('Choose agent');
  expect(screen.getByTestId('run-setup-trigger').textContent?.trim()).toBe(
    'Choose agent',
  );
});
test('exposes exceptional safety state on the closed trigger', () => {
  const view = (safetyLabel?: string) => (
    <ComposerRunControl label="Writer" icon={null}>
      <ComposerChoice
        caption="Approval"
        value="Ask"
        aria-label="Approval: Ask"
        safetyLabel={safetyLabel}
      />
    </ComposerRunControl>
  );
  const result = render(view('Approval pending; Conversation override'));
  const trigger = screen.getByTestId('run-setup-trigger');
  expect(trigger.textContent).toContain('⚠');
  expect(trigger.getAttribute('aria-label')).toContain(
    'Approval pending; Conversation override',
  );
  result.rerender(view());
  expect(trigger.textContent).not.toContain('⚠');
});
