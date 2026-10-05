import type { InputRequestForm } from '@kontourai/station-contracts/input-request';
import { describe, expect, test } from 'vitest';
import {
  harnessAnswerTexts,
  readHarnessQuestionnaire,
  validateHarnessQuestionAnswers,
} from '../harness-questions.js';
import {
  approvalDecisionBody,
  decisionOptionResponse,
  harnessAnswersToInputContent,
  inputRequestAnswerTexts,
  inputRequestContentProblems,
  inputRequestFromRequestEvent,
  inputRequestOutcome,
  readInputRequestForm,
  validateInputRequestContent,
} from '../input-request.js';
import { inputRequestFromMcpElicitation } from '../mcp-elicitation.js';
import legacy from './fixtures/legacy-harness-question-events.json' with {
  type: 'json',
};

const FORM: InputRequestForm = {
  schema: 'station.input-request/v1',
  source: 'harness:claude',
  requester: 'Claude',
  message: 'The agent has questions for you',
  body: {
    kind: 'form',
    fields: [
      {
        name: 'target',
        title: 'Where should we deploy?',
        required: true,
        kind: 'choice',
        options: [
          { value: '0', label: 'Staging', description: 'Try first' },
          { value: '1', label: 'Production' },
        ],
        allowCustom: true,
      },
      {
        name: 'checks',
        title: 'Which checks?',
        required: true,
        kind: 'multi-choice',
        options: [
          { value: 'unit', label: 'Unit' },
          { value: 'browser', label: 'Browser' },
        ],
        minItems: 1,
        allowCustom: true,
      },
      {
        name: 'token',
        title: 'Token',
        required: true,
        kind: 'string',
        secret: true,
      },
    ],
  },
};

describe('readInputRequestForm', () => {
  test('reads a v1 form exactly', () => {
    expect(readInputRequestForm(structuredClone(FORM))).toEqual(FORM);
  });

  // #3390 boundary: a decision can never be expressed inside a form. A
  // source that adds an allow effect to a field or an option, or ships a
  // decision body of its own, gets nothing rendered.
  test('refuses a form body carrying an allow effect', () => {
    const onField = structuredClone(FORM) as any;
    onField.body.fields[0].effect = 'allow';
    expect(readInputRequestForm(onField)).toBeNull();
    const onOption = structuredClone(FORM) as any;
    onOption.body.fields[0].options[0].effect = 'allow';
    onOption.body.fields[0].options[0].scope = 'session';
    expect(readInputRequestForm(onOption)).toBeNull();
    const onBody = structuredClone(FORM) as any;
    onBody.body.options = [{ id: 'a', effect: 'allow', scope: 'once' }];
    expect(readInputRequestForm(onBody)).toBeNull();
  });

  test('refuses a stored decision body, and a form claiming to be an approval', () => {
    expect(
      readInputRequestForm({
        ...FORM,
        source: 'approval',
      }),
    ).toBeNull();
    expect(
      readInputRequestForm({
        ...FORM,
        body: approvalDecisionBody('Allow Bash for this session'),
      }),
    ).toBeNull();
    // Through the event reader too: a payload cannot smuggle one in.
    expect(
      inputRequestFromRequestEvent({
        payload: {
          inputRequest: {
            ...FORM,
            body: approvalDecisionBody(undefined),
          },
        },
      }),
    ).toBeNull();
  });

  test('refuses another schema version, a duplicate field and an unknown envelope key', () => {
    expect(
      readInputRequestForm({ ...FORM, schema: 'station.input-request/v2' }),
    ).toBeNull();
    const duplicate = structuredClone(FORM);
    duplicate.body.fields.push(structuredClone(FORM.body.fields[0]));
    expect(readInputRequestForm(duplicate)).toBeNull();
    expect(readInputRequestForm({ ...FORM, grant: true })).toBeNull();
  });
});

describe('validateInputRequestContent', () => {
  test('accepts options, a custom answer in an option slot, and a secret', () => {
    const content = {
      target: { custom: 'A separate test environment' },
      checks: ['unit', { custom: 'Lint' }],
      token: ' x ',
    };
    expect(validateInputRequestContent(FORM, content)).toEqual(content);
  });

  test('reports every invalid field at once, by name', () => {
    expect(
      inputRequestContentProblems(FORM, {
        target: { custom: '   ' },
        checks: [],
      }),
    ).toEqual({
      fields: {
        target:
          'Where should we deploy?: write your answer, or choose an option.',
        checks: 'Which checks? is required.',
        token: 'Token is required.',
      },
    });
    expect(
      inputRequestContentProblems(FORM, { target: '0', checks: ['unit'], x: 1 })
        .form,
    ).toBe('The form has no field named x.');
  });

  test.each([
    [{ checks: ['unit', 'unit'] }, /once each/],
    [{ checks: [{ custom: 'a' }, { custom: 'b' }] }, /once each/],
    [{ target: ['0', '1'] }, /one of the offered choices/],
    [{ target: '9' }, /one of the offered choices/],
    [{ token: '' }, /Token is required/],
  ])('refuses %j', (patch, reason) => {
    expect(() =>
      validateInputRequestContent(FORM, {
        target: '0',
        checks: ['unit'],
        token: 't',
        ...patch,
      }),
    ).toThrow(reason);
  });

  // The MCP field rules carried over from #3284 unchanged.
  const mcp = inputRequestFromMcpElicitation('fixture', {
    message: 'Who?',
    requestedSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name', minLength: 1, maxLength: 5 },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        subscribe: { type: 'boolean' },
        color: { type: 'string', enum: ['red', 'blue'] },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['a', 'b', 'c'] },
          maxItems: 2,
        },
      },
      required: ['name'],
    },
  })!;
  test.each([
    [{}, /Name is required/],
    [{ name: '   ' }, /Name is required/],
    [{ name: 'Adelaide' }, /Name allows at most 5 characters/],
    [{ name: 'Ada', email: 'nope' }, /email must be an email address/],
    [{ name: 'Ada', age: 3.5 }, /age must be a whole number/],
    [{ name: 'Ada', age: 151 }, /age must be at most 150/],
    [{ name: 'Ada', age: '36' }, /age must be a number/],
    [{ name: 'Ada', subscribe: 'yes' }, /subscribe must be yes or no/],
    [{ name: 'Ada', color: 'green' }, /color must be one of the offered/],
    [{ name: 'Ada', tags: ['a', 'b', 'c'] }, /tags allows at most 2/],
    [{ name: 'Ada', extra: 1 }, /no field named extra/],
  ])('MCP: refuses %j with a reason', (content, reason) => {
    expect(() => validateInputRequestContent(mcp, content)).toThrow(reason);
  });
});

