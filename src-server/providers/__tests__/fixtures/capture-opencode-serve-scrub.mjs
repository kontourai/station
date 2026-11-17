// Scrubbing for capture-opencode-serve-fixtures.mjs, split out so the
// fixture privacy test runs the same code the capture script does.

/**
 * Every form the capture's server credential can take in a recorded
 * exchange: the password itself, and the HTTP Basic value
 * `base64("opencode:<password>")` with and without the `Basic ` prefix.
 * Longest first, so the prefixed form wins over its own payload.
 */
export function credentialScrubRows(user, password) {
  const basic = Buffer.from(`${user}:${password}`).toString('base64');
  return [
    [`Basic ${basic}`, 'Basic {AUTH}'],
    [basic, '{AUTH}'],
    [password, '{PASSWORD}'],
  ];
}

/** Replace every `from` with its `to`, in table order. */
export function scrubText(text, rows) {
  let out = text;
  for (const [from, to] of rows) out = out.split(from).join(to);
  return out;
}
