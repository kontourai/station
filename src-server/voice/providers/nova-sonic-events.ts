import { createLogger } from '../../utils/logger.js';
import { sanitizedTransportError } from '../../utils/outward-error.js';
import type { S2SProviderState } from '../s2s-types.js';

const logger = createLogger({ name: 'nova-sonic-events' });

export interface NovaSonicEventState {
  currentRole: string;
  currentGenerationStage: string;
  currentToolName: string;
  currentToolUseId: string;
  currentToolContent: string;
  currentContentType: string;
  currentProviderSessionId: string;
  currentProviderPromptId: string;
  currentProviderTurnId: string;
  currentProviderContentId: string;
}

interface NovaSonicEventEffects {
  emit: (event: string, payload?: unknown) => void;
  setState: (state: S2SProviderState) => void;
}

function correlatedTurn(event: Record<string, unknown>):
  | {
      providerSessionId: string;
      providerTurnId: string;
      providerPromptId: string;
    }
  | undefined {
  const providerSessionId = event.sessionId;
  const providerTurnId = event.completionId;
  const providerPromptId = event.promptName;
  if (
    typeof providerSessionId !== 'string' ||
    !providerSessionId ||
    typeof providerTurnId !== 'string' ||
    !providerTurnId ||
    typeof providerPromptId !== 'string' ||
    !providerPromptId
  ) {
    return undefined;
  }
  return {
    providerSessionId,
    providerTurnId,
    providerPromptId,
  };
}

export function parseNovaSonicRawEvent(raw: any): any | null {
  try {
    const bytes = raw.chunk?.bytes;
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes))?.event ?? null;
  } catch (error) {
    logger.warn('[NovaSonic] Failed to parse response chunk', {
      error: sanitizedTransportError(error),
    });
    return null;
  }
}

