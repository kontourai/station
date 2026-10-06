import type {
  HarnessQuestionAnswers,
  HarnessQuestionnaire,
} from '@kontourai/station-contracts/harness-questions';
import type { SkillExperienceSessionViewV1 } from '@kontourai/station-contracts/skill-experience';
import type { createSkillExperiencePaneHost } from '@kontourai/station-sdk/workspace-pane';
import './pane.css';

declare global {
  interface Window {
    __stationPaneHostOrigin?: string;
    __stationCreateSkillExperiencePaneHost?: typeof createSkillExperiencePaneHost;
  }
}

// Registration is inert in the shell. This example renders DOM only in its isolated document.
export const components = { 'interview-review': () => null };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function mount() {
  if (window.parent === window) return;
  const origin = window.__stationPaneHostOrigin;
  const createHost = window.__stationCreateSkillExperiencePaneHost;
  const root = document.getElementById('app');
  if (!origin || !createHost || !root) return;
  root.classList.add('rich-skill-experience');
  const host = createHost(window.parent, origin);
  window.addEventListener('pagehide', () => host.dispose(), { once: true });
  root.append(element('h1', 'Interview review'));
  const status = element(
    'p',
    'Refresh to read the current experience and its questions.',
  );
  const content = element('section');
  const refresh = element('button', 'Refresh questions');
  refresh.type = 'button';
  root.append(status, refresh, content);
  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      const value = JSON.parse(
        (await host.read()).viewJson,
      ) as SkillExperienceSessionViewV1 & {
        pendingQuestions?: Array<{
          requestId: string;
          requestEventId: string;
          questionnaire: HarnessQuestionnaire;
        }>;
      };
      content.replaceChildren();
      const invocation = value.current;
      if (
        !invocation?.snapshot ||
        invocation.availability.status !== 'available'
      ) {
        status.textContent =
          'This experience is unavailable. Continue with Station’s ordinary chat controls.';
        return;
      }
      status.textContent = invocation.snapshot.definition.title;
      content.append(element('p', invocation.snapshot.definition.purpose));
      const inputs = element('dl');
      for (const field of invocation.snapshot.definition.inputs) {
        if (field.kind === 'attachments') continue;
        inputs.append(
          element('dt', field.label),
          element('dd', invocation.snapshot.inputs[field.id] ?? ''),
        );
      }
      content.append(inputs);
      for (const request of value.pendingQuestions ?? []) {
        const form = element('form');
        const answers: HarnessQuestionAnswers = {};
        for (const question of request.questionnaire.questions) {
          if (question.secret) continue;
          const field = element('fieldset');
          field.append(
            element('legend', question.header),
            element('p', question.prompt),
          );
          answers[question.id] = { optionIds: [] };
          for (const option of question.options) {
            const label = element('label');
            const choice = element('input');
            choice.type = question.multiple ? 'checkbox' : 'radio';
            choice.name = question.id;
            choice.value = option.id;
            choice.onchange = () => {
              const selected = [
                ...field.querySelectorAll<HTMLInputElement>('input:checked'),
              ].map((node) => node.value);
              answers[question.id]!.optionIds = selected;
            };
            label.append(choice, element('span', option.label));
            field.append(label);
          }
          if (question.allowCustom) {
            const label = element('label', 'Your answer');
            const text = element('textarea');
            text.oninput = () => {
              answers[question.id]!.custom = text.value;
            };
            label.append(text);
            field.append(label);
          }
          form.append(field);
        }
        if (
          request.questionnaire.questions.some((question) => question.secret)
        ) {
          content.append(
            element(
              'p',
              'Answer this question in Station’s ordinary chat controls.',
            ),
          );
          continue;
        }
        const submit = element('button', 'Send answer');
        submit.type = 'submit';
        form.append(submit);
        form.onsubmit = async (event) => {
          event.preventDefault();
          submit.disabled = true;
          try {
            await host.answer({
              requestId: request.requestId,
              requestEventId: request.requestEventId,
              answers,
            });
            status.textContent =
              'Answer submitted. Refresh for the next question.';
          } catch {
            status.textContent =
              'This question changed or is unavailable. Refresh before answering.';
          } finally {
            submit.disabled = false;
          }
        };
        content.append(form);
      }
      const stages = [
        {
          label: 'Prepare another round',
          experienceId: invocation.snapshot.definition.id,
          inputs: invocation.snapshot.inputs,
        },
        ...(invocation.snapshot.definition.transitions ?? []).map((stage) => ({
          label: stage.label,
          experienceId: stage.experienceId,
          inputs: {},
        })),
      ];
      for (const stage of stages) {
        const next = element('button', stage.label);
        next.type = 'button';
        next.onclick = async () => {
          next.disabled = true;
          try {
            await host.continue({
              experienceId: stage.experienceId,
              inputs: stage.inputs,
            });
            status.textContent =
              'The next stage is ready in Station’s composer. Review its inputs and send when ready.';
          } catch {
            status.textContent =
              'This stage is unavailable. Continue in Station’s ordinary chat controls.';
          } finally {
            next.disabled = false;
          }
        };
        content.append(next);
      }
      if (!value.pendingQuestions?.length)
        content.append(
          element(
            'p',
            'Questions and outputs remain in the canonical chat. Refresh when a new question opens.',
          ),
        );
    } catch {
      status.textContent =
        'The experience host is unavailable. Continue in Station’s ordinary chat controls.';
    } finally {
      refresh.disabled = false;
    }
  };
}
if (typeof window !== 'undefined')
  window.addEventListener('load', mount, { once: true });
