/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ScheduleEmptyState } from '../views/schedule/ScheduleEmptyState';
import { getScheduleStarterTemplates } from '../views/schedule/utils';

describe('ScheduleEmptyState', () => {
  test('a template opens the form with its readable name, schedule and prompt', () => {
    const onSelectTemplate = vi.fn();
    render(<ScheduleEmptyState onSelectTemplate={onSelectTemplate} />);
    const [digest] = getScheduleStarterTemplates();
    fireEvent.click(screen.getByRole('button', { name: /^Daily repo digest/ }));
    expect(onSelectTemplate).toHaveBeenCalledExactlyOnceWith({
      name: 'Daily repo digest',
      schedule: digest!.schedule,
      prompt: digest!.prompt,
    });
  });

  test('each template says what it does in words from its own prompt', () => {
    render(<ScheduleEmptyState onSelectTemplate={vi.fn()} />);
    for (const template of getScheduleStarterTemplates()) {
      const card = screen.getByRole('button', {
        name: new RegExp(`^${template.label}`),
      });
      expect(card.textContent).toContain(template.description);
      // The description restates the prompt's subject, not a new promise.
      const promptWords = new Set(
        template.prompt.toLowerCase().match(/[a-z]{5,}/g) ?? [],
      );
      const shared = (
        template.description.toLowerCase().match(/[a-z]{5,}/g) ?? []
      ).filter((word) => promptWords.has(word));
      expect(shared.length, template.name).toBeGreaterThanOrEqual(2);
    }
  });

  test('offers both ask-in-a-chat examples, word for word', () => {
    render(<ScheduleEmptyState onSelectTemplate={vi.fn()} />);
    const asks = document.querySelectorAll('.automations-empty__asks li');
    expect([...asks].map((item) => item.textContent?.trim())).toEqual([
      '“Every morning, tell me which tests failed overnight”',
      '“Remind me Friday to review open pull requests”',
    ]);
  });
});
