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
      if (step + 1 < questionnaire.questions.length) setStep(step + 1);
      else setReview(true);
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
        Answers sent. Waiting for the engine to continue…
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
        <strong>
          {review
            ? 'Review your answers'
            : question.header || 'The agent has a question'}
        </strong>
        <span>
          {review
            ? `${questionnaire.questions.length} questions`
            : `Question ${step + 1} of ${questionnaire.questions.length}`}
        </span>
      </div>
      {review ? (
        <dl className="harness-question-card__review">
          {questionnaire.questions.map((question, index) => (
            <div key={question.id}>
              <dt>{question.prompt}</dt>
              <dd>
                {question.secret
                  ? 'Private answer entered'
                  : harnessAnswerTexts(question, answers).join(', ')}
              </dd>
              <Button
                disabled={pending}
                onClick={() => {
                  setStep(index);
                  setReview(false);
                }}
              >
                Edit answer {index + 1}
              </Button>
            </div>
          ))}
        </dl>
      ) : (
        <fieldset disabled={pending}>
          <legend>{question.prompt}</legend>
          {question.multiple && <p>Choose all that apply.</p>}
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
          {question.allowCustom && (
            <label
              className="harness-question-card__custom"
              htmlFor={customAnswerId}
            >
              <span>
                {question.options.length ? 'Your own answer' : 'Your answer'}
              </span>
              {question.secret ? (
                <input
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
                  id={customAnswerId}
                  rows={3}
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
      <p className="harness-question-card__draft" role="status">
        {questionnaire.questions.some((question) => question.secret)
          ? 'Private answers aren’t saved as drafts.'
          : saved === true
            ? 'Draft saved on this device.'
            : saved === false
              ? 'Draft kept in this tab only.'
              : 'Answers are sent together after review.'}
      </p>
      <div className="harness-question-card__actions">
        {!review && step > 0 && (
          <Button
            disabled={pending}
            onClick={() => {
              setStep(step - 1);
              setError(undefined);
            }}
          >
            Previous
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          pending={pending}
          pendingLabel="Sending answers…"
        >
          {review
            ? 'Send answers'
            : step + 1 === questionnaire.questions.length
              ? 'Review answers'
              : 'Next question'}
        </Button>
      </div>
    </form>
  );
}
