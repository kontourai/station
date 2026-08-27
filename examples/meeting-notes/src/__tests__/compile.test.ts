import { describe, expect, test } from 'vitest';
import {
  buildCompiledRecordInput,
  buildExtractionPrompt,
  buildRawRecordInput,
  CAPTURE_PROVENANCE_AGENT,
  COMPILE_PROVENANCE_AGENT,
  EXTRACTION_PROMPT_PREFIX,
  parseCompileResult,
} from '../compile';

describe('EXTRACTION_PROMPT_PREFIX / buildExtractionPrompt', () => {
  test('is vendored verbatim from MeetingTranscriptionModal.handleSend', () => {
    // Never reword this without also updating the vendored precedent in
    // examples/meeting-transcription — see compile.ts's module doc.
    expect(EXTRACTION_PROMPT_PREFIX).toBe(
      'Here is a meeting transcript. Please extract the key action items, decisions made, and any important points:',
    );
  });

  test('joins the vendored prefix with the transcript on a blank line', () => {
    expect(buildExtractionPrompt('Alice: hi\nBob: hi')).toBe(
      `${EXTRACTION_PROMPT_PREFIX}\n\nAlice: hi\nBob: hi`,
    );
  });
});

describe('parseCompileResult', () => {
  test('accepts a well-shaped result', () => {
    const value = {
      title: 'Weekly sync',
      summary: 'Discussed roadmap.',
      actionItems: ['Ship K5', 'Update docs'],
    };
    expect(parseCompileResult(value)).toEqual(value);
  });

  test('rejects a missing field', () => {
    expect(parseCompileResult({ title: 'x', actionItems: [] })).toBeNull();
  });

  test('rejects a non-string actionItems entry', () => {
    expect(
      parseCompileResult({
        title: 'x',
        summary: 'y',
        actionItems: ['ok', 42],
      }),
    ).toBeNull();
  });

  test('rejects a non-object value', () => {
    expect(parseCompileResult('not an object')).toBeNull();
    expect(parseCompileResult(null)).toBeNull();
    expect(parseCompileResult(undefined)).toBeNull();
  });
});

describe('buildRawRecordInput', () => {
  test('produces a raw record with the capture provenance agent', () => {
    const input = buildRawRecordInput('Alice: hi\nBob: hi');
    expect(input.type).toBe('raw');
    expect(input.category).toBe('meeting-transcript');
    expect(input.body).toBe('Alice: hi\nBob: hi');
    expect(input.provenance).toEqual({ agent: CAPTURE_PROVENANCE_AGENT });
  });
});

describe('buildCompiledRecordInput', () => {
  test('links back to the raw record with kind:source and matching provenance.source_ids', () => {
    const rawId = 'rec_raw_123';
    const input = buildCompiledRecordInput(rawId, {
      title: 'Weekly sync',
      summary: 'Discussed roadmap.',
      actionItems: ['Ship K5', 'Update docs'],
    });

    expect(input.type).toBe('compiled');
    expect(input.title).toBe('Weekly sync');
    expect(input.links).toEqual([{ target_id: rawId, kind: 'source' }]);
    expect(input.provenance).toEqual({
      agent: COMPILE_PROVENANCE_AGENT,
      source_ids: [rawId],
    });
    expect(input.body).toContain('Discussed roadmap.');
    expect(input.body).toContain('- Ship K5');
    expect(input.body).toContain('- Update docs');
  });

  test('omits the action-items section when there are none', () => {
    const input = buildCompiledRecordInput('rec_raw_1', {
      title: 'Standup',
      summary: 'Nothing notable.',
      actionItems: [],
    });
    expect(input.body).toBe('Nothing notable.');
  });
});
