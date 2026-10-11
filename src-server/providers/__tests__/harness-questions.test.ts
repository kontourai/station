import { validateInputRequestContent } from '@kontourai/station-shared/input-request';
import { describe, expect, test } from 'vitest';
import {
  claudeAnswers,
  claudeInputRequest,
  codexAnswers,
  codexInputRequest,
} from '../adapters/harness-questions.js';

/**
 * #3410 fix round 2: the harness edge reads an engine's question payload by
 * its own keys at every level. A question, option or flag that is only
 * inherited is never copied into the form: the payload is refused instead.
 */
const viaJsonProto = (inherited: unknown) =>
  Object.assign({}, JSON.parse(`{"__proto__": ${JSON.stringify(inherited)}}`));

const claudeQuestion = () => ({
  question: 'Where should we deploy?',
  header: 'Target',
  multiSelect: false,
  options: [
    { label: 'Staging', description: 'Try first' },
    { label: 'Production', description: 'Release' },
  ],
});

const codexQuestion = () => ({
  id: 'token',
  header: 'Token',
  question: 'Paste the token',
  isOther: false,
  options: null as unknown,
});

describe('claudeInputRequest', () => {
  test('positive control: own keys map to a form', () => {
    expect(
      claudeInputRequest({ questions: [claudeQuestion()] })?.body.fields[0],
    ).toMatchObject({ name: '0', header: 'Target', kind: 'choice' });
  });

  test.each([
    [
      'input (Object.create)',
      () => Object.create({ questions: [claudeQuestion()] }),
    ],
    [
      'input (JSON __proto__)',
      () => viaJsonProto({ questions: [claudeQuestion()] }),
    ],
    [
      'question (Object.create)',
      () => ({ questions: [Object.create(claudeQuestion())] }),
    ],
    [
      'question (JSON __proto__)',
      () => ({ questions: [viaJsonProto(claudeQuestion())] }),
    ],
    [
      'option (Object.create)',
      () => ({
        questions: [
          {
            ...claudeQuestion(),
            options: [Object.create({ label: 'Staging' })],
          },
        ],
      }),
    ],
    [
      'option (JSON __proto__)',
      () => ({
        questions: [
          {
            ...claudeQuestion(),
            options: [viaJsonProto({ label: 'Staging' })],
          },
        ],
      }),
    ],
  ])('refuses an inherited %s', (_label, build) => {
    expect(claudeInputRequest(build())).toBeNull();
  });

  test('answers map back to the admitted question text, not a re-read of the engine input', () => {
    const input = { questions: [claudeQuestion()] };
    const form = claudeInputRequest(input)!;
    // The engine's object changes after admission; the answer key does not.
    input.questions[0].question = 'Something else entirely';
    const content = validateInputRequestContent(form, { '0': '1' });
    expect(claudeAnswers(form, content)).toEqual({
      'Where should we deploy?': 'Production',
    });
  });
});

describe('codexInputRequest', () => {
  test('positive control: own keys map, and a question without isSecret is not secret', () => {
    expect(
      codexInputRequest({ questions: [codexQuestion()] })?.body.fields[0],
    ).toEqual({
      name: 'token',
      header: 'Token',
      title: 'Paste the token',
      required: true,
      kind: 'string',
    });
  });

  test.each([
    [
      'isSecret (Object.create)',
      () => ({
        questions: [
          Object.assign(Object.create({ isSecret: true }), codexQuestion()),
        ],
      }),
    ],
    [
      'isSecret (JSON __proto__)',
      () => ({
        questions: [
          Object.assign(viaJsonProto({ isSecret: true }), codexQuestion()),
        ],
      }),
    ],
    [
      'params (Object.create)',
      () => Object.create({ questions: [codexQuestion()] }),
    ],
    [
      'option (Object.create)',
      () => ({
        questions: [
          {
            ...codexQuestion(),
            options: [Object.create({ label: 'us-east' })],
          },
        ],
      }),
    ],
  ])('refuses an inherited %s', (_label, build) => {
    expect(codexInputRequest(build())).toBeNull();
  });

  test('a question named after an Object.prototype member answers by its own name', () => {
    const form = codexInputRequest({
      questions: [{ ...codexQuestion(), id: 'constructor' }],
    })!;
    const content = validateInputRequestContent(form, { constructor: 'abc' });
    const answers = codexAnswers(form, content);
    expect(Object.hasOwn(answers, 'constructor')).toBe(true);
    expect(answers.constructor).toEqual({ answers: ['abc'] });
    expect(JSON.parse(JSON.stringify(answers))).toEqual({
      constructor: { answers: ['abc'] },
    });
  });
});
