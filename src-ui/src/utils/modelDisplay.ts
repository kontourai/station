// External CLI terminals can leak SGR styling into a persisted model token.
// The server normalizes fresh catalog values; this client display boundary
// keeps historical receipts readable without rewriting their provenance.
const ANSI_ESCAPE = String.fromCharCode(0x1b);
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|[@-_][0-?]*[ -/]*[@-~])`,
  'g',
);
const STRANDED_SGR_SUFFIX = /\[(?:\d{1,3}(?:;\d{1,3})*)m\]?$/;

export function displayModelIdentifier(value: string): string {
  const cleaned = value
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(STRANDED_SGR_SUFFIX, '')
    .trim();
  return cleaned || value.trim();
}
