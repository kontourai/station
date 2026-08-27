import { describe, expect, test } from 'vitest';
import { formatFormSubmission } from '../formSubmission';

describe('formatFormSubmission', () => {
  test('renders a human summary plus a tagged JSON payload', () => {
    const text = formatFormSubmission({
      blockId: 'gate-1',
      title: 'Approve gate',
      values: [
        { name: 'decision', label: 'Decision', value: 'approve' },
        { name: 'urgent', label: 'Urgent', value: true },
        { name: 'note', label: 'Note', value: '' },
      ],
    });

    expect(text).toContain('Submitted form "Approve gate":');
    expect(text).toContain('- Decision: approve');
    expect(text).toContain('- Urgent: yes');
    expect(text).toContain('- Note: (empty)');

    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({
      __stationFormSubmission: true,
      blockId: 'gate-1',
      title: 'Approve gate',
      fields: { decision: 'approve', urgent: true, note: '' },
    });
  });

  test('omits the title when absent', () => {
    const text = formatFormSubmission({
      blockId: 'x',
      values: [{ name: 'a', label: 'A', value: 'b' }],
    });
    expect(text).toContain('Submitted form:');
    const json = JSON.parse(
      text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
    );
    expect(json.title).toBeUndefined();
    expect(json.fields).toEqual({ a: 'b' });
  });
});