describe('stored harness questions from before #3390', () => {
  // Real writer output, captured from the pre-#3390 adapters (see the
  // fixture's provenance).
  test('the stored Claude event reads as a form and answers', () => {
    const form = inputRequestFromRequestEvent(legacy.claude as any);
    expect(form).toMatchObject({
      source: 'harness:claude',
      requester: 'Claude',
      message: 'The agent has questions for you',
    });
    expect(form?.body.fields).toEqual([
      {
        name: '0',
        title: 'Where should we deploy?',
        required: true,
        kind: 'choice',
        options: [
          { value: '0', label: 'Staging', description: 'Try first' },
          { value: '1', label: 'Production', description: 'Release' },
        ],
        allowCustom: true,
      },
      {
        name: '1',
        title: 'Which checks should run first?',
        required: true,
        kind: 'multi-choice',
        options: [
          { value: '0', label: 'Unit', description: 'Fast' },
          { value: '1', label: 'Browser', description: 'Slow' },
          { value: '2', label: 'Lint' },
        ],
        minItems: 1,
        allowCustom: true,
      },
    ]);
    const content = validateInputRequestContent(form!, {
      '0': '1',
      '1': ['0', { custom: 'Smoke' }],
    });
    expect(inputRequestAnswerTexts(form!.body.fields[1], content['1'])).toEqual(
      ['Unit', 'Smoke'],
    );
  });

  test('the stored Codex event reads as a form, with its secret free-text question', () => {
    const form = inputRequestFromRequestEvent(legacy.codex as any);
    expect(form?.source).toBe('harness:codex');
    expect(form?.body.fields[1]).toEqual({
      name: 'credential',
      title: 'Enter the temporary credential',
      required: true,
      kind: 'string',
      secret: true,
    });
    // A secret answer is taken as typed, surrounding spaces included.
    expect(
      validateInputRequestContent(form!, {
        deployment: '0',
        credential: ' private ',
      }),
    ).toEqual({ deployment: '0', credential: ' private ' });
  });

  test("a pre-#3390 client's `answers` translate to content and pass the one validator", () => {
    const form = inputRequestFromRequestEvent(legacy.codex as any)!;
    const content = harnessAnswersToInputContent(form, {
      deployment: { optionIds: [], custom: 'Canary' },
      credential: { optionIds: [], custom: 'secret' },
    });
    expect(validateInputRequestContent(form, content)).toEqual({
      deployment: { custom: 'Canary' },
      credential: 'secret',
    });
    expect(() =>
      validateInputRequestContent(
        form,
        harnessAnswersToInputContent(form, {
          deployment: { optionIds: ['unknown'] },
          credential: { optionIds: [], custom: 'x' },
        }),
      ),
    ).toThrow(/one of the offered choices/);
  });

  test('the deprecated harness exports still work, through the one validator', () => {
    const questionnaire = readHarnessQuestionnaire(
      legacy.claude.payload.questionnaire,
    )!;
    expect(questionnaire.questions).toHaveLength(2);
    const answers = validateHarnessQuestionAnswers(questionnaire, {
      '0': { optionIds: ['0'], custom: '  ' },
      '1': { optionIds: ['2'] },
    });
    expect(answers).toEqual({
      '0': { optionIds: ['0'] },
      '1': { optionIds: ['2'] },
    });
    expect(harnessAnswerTexts(questionnaire.questions[1], answers)).toEqual([
      'Lint',
    ]);
    expect(() =>
      validateHarnessQuestionAnswers(questionnaire, { '0': { optionIds: [] } }),
    ).toThrow();
  });
});

describe('decisions and outcomes', () => {
  test('the approval decision body maps each option to its respond decision', () => {
    const body = approvalDecisionBody('Allow Bash for this session');
    expect(
      body.options.map((option) => [
        option.label,
        option.effect,
        option.scope,
        decisionOptionResponse(option),
      ]),
    ).toEqual([
      ['Allow Once', 'allow', 'once', 'accept'],
      ['Allow Bash for this session', 'allow', 'session', 'acceptForSession'],
      ['Deny', 'deny', 'once', 'decline'],
    ]);
    expect(approvalDecisionBody(undefined).options).toHaveLength(2);
  });

  test('a resolution status reads as the outcome its kind names', () => {
    expect(inputRequestOutcome('form', 'approved')).toBe('accepted');
    expect(inputRequestOutcome('form', 'denied')).toBe('declined');
    expect(inputRequestOutcome('decision', 'approved')).toBe('allowed');
    expect(inputRequestOutcome('decision', 'denied')).toBe('denied');
    expect(inputRequestOutcome('form', 'cancelled')).toBe('cancelled');
    expect(inputRequestOutcome('decision', 'expired')).toBe('expired');
  });
});
