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
  readInputRequestResponse,
  readLegacyHarnessQuestions,
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
        // #3390 fix round: the stored question's header is kept.
        header: 'Target',
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
        header: 'Checks',
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

  test('a stored pre-unification MCP form remains a validated form, not an approval', () => {
    const legacyForm = {
      serverId: 'fixture',
      message: 'Who should receive it?',
      fields: [
        { name: 'recipient', kind: 'string', required: true, maxLength: 5 },
      ],
    };
    const event = {
      provider: 'station',
      payload: { mcpElicitation: legacyForm },
    };
    const form = inputRequestFromRequestEvent(event);
    expect(form).toMatchObject({
      source: 'mcp:fixture',
      requester: 'fixture',
      message: legacyForm.message,
    });
    expect(validateInputRequestContent(form!, { recipient: 'Ada' })).toEqual({
      recipient: 'Ada',
    });
    expect(() =>
      validateInputRequestContent(form!, { recipient: 'Adelaide' }),
    ).toThrow('at most 5');
    expect(
      inputRequestFromRequestEvent({
        payload: {
          mcpElicitation: {
            ...legacyForm,
            fields: [{ name: '__proto__', kind: 'string', required: false }],
          },
        },
      }),
    ).toBeNull();
  });

  test('the stored Codex event reads as a form, with its secret free-text question', () => {
    const form = inputRequestFromRequestEvent(legacy.codex as any);
    expect(form?.source).toBe('harness:codex');
    expect(form?.body.fields[1]).toEqual({
      name: 'credential',
      header: 'Credential',
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

describe('a header is an optional, bounded, never-blank label', () => {
  const field = FORM.body.fields[0];
  test('reads a header and keeps it', () => {
    const withHeader = structuredClone(FORM);
    withHeader.body.fields[0] = { ...field, header: 'Target' };
    expect(readInputRequestForm(withHeader)?.body.fields[0].header).toBe(
      'Target',
    );
  });
  test.each([[''], ['   '], ['x'.repeat(65)], [7]])(
    'refuses a header of %j rather than drawing it',
    (header) => {
      const bad = structuredClone(FORM) as any;
      bad.body.fields[0].header = header;
      expect(readInputRequestForm(bad)).toBeNull();
    },
  );
});

/**
 * Fix round (#3410 review): every untrusted object is read by its own keys.
 * An object whose prototype carries the keys — `Object.create(...)`, or a
 * JSON `"__proto__"` key that some later `Object.assign` turned into a real
 * prototype — must be refused, never read through.
 */
describe('inherited properties never count', () => {
  // `Object.assign` with a JSON-parsed `"__proto__"` key sets the prototype.
  const viaJsonProto = (inherited: unknown) =>
    Object.assign(
      {},
      JSON.parse(`{"__proto__": ${JSON.stringify(inherited)}}`),
    );

  test('a JSON "__proto__" key is an own key, and a refused one', () => {
    const parsed = JSON.parse(
      `{"__proto__": {"effect": "allow"}, ${JSON.stringify(FORM).slice(1)}`,
    );
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(readInputRequestForm(parsed)).toBeNull();
  });

  test.each([
    ['envelope (Object.create)', () => Object.create(structuredClone(FORM))],
    ['envelope (JSON __proto__)', () => viaJsonProto(FORM)],
    [
      'body (Object.create)',
      () => ({ ...FORM, body: Object.create({ kind: 'form', fields: [] }) }),
    ],
    [
      'body (JSON __proto__)',
      () => ({ ...FORM, body: viaJsonProto({ kind: 'form', fields: [] }) }),
    ],
    [
      'field (Object.create)',
      () => ({
        ...FORM,
        body: {
          kind: 'form',
          fields: [Object.create(structuredClone(FORM.body.fields[2]))],
        },
      }),
    ],
    [
      'field (JSON __proto__)',
      () => ({
        ...FORM,
        body: { kind: 'form', fields: [viaJsonProto(FORM.body.fields[2])] },
      }),
    ],
    [
      'option (Object.create)',
      () => {
        const form = structuredClone(FORM) as any;
        form.body.fields[0].options[0] = Object.create({
          value: '0',
          label: 'Staging',
        });
        return form;
      },
    ],
    [
      'option (JSON __proto__)',
      () => {
        const form = structuredClone(FORM) as any;
        form.body.fields[0].options[0] = viaJsonProto({
          value: '0',
          label: 'Staging',
        });
        return form;
      },
    ],
  ])('refuses an inherited %s', (_label, build) => {
    expect(readInputRequestForm(build())).toBeNull();
  });

  test.each([
    ['Object.create', () => Object.create({ custom: 'A canary host' })],
    ['JSON __proto__', () => viaJsonProto({ custom: 'A canary host' })],
  ])(
    'refuses a custom answer whose `custom` is inherited (%s)',
    (_label, build) => {
      const answer = build();
      expect('custom' in answer).toBe(true);
      expect(Object.hasOwn(answer, 'custom')).toBe(false);
      expect(
        inputRequestContentProblems(FORM, {
          target: answer,
          checks: ['unit', build()],
          token: 't',
        }).fields,
      ).toEqual({
        target: 'Where should we deploy? must be one of the offered choices.',
        checks: 'Which checks? must use only the offered choices, once each.',
      });
    },
  );

  test.each([
    [
      'Object.create',
      () => Object.create({ target: '0', checks: ['unit'], token: 't' }),
    ],
    [
      'JSON __proto__',
      () => viaJsonProto({ target: '0', checks: ['unit'], token: 't' }),
    ],
  ])('refuses content whose answers are inherited (%s)', (_label, build) => {
    expect(() => validateInputRequestContent(FORM, build())).toThrow(
      'The answer must be a set of fields.',
    );
  });

  test('a response, a stored questionnaire and legacy answers are read by own keys too', () => {
    expect(
      readInputRequestResponse(
        Object.create({ action: 'accept', content: { target: '0' } }),
      ),
    ).toBeNull();
    expect(
      readInputRequestResponse(viaJsonProto({ action: 'decline' })),
    ).toBeNull();
    expect(
      readLegacyHarnessQuestions(
        Object.create(structuredClone(legacy.claude.payload.questionnaire)),
      ),
    ).toBeNull();
    const form = inputRequestFromRequestEvent(legacy.codex as any)!;
    const inherited = Object.create({ optionIds: ['0'] });
    expect(() =>
      validateInputRequestContent(
        form,
        harnessAnswersToInputContent(form, {
          deployment: inherited,
          credential: { optionIds: [], custom: 'x' },
        }),
      ),
    ).toThrow(/one of the offered choices/);
    // Positive control: the same answers as own keys pass.
    expect(
      validateInputRequestContent(
        form,
        harnessAnswersToInputContent(form, {
          deployment: { optionIds: ['0'] },
          credential: { optionIds: [], custom: 'x' },
        }),
      ),
    ).toEqual({ deployment: '0', credential: 'x' });
  });
});

/**
 * Fix round 2 (#3410 review): a field may be named after an
 * `Object.prototype` member. Every field-keyed map is prototype-free, so such
 * a field is answered like any other and never reads as already answered or
 * already wrong.
 */
describe('fields named after Object.prototype members', () => {
  const PROTO: InputRequestForm = {
    schema: 'station.input-request/v1',
    source: 'mcp:fixture',
    requester: 'fixture',
    message: 'Prototype-named fields',
    body: {
      kind: 'form',
      fields: [
        {
          name: 'constructor',
          title: 'Builder',
          required: true,
          kind: 'string',
        },
        {
          name: 'toString',
          title: 'Format',
          required: true,
          kind: 'choice',
          options: [
            { value: 'pdf', label: 'PDF' },
            { value: 'html', label: 'HTML' },
          ],
          allowCustom: true,
        },
        {
          name: 'hasOwnProperty',
          title: 'Tags',
          required: true,
          kind: 'multi-choice',
          options: [{ value: 'a', label: 'A' }],
        },
      ],
    },
  };

  test('the form is admitted and correct content is accepted and returned whole', () => {
    expect(readInputRequestForm(structuredClone(PROTO))).toEqual(PROTO);
    const content = {
      constructor: 'Ada',
      toString: { custom: 'Markdown' },
      hasOwnProperty: ['a'],
    };
    const problems = inputRequestContentProblems(PROTO, content);
    expect(Object.keys(problems.fields)).toEqual([]);
    expect(problems.form).toBeUndefined();
    const admitted = validateInputRequestContent(PROTO, content);
    expect(Object.keys(admitted)).toEqual([
      'constructor',
      'toString',
      'hasOwnProperty',
    ]);
    expect(admitted.constructor).toBe('Ada');
    expect(admitted.toString).toEqual({ custom: 'Markdown' });
    expect(admitted.hasOwnProperty).toEqual(['a']);
  });

  test('an unanswered one is reported missing, by its own name, and nothing else is', () => {
    const problems = inputRequestContentProblems(PROTO, {
      toString: 'pdf',
      hasOwnProperty: ['a'],
    });
    expect(Object.entries(problems.fields)).toEqual([
      ['constructor', 'Builder is required.'],
    ]);
    expect(() =>
      validateInputRequestContent(PROTO, {
        toString: 'pdf',
        hasOwnProperty: ['a'],
      }),
    ).toThrow('Builder is required.');
  });

  test("a legacy questionnaire's `constructor` question translates and answers", () => {
    const form = inputRequestFromRequestEvent({
      provider: 'codex',
      payload: {
        questionnaire: {
          questions: [
            {
              id: 'constructor',
              header: 'Builder',
              prompt: 'Who builds it?',
              options: [],
              multiple: false,
              allowCustom: true,
              secret: false,
            },
          ],
        },
      },
    })!;
    expect(form.body.fields[0].name).toBe('constructor');
    expect(
      validateInputRequestContent(
        form,
        harnessAnswersToInputContent(form, {
          constructor: { optionIds: [], custom: 'Ada' },
        }),
      ).constructor,
    ).toBe('Ada');
  });

  test('a field named `__proto__` is refused at admission, from storage and from an MCP server', () => {
    const stored = structuredClone(PROTO) as any;
    stored.body.fields[0].name = '__proto__';
    expect(readInputRequestForm(stored)).toBeNull();
    const params = JSON.parse(
      '{"message":"m","requestedSchema":{"type":"object","properties":{"__proto__":{"type":"string"}}}}',
    );
    expect(inputRequestFromMcpElicitation('fixture', params)).toBeNull();
  });
});

/**
 * Fix round 2: validation returns the detached snapshot it checked, never the
 * caller's object, so a getter cannot answer one way to the validator and
 * another way to whatever is sent on.
 */
describe('validation returns what it checked', () => {
  test('a getter is read once; the result keeps that value and is detached', () => {
    let reads = 0;
    const content = {
      get target() {
        reads += 1;
        return reads === 1 ? '0' : 'not-an-option';
      },
      checks: ['unit'],
      token: 't',
    };
    const admitted = validateInputRequestContent(FORM, content);
    expect(reads).toBe(1);
    expect(admitted).not.toBe(content);
    expect(admitted.target).toBe('0');
    expect(admitted.target).toBe('0');
    expect(Object.getOwnPropertyDescriptor(admitted, 'target')?.get).toBe(
      undefined,
    );
  });

  test("a custom answer's getter is read once too", () => {
    let reads = 0;
    const answer = {
      get custom() {
        reads += 1;
        return reads === 1 ? 'A canary host' : '';
      },
    };
    const admitted = validateInputRequestContent(FORM, {
      target: answer,
      checks: ['unit'],
      token: 't',
    });
    // Counted before any assertion touches `answer` (a matcher's diff would
    // read the getter itself).
    const readsDuringValidation = reads;
    expect(readsDuringValidation).toBe(1);
    expect((admitted.target as { custom: string }).custom).toBe(
      'A canary host',
    );
    expect(admitted.target).toEqual({ custom: 'A canary host' });
    expect(admitted.target === answer).toBe(false);
  });

  test('an array is copied, so a later change to it is not in the result', () => {
    const checks = ['unit'];
    const admitted = validateInputRequestContent(FORM, {
      target: '0',
      checks,
      token: 't',
    });
    checks.push('browser');
    expect(admitted.checks).toEqual(['unit']);
  });
});
