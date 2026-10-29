import { describe, expect, test } from 'vitest';
import { presentOpenRequest } from '../request-presentation.js';

const form = (requester: string, message: string) => ({
  schema: 'station.input-request/v1',
  source: 'harness:cursor',
  requester,
  message,
  body: {
    kind: 'form',
    fields: [
      {
        name: 'review',
        kind: 'choice',
        title: 'Approve the plan?',
        required: true,
        options: [
          { value: 'approve', label: 'Approve' },
          { value: 'reject', label: 'Reject' },
        ],
      },
    ],
  },
});

describe('presentOpenRequest for an engine form', () => {
  test('a plan review keeps its own wording, not "asked questions"', () => {
    expect(
      presentOpenRequest({
        requestType: 'approval',
        title: 'Lab Engine wants you to review a plan: Storage on SQLite',
        payload: {
          toolName: 'cursor/create_plan',
          inputRequest: form('Lab Engine', 'Storage on SQLite'),
        },
      }),
    ).toEqual({
      title: 'Lab Engine wants you to review a plan: Storage on SQLite',
    });
  });

  test('a question keeps the question wording', () => {
    expect(
      presentOpenRequest({
        requestType: 'approval',
        title: 'Need input',
        payload: {
          toolName: 'cursor/ask_question',
          inputRequest: form('Lab Engine', 'Need input'),
        },
      }).title,
    ).toBe('The agent asked questions: Need input');
  });
});
