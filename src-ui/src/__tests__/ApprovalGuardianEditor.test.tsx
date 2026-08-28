/** @vitest-environment jsdom */

import type { SettingDefinition } from '@kontourai/station-contracts/settings-registry';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ApprovalGuardianEditor } from '../views/settings/ApprovalGuardianEditor';

const definition = {
  key: 'approvalGuardian',
  scope: 'station',
  descriptor: { kind: 'composite' },
  label: 'Approval guardian',
  description: 'Optional AI review layer for approval-bound tool calls.',
} as unknown as SettingDefinition;

describe('ApprovalGuardianEditor', () => {
  test('disabled by default: only the enable toggle is shown', () => {
    render(
      <ApprovalGuardianEditor
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('switch', { name: 'Approval guardian' }),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Guardian mode')).toBeNull();
  });

  test('toggling enabled on calls onChange with enabled: true, preserving other fields', () => {
    const onChange = vi.fn();
    render(
      <ApprovalGuardianEditor
        definition={definition}
        value={{ model: 'existing-model' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Approval guardian' }));
    expect(onChange).toHaveBeenCalledWith({
      model: 'existing-model',
      enabled: true,
    });
  });

  // archive#1831: the instructions field holds a PROMPT. It must be sized for
  // one and offer a realistic starting point that ADDS a house rule to the
  // guardian's built-in prompt instead of restating its decision rules.
  test('instructions textarea is sized for a prompt and offers a house-rule starting point', () => {
    render(
      <ApprovalGuardianEditor
        definition={definition}
        value={{ enabled: true }}
        onChange={vi.fn()}
      />,
    );
    const textarea = screen.getByLabelText(
      'Guardian instructions',
    ) as HTMLTextAreaElement;
    expect(textarea.rows).toBeGreaterThanOrEqual(6);
    expect(textarea.placeholder.length).toBeGreaterThan(20);
    // DEFAULT_GUARDIAN_PROMPT already owns the allow/deny/defer decision
    // rules — the placeholder must suggest something it does not say.
    expect(textarea.placeholder).not.toMatch(/return "?(allow|deny|defer)"?/i);
  });

  test('enabled: true reveals mode/model/instructions and edits merge into the existing config', () => {
    const onChange = vi.fn();
    render(
      <ApprovalGuardianEditor
        definition={definition}
        value={{ enabled: true, mode: 'review' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Guardian mode'), {
      target: { value: 'enforce' },
    });
    expect(
      screen
        .getByLabelText('Guardian mode')
        .classList.contains('editor-select'),
    ).toBe(true);
    expect(onChange).toHaveBeenCalledWith({ enabled: true, mode: 'enforce' });

    fireEvent.change(screen.getByLabelText('Guardian model'), {
      target: { value: 'anthropic.claude-3-5-sonnet' },
    });
    expect(
      screen
        .getByLabelText('Guardian model')
        .classList.contains('editor-input'),
    ).toBe(true);
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      mode: 'review',
      model: 'anthropic.claude-3-5-sonnet',
    });

    fireEvent.change(screen.getByLabelText('Guardian instructions'), {
      target: { value: 'Be strict.' },
    });
    expect(
      screen
        .getByLabelText('Guardian instructions')
        .classList.contains('editor-textarea'),
    ).toBe(true);
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      mode: 'review',
      instructions: 'Be strict.',
    });
  });
});
