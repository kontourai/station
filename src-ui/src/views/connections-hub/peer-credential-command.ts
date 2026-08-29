/**
 * The one CLI command the Computers page hands a user for provisioning an
 * outbound peer credential (`ComputersSection`'s empty-state row and its
 * copy-to-clipboard affordance).
 *
 * #765 D3: this string once named a verb `station environment --help` did not
 * list — the verb existed (packages/cli/src/commands/environment.ts) but was
 * missing from the help table (packages/cli/src/help.ts), so the UI appeared
 * to instruct an unsupported command. It lives in its own module so
 * `peer-credential-command-parity.test.ts` can assert against the CLI sources
 * that the named verb stays real and advertised, without dragging the whole
 * component (and its CSS imports) into that check.
 */
export const PEER_CREDENTIAL_COMMAND = 'station environment peers add';
