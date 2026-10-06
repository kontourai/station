/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SkillRunModal } from '../components/modals/SkillRunModal';

const agents = [{ slug: 'station', name: 'Station' }];

function renderModal(
  props: Partial<Parameters<typeof SkillRunModal>[0]> & {
    skill: { name: string; body: string };
  },
) {
  return render(
    <SkillRunModal
      isOpen
      variables={[]}
      agents={agents}
      onRun={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />,
  );
}

// the Test modal runs the SAME substitution the slash handler
// runs — defaults apply, a variable with neither a value nor a default is
// rejected with an inline error naming it, and entered values do not survive
// closing the modal or switching skills.
describe('SkillRunModal', () => {
  const skill = { name: 'release-check', body: 'Ship {{ticket}} to {{env}}' };
  const variables = [{ name: 'ticket' }, { name: 'env', default: 'staging' }];

  test('previews declared defaults for variables nobody filled', () => {
    renderModal({
      skill: { name: 'release-check', body: 'Ship it to {{env}}' },
      variables: [{ name: 'env', default: 'staging' }],
    });

    expect(screen.getByText('Ship it to staging')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Start chat',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test.each([
    { defaultValue: '', required: true },
    { defaultValue: '   ', required: true },
    { defaultValue: 'staging', required: false },
  ])(
    'explains and applies the usable default $defaultValue',
    ({ defaultValue, required }) => {
      const onRun = vi.fn();
      renderModal({
        skill: { name: 'release-check', body: 'Ship to {{env}}' },
        variables: [{ name: 'env', default: defaultValue }],
        onRun,
      });

      expect(
        screen.getByText(
          required ? 'Required.' : 'Optional; leave blank to use the default.',
        ),
      ).toBeTruthy();
      const field = screen.getByLabelText('env') as HTMLInputElement;
      expect(field.placeholder).toBe(required ? 'env' : 'default: staging');
      const start = screen.getByRole('button', {
        name: 'Start chat',
      }) as HTMLButtonElement;
      expect(start.disabled).toBe(required);
      fireEvent.click(start);
      if (required) {
        expect(onRun).not.toHaveBeenCalled();
        fireEvent.change(field, { target: { value: 'production' } });
        fireEvent.click(start);
        expect(onRun).toHaveBeenCalledWith('Ship to production', 'station');
      } else {
        expect(onRun).toHaveBeenCalledWith('Ship to staging', 'station');
      }
    },
  );

  test('withholds chat creation when no agent is available', () => {
    const onRun = vi.fn();
    renderModal({ skill, variables: [], agents: [], onRun });
    expect(screen.getByText(/No agents are available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onRun).not.toHaveBeenCalled();
  });

  test('rejects a missing no-default variable, naming it, and refuses to send', () => {
    renderModal({ skill, variables });

    expect(screen.getByRole('alert').textContent).toContain('{{ticket}}');
    expect(
      (
        screen.getByRole('button', {
          name: 'Start chat',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('sends the resolved body once the missing variable is filled', () => {
    const onRun = vi.fn();
    renderModal({ skill, variables, onRun });

    fireEvent.change(screen.getByLabelText('ticket'), {
      target: { value: 'ABC-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

    expect(onRun).toHaveBeenCalledWith('Ship ABC-1 to staging', 'station');
  });

  // clearing a field means "use the default" — the value the
  // placeholder shows — not "suppress the default until the modal reopens".
  test('a cleared field falls back to its declared default', () => {
    const onRun = vi.fn();
    const defaulted = { name: 'release-check', body: 'Ship to {{env}}' };
    const envVars = [{ name: 'env', default: 'staging' }];
    renderModal({ skill: defaulted, variables: envVars, onRun });
    fireEvent.click(screen.getByText('Preview instructions'));

    const field = screen.getByLabelText('env');
    fireEvent.change(field, { target: { value: 'prod' } });
    fireEvent.change(field, { target: { value: '' } });

    expect(screen.getByText('Ship to staging')).toBeTruthy();
    expect((field as HTMLInputElement).placeholder).toBe('default: staging');
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onRun).toHaveBeenCalledWith('Ship to staging', 'station');
  });

  test('entered values reset when the modal is closed and reopened', () => {
    const { rerender } = renderModal({ skill, variables });

    fireEvent.change(screen.getByLabelText('ticket'), {
      target: { value: 'ABC-1' },
    });
    rerender(
      <SkillRunModal
        isOpen={false}
        skill={skill}
        variables={variables}
        agents={agents}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    rerender(
      <SkillRunModal
        isOpen
        skill={skill}
        variables={variables}
        agents={agents}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText('ticket') as HTMLInputElement).value).toBe(
      '',
    );
  });

  test('entered values reset when the tested skill changes', () => {
    const other = { name: 'other', body: 'Deploy {{ticket}}' };
    const { rerender } = renderModal({ skill, variables });

    fireEvent.change(screen.getByLabelText('ticket'), {
      target: { value: 'ABC-1' },
    });
    rerender(
      <SkillRunModal
        isOpen
        skill={other}
        variables={variables}
        agents={agents}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText('ticket') as HTMLInputElement).value).toBe(
      '',
    );
  });
});
