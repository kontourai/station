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
  const trigger = screen.getByRole('button', { name: /^Run setup:/ });
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(trigger.getAttribute('aria-label')).toContain(
    'Agent: Writer; Model: Sonnet; Approval: Ask; Session mode: Plan',
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
  expect(trigger.getAttribute('aria-label')).toContain(
    'Approval: Set by engine',
  );
  expect(trigger.getAttribute('aria-label')).not.toContain('Approval: Ask');
});