export function processNovaSonicStreamEvent(
  event: any,
  state: NovaSonicEventState,
  effects: NovaSonicEventEffects,
): void {
  if (event.completionStart) {
    effects.emit('turnStart');
    const correlation = correlatedTurn(event.completionStart);
    if (correlation) effects.emit('correlatedTurnStart', correlation);
    effects.setState('processing');
    return;
  }

  if (event.contentStart) {
    const contentStart = event.contentStart;
    state.currentRole = contentStart.role ?? '';
    state.currentGenerationStage = contentStart.additionalModelFields
      ? (JSON.parse(contentStart.additionalModelFields)?.generationStage ?? '')
      : '';
    state.currentContentType = contentStart.type ?? '';
    // Content is allowed to be used only with its own complete provider tuple.
    // Never carry a previous completion identity across raw envelopes.
    const contentCorrelation = correlatedTurn(contentStart);
    const providerContentId = contentStart.contentId;
    const exactContent =
      contentCorrelation &&
      typeof providerContentId === 'string' &&
      providerContentId;
    state.currentProviderSessionId = exactContent
      ? contentCorrelation.providerSessionId
      : '';
    state.currentProviderPromptId = exactContent
      ? contentCorrelation.providerPromptId
      : '';
    state.currentProviderTurnId = exactContent
      ? contentCorrelation.providerTurnId
      : '';
    state.currentProviderContentId = exactContent ? providerContentId : '';
    state.currentToolName = '';
    state.currentToolUseId = '';
    state.currentToolContent = '';
    if (contentStart.type === 'AUDIO') {
      effects.setState('speaking');
    }
    return;
  }

  if (event.textOutput) {
    const text: string = event.textOutput.content ?? '';
    const role = state.currentRole.toLowerCase() as 'user' | 'assistant';
    const stage = state.currentGenerationStage.toLowerCase() as
      | 'speculative'
      | 'final';

    if (role === 'user' && stage === 'final') {
      effects.emit('transcript', { text, role: 'user', stage: 'final' });
    } else if (role === 'assistant' && stage === 'speculative') {
      effects.emit('transcript', {
        text,
        role: 'assistant',
        stage: 'speculative',
      });
    } else if (role === 'assistant' && stage === 'final') {
      effects.emit('transcript', {
        text,
        role: 'assistant',
        stage: 'final',
      });
    }
    return;
  }

  if (event.audioOutput) {
    effects.emit('audio', Buffer.from(event.audioOutput.content, 'base64'));
    return;
  }

  if (event.toolUse) {
    state.currentToolName = event.toolUse.toolName ?? state.currentToolName;
    state.currentToolUseId = event.toolUse.toolUseId ?? state.currentToolUseId;
    state.currentToolContent += event.toolUse.content ?? '';
    const correlation = correlatedTurn(event.toolUse);
    const providerContentId = event.toolUse.contentId;
    if (
      correlation &&
      typeof providerContentId === 'string' &&
      providerContentId &&
      providerContentId === state.currentProviderContentId &&
      correlation.providerSessionId === state.currentProviderSessionId &&
      correlation.providerPromptId === state.currentProviderPromptId &&
      correlation.providerTurnId === state.currentProviderTurnId &&
      state.currentToolUseId &&
      state.currentToolContent
    ) {
      // `toolUse` carries the provider completionId itself.  Preserve it now
      // rather than inferring ownership later from a session-local current turn.
    } else {
      state.currentProviderSessionId = '';
      state.currentProviderPromptId = '';
      state.currentProviderTurnId = '';
      state.currentProviderContentId = '';
    }
    return;
  }

  if (event.contentEnd) {
    try {
      if (
        event.contentEnd.stopReason === 'TOOL_USE' &&
        state.currentToolUseId
      ) {
        const endCorrelation = correlatedTurn(event.contentEnd);
        const endContentId = event.contentEnd.contentId;
        const exactToolEnvelope =
          endCorrelation &&
          typeof endContentId === 'string' &&
          endContentId &&
          endContentId === state.currentProviderContentId &&
          endCorrelation.providerSessionId === state.currentProviderSessionId &&
          endCorrelation.providerPromptId === state.currentProviderPromptId &&
          endCorrelation.providerTurnId === state.currentProviderTurnId;
        try {
          const toolUse = {
            toolName: state.currentToolName,
            toolUseId: state.currentToolUseId,
            parameters: JSON.parse(state.currentToolContent || '{}'),
          };
          effects.emit('toolUse', toolUse);
          if (exactToolEnvelope) {
            effects.emit('correlatedToolUse', {
              ...toolUse,
              providerSessionId: state.currentProviderSessionId,
              providerTurnId: state.currentProviderTurnId,
              providerPromptId: state.currentProviderPromptId,
              providerContentId: state.currentProviderContentId,
            });
          }
        } catch {
          const toolUse = {
            toolName: state.currentToolName,
            toolUseId: state.currentToolUseId,
            parameters: {},
          };
          effects.emit('toolUse', toolUse);
          if (exactToolEnvelope) {
            effects.emit('correlatedToolUse', {
              ...toolUse,
              providerSessionId: state.currentProviderSessionId,
              providerTurnId: state.currentProviderTurnId,
              providerPromptId: state.currentProviderPromptId,
              providerContentId: state.currentProviderContentId,
            });
          }
        }
      } else if (event.contentEnd.stopReason === 'INTERRUPTED') {
        effects.setState('listening');
      }
    } finally {
      // Each provider content envelope is one-shot. A duplicate contentEnd
      // cannot replay the same external tool effect.
      state.currentToolName = '';
      state.currentToolUseId = '';
      state.currentToolContent = '';
      state.currentProviderSessionId = '';
      state.currentProviderPromptId = '';
      state.currentProviderTurnId = '';
      state.currentProviderContentId = '';
    }
    return;
  }

  if (event.completionEnd) {
    effects.emit('turnEnd');
    const correlation = correlatedTurn(event.completionEnd);
    if (correlation && typeof event.completionEnd.stopReason === 'string') {
      effects.emit('correlatedTurnEnd', {
        ...correlation,
        stopReason: event.completionEnd.stopReason,
      });
    }
    effects.setState('listening');
  }
}
