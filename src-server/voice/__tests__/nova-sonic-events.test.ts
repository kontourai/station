import { describe, expect, test, vi } from 'vitest';
import {
  type NovaSonicEventState,
  parseNovaSonicRawEvent,
  processNovaSonicStreamEvent,
} from '../providers/nova-sonic-events.js';

function createState(): NovaSonicEventState {
  return {
    currentRole: '',
    currentGenerationStage: '',
    currentToolName: '',
    currentToolUseId: '',
    currentToolContent: '',
    currentContentType: '',
    currentProviderSessionId: '',
    currentProviderPromptId: '',
    currentProviderTurnId: '',
    currentProviderContentId: '',
  };
}

describe('nova-sonic-events', () => {
  test('parseNovaSonicRawEvent decodes event payloads', () => {
    const raw = {
      chunk: {
        bytes: new TextEncoder().encode(
          JSON.stringify({ event: { completionStart: { id: 'c1' } } }),
        ),
      },
    };

    expect(parseNovaSonicRawEvent(raw)).toEqual({
      completionStart: { id: 'c1' },
    });
  });

  test('returns null for malformed provider chunks without surfacing their text', () => {
    expect(
      parseNovaSonicRawEvent({
        chunk: {
          bytes: new TextEncoder().encode('{not-json'),
        },
      }),
    ).toBeNull();
  });

  test('processNovaSonicStreamEvent emits transcripts based on role and stage', () => {
    const emit = vi.fn();
    const setState = vi.fn();
    const state = createState();

    processNovaSonicStreamEvent(
      {
        contentStart: {
          role: 'ASSISTANT',
          type: 'TEXT',
          additionalModelFields: '{"generationStage":"SPECULATIVE"}',
        },
      },
      state,
      { emit, setState },
    );
    processNovaSonicStreamEvent(
      { textOutput: { content: 'Thinking out loud' } },
      state,
      { emit, setState },
    );

    expect(emit).toHaveBeenCalledWith('transcript', {
      text: 'Thinking out loud',
      role: 'assistant',
      stage: 'speculative',
    });
  });

  test('preserves AWS completionId through exact start, tool, and end correlation', () => {
    const emit = vi.fn();
    const setState = vi.fn();
    const state = createState();

    processNovaSonicStreamEvent(
      {
        completionStart: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
        },
      },
      state,
      { emit, setState },
    );
    processNovaSonicStreamEvent(
      {
        contentStart: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-tool-a',
          type: 'TOOL',
        },
      },
      state,
      { emit, setState },
    );
    processNovaSonicStreamEvent(
      {
        toolUse: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-tool-a',
          toolName: 'lookup_weather',
          toolUseId: 'tu-1',
          content: '{"city":"Denver"}',
        },
      },
      state,
      { emit, setState },
    );
    processNovaSonicStreamEvent(
      {
        contentEnd: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-tool-a',
          stopReason: 'TOOL_USE',
        },
      },
      state,
      { emit, setState },
    );

    expect(emit).toHaveBeenCalledWith('toolUse', {
      toolName: 'lookup_weather',
      toolUseId: 'tu-1',
      parameters: { city: 'Denver' },
    });
    expect(emit).toHaveBeenCalledWith('correlatedTurnStart', {
      providerSessionId: 'nova-session-a',
      providerPromptId: 'prompt-a',
      providerTurnId: 'completion-a',
    });
    expect(emit).toHaveBeenCalledWith('correlatedToolUse', {
      providerSessionId: 'nova-session-a',
      providerPromptId: 'prompt-a',
      providerTurnId: 'completion-a',
      providerContentId: 'content-tool-a',
      toolName: 'lookup_weather',
      toolUseId: 'tu-1',
      parameters: { city: 'Denver' },
    });
    const correlatedToolCalls = emit.mock.calls.filter(
      ([name]) => name === 'correlatedToolUse',
    ).length;
    processNovaSonicStreamEvent(
      {
        contentEnd: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-tool-a',
          stopReason: 'TOOL_USE',
        },
      },
      state,
      { emit, setState },
    );
    expect(
      emit.mock.calls.filter(([name]) => name === 'correlatedToolUse'),
    ).toHaveLength(correlatedToolCalls);
    processNovaSonicStreamEvent(
      {
        completionEnd: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          stopReason: 'END_TURN',
        },
      },
      state,
      { emit, setState },
    );
    expect(emit).toHaveBeenCalledWith('correlatedTurnEnd', {
      providerSessionId: 'nova-session-a',
      providerPromptId: 'prompt-a',
      providerTurnId: 'completion-a',
      stopReason: 'END_TURN',
    });
  });

  test('refuses correlation when content start, tool, and content end tuples disagree', () => {
    const emit = vi.fn();
    const setState = vi.fn();
    const state = createState();
    processNovaSonicStreamEvent(
      {
        contentStart: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-a',
          type: 'TOOL',
        },
      },
      state,
      { emit, setState },
    );
    processNovaSonicStreamEvent(
      {
        toolUse: {
          sessionId: 'nova-session-b',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-a',
          toolName: 'lookup',
          toolUseId: 'tool-a',
          content: '{}',
        },
      },
      state,
      { emit, setState },
    );
    processNovaSonicStreamEvent(
      {
        contentEnd: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          contentId: 'content-a',
          stopReason: 'TOOL_USE',
        },
      },
      state,
      { emit, setState },
    );
    expect(emit).not.toHaveBeenCalledWith(
      'correlatedToolUse',
      expect.anything(),
    );
  });

  test('does not create a correlated event from a malformed provider identity', () => {
    const emit = vi.fn();
    const setState = vi.fn();
    processNovaSonicStreamEvent(
      { completionStart: { sessionId: 'nova-session-a', completionId: '' } },
      createState(),
      { emit, setState },
    );
    expect(emit).toHaveBeenCalledWith('turnStart');
    expect(emit).not.toHaveBeenCalledWith(
      'correlatedTurnStart',
      expect.anything(),
    );
  });
});
