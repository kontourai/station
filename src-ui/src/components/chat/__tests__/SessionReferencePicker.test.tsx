// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { composerDisplayValue } from '../composer-mentions';
import { SessionReferencePicker } from '../SessionReferencePicker';

const CANDIDATES = [
  { id: 'earlier', title: 'Earlier work', projectSlug: 'other-project' },
];

describe('SessionReferencePicker', () => {
  test('stages an authorized cross-project link token without transcript data', () => {
    const onChange = vi.fn();
    render(
      <SessionReferencePicker
        value="compare "
        candidates={CANDIDATES}
        activeConversationId="current"
        authority="authority-1"
        isCurrent={() => true}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Reference a conversation' }),
    );
    fireEvent.click(screen.getByRole('option', { name: /Earlier work/ }));
    const persisted = onChange.mock.calls[0]?.[0] as string;
    expect(composerDisplayValue(persisted)).toBe('compare @Earlier work ');
    expect(persisted).toContain('other-project');
    expect(persisted).not.toContain('transcript');
  });

  test('the disabled affordance and handler share the revoked-scope refusal', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SessionReferencePicker
        value=""
        candidates={CANDIDATES}
        authority="authority-1"
        isCurrent={() => true}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Reference a conversation' }),
    );
    rerender(
      <SessionReferencePicker
        value=""
        candidates={CANDIDATES}
        authority="authority-1"
        isCurrent={() => false}
        onChange={onChange}
      />,
    );
    const option = screen.getByRole('option', { name: /Earlier work/ });
    expect((option as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });
});
