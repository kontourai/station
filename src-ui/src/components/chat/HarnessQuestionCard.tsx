import type {
  HarnessQuestionAnswers,
  HarnessQuestionnaire,
} from '@kontourai/station-contracts/harness-questions';
import {
  harnessAnswerTexts,
  validateHarnessQuestionAnswers,
} from '@kontourai/station-shared/harness-questions';
import { useEffect, useId, useRef, useState } from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';
import { Button } from '../Button';
import {
  clearHarnessQuestionDraft,
  readHarnessQuestionDraft,
  saveHarnessQuestionDraft,
} from './harnessQuestionDrafts';
import './HarnessQuestionCard.css';

export function HarnessQuestionCard({
  questionnaire,
  draftKey,
  onSubmit,
}: {
  questionnaire: HarnessQuestionnaire;
  draftKey?: string;
  onSubmit: (answers: HarnessQuestionAnswers) => Promise<void>;
}) {
  const customAnswerId = useId();
  const [answers, setAnswers] = useState<HarnessQuestionAnswers>({});
  const [step, setStep] = useState(0);
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<boolean>();
  const edited = useRef(false);
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const heading = useRef<HTMLLegendElement>(null);
  const moveFocus = useRef(false);
  const customText = useRef<HTMLTextAreaElement>(null);
  const customSecret = useRef<HTMLInputElement>(null);
  const moveCustomFocus = useRef(false);
  useEffect(() => {
    if (moveCustomFocus.current) {
      (customSecret.current ?? customText.current)?.focus();
      moveCustomFocus.current = false;
    }
  });
  useEffect(() => {
    if (moveFocus.current) {
      heading.current?.focus();
      moveFocus.current = false;
    }
  });
  const navigate = (index: number) => {
    moveFocus.current = true;
    setStep(index);
    setReview(false);
    setError(undefined);
  };
  useEffect(() => {
    if (!draftKey) return;
    let active = true;
    void readHarnessQuestionDraft(draftKey, questionnaire).then((draft) => {
      if (active && !edited.current) setAnswers(draft);
    });
    return () => {
      active = false;
    };
  }, [draftKey, questionnaire]);
  useEffect(() => {
    if (!edited.current || sent) return;
    if (!draftKey) {
      setSaved(false);
      return;
    }
    let active = true;
    void saveHarnessQuestionDraft(draftKey, questionnaire, answers).then(
      (ok) => {
        if (active) setSaved(ok);
      },
    );
    return () => {
      active = false;
    };
  }, [draftKey, questionnaire, answers, sent]);
  const question = questionnaire.questions[step];
  const answer = answers[question.id] ?? { optionIds: [] };
  const update = (value: HarnessQuestionAnswers[string]) => {
    edited.current = true;
    setSaved(undefined);
    setError(undefined);
    setAnswers((previous) => ({ ...previous, [question.id]: value }));
  };
  const next = () => {
    try {
      validateHarnessQuestionAnswers(
        { questions: [question] },
        { [question.id]: answer },
      );
      setError(undefined);
      if (step + 1 < questionnaire.questions.length) navigate(step + 1);
      else {
        for (const [index, item] of questionnaire.questions.entries()) {
          try {
            validateHarnessQuestionAnswers(
              { questions: [item] },
              { [item.id]: answers[item.id] ?? { optionIds: [] } },
            );
          } catch (error) {
            navigate(index);
            throw error;
          }
        }
        setReview(true);
      }
    } catch (error) {
      setError(userFacingErrorMessage(error));
    }
  };
  const send = async () => {
    if (pending || sent) return;
    let validated: HarnessQuestionAnswers;
    try {
      validated = validateHarnessQuestionAnswers(questionnaire, answers);
    } catch (error) {
      setError(userFacingErrorMessage(error));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(validated);
      setSent(true);
      if (draftKey) await clearHarnessQuestionDraft(draftKey);
    } catch (error) {
      setError(userFacingErrorMessage(error));
    } finally {
      setPending(false);
    }
  };
  if (sent)
    return (
      <section className="harness-question-card" role="status">
        Answers sent
      </section>
    );
  return (
    <form
      className="harness-question-card"
      aria-label="Answer the agent’s questions"
      onSubmit={(event) => {
        event.preventDefault();
        if (review) void send();
        else next();
      }}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key === 'Enter' &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (!event.repeat) event.currentTarget.requestSubmit();
        }
      }}
    >
      <div className="harness-question-card__heading">
        <strong>{review ? 'Ready to send' : 'Agent questions'}</strong>
        <span>
          {review
            ? `${questionnaire.questions.length} answers`
            : `${step + 1}/${questionnaire.questions.length}`}
        </span>
      </div>
      {!review && questionnaire.questions.length > 1 && (
        <nav className="harness-question-card__steps" aria-label="Questions">
          {questionnaire.questions.map((item, index) => (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              disabled={pending}
              aria-current={step === index ? 'step' : undefined}
              onClick={() => navigate(index)}
            >
              {item.header || `${index + 1}`}
            </Button>
          ))}
        </nav>
      )}
      {review ? (
        <dl className="harness-question-card__review">
          {questionnaire.questions.map((question, index) => (
            <div key={question.id}>
              <dt title={question.prompt}>
                {question.header || question.prompt}
              </dt>
              <dd>
                {question.secret
                  ? '••••••••'
                  : harnessAnswerTexts(question, answers).join(', ')}
              </dd>
              <Button
                className="harness-question-card__edit"
                variant="ghost"
                size="sm"
                aria-label={`Edit answer ${index + 1}`}
                disabled={pending}
                onClick={() => navigate(index)}
              >
                Edit
              </Button>
            </div>
          ))}
        </dl>
      ) : (
        <fieldset disabled={pending}>
          <legend ref={heading} tabIndex={-1}>
            {question.prompt}
          </legend>
          {question.multiple && (
            <p className="harness-question-card__hint">Select any</p>
          )}
          <div className="harness-question-card__options">
            {question.options.map((option) => (
              <label key={option.id} className="harness-question-card__option">
                <input
                  type={question.multiple ? 'checkbox' : 'radio'}
                  name={`${customAnswerId}:${question.id}`}
                  checked={answer.optionIds.includes(option.id)}
                  onChange={() =>
                    update(
                      question.multiple
                        ? {
                            ...answer,
                            optionIds: answer.optionIds.includes(option.id)
                              ? answer.optionIds.filter(
                                  (id) => id !== option.id,
                                )
                              : [...answer.optionIds, option.id],
                          }
                        : { optionIds: [option.id] },
                    )
                  }
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </span>
              </label>
            ))}
          </div>
          {question.allowCustom &&
            question.options.length > 0 &&
            !customOpen[question.id] &&
            answer.custom === undefined && (
              <Button
                variant="ghost"
                className="harness-question-card__other"
                onClick={() => {
                  moveCustomFocus.current = true;
                  setCustomOpen((previous) => ({
                    ...previous,
                    [question.id]: true,
                  }));
                }}
              >
                Other…
              </Button>
            )}
          {question.allowCustom &&
            (customOpen[question.id] ||
              answer.custom !== undefined ||
              question.options.length === 0) && (
              <label
                className="harness-question-card__custom"
                htmlFor={customAnswerId}
              >
                <span>Your answer</span>
                {question.secret ? (
                  <input
                    ref={customSecret}
                    id={customAnswerId}
                    type="password"
                    autoComplete="off"
                    maxLength={12000}
                    value={answer.custom ?? ''}
                    onChange={(event) =>
                      update({
                        optionIds: question.multiple ? answer.optionIds : [],
                        custom: event.target.value,
                      })
                    }
                  />
                ) : (
                  <textarea
                    ref={customText}
                    id={customAnswerId}
                    rows={2}
                    maxLength={12000}
                    value={answer.custom ?? ''}
                    onChange={(event) =>
                      update({
                        optionIds: question.multiple ? answer.optionIds : [],
                        custom: event.target.value,
                      })
                    }
                  />
                )}
              </label>
            )}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="harness-question-card__actions">
        <span
          className="harness-question-card__draft"
          role="status"
          title={
            questionnaire.questions.some((item) => item.secret)
              ? 'Private answers are not saved'
              : 'Draft saved on this device'
          }
        >
          {questionnaire.questions.some((item) => item.secret)
            ? 'Private'
            : saved === true
              ? 'Saved'
              : saved === false
                ? 'In this tab'
                : ''}
        </span>
        {!review && step > 0 && (
          <Button
            disabled={pending}
            variant="ghost"
            onClick={() => navigate(step - 1)}
          >
            Back
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          pending={pending}
          pendingLabel="Sending…"
        >
          {review
            ? 'Send'
            : step + 1 === questionnaire.questions.length
              ? 'Review'
              : 'Next'}
        </Button>
      </div>
    </form>
  );
}
