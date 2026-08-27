import { describe, expect, it } from 'vitest';
import { PAIRING_STATE_COPY_IDS, pairingStateCopy } from '../pairing-copy.js';

/**
 * station#3849. The map exists to stop three components wording two pairing
 * states three ways, and to keep the noun `docs/glossary.md` forbids out of
 * all of them. Both properties are only worth anything if they hold for EVERY
 * entry, so these iterate the whole map rather than sampling it — the shape
 * `packages/connect/src/__tests__/environmentProfiles.test.ts` uses for
 * `FAILURE_COPY`.
 */
describe('pairing-state copy (station#3849)', () => {
  it('never says "host" — the vocabulary contract, over every entry', () => {
    for (const id of PAIRING_STATE_COPY_IDS) {
      for (const label of [undefined, 'Kontour']) {
        const copy = pairingStateCopy(id, label);
        for (const text of [copy.title, copy.message]) {
          expect(text, `${id} says "host": ${text}`).not.toMatch(/\bhosts?\b/i);
        }
      }
    }
  });

  it('names the machine by the label it was given, in every entry that names one', () => {
    // The label is the browser-local connection name, and the whole point of
    // threading it through is that a banner about Station B does not read as
    // being about the Station in front of the reader (station#3387). An entry
    // that silently ignored its label would put that lie back.
    const named = PAIRING_STATE_COPY_IDS.filter((id) =>
      pairingStateCopy(id).message.includes('Station'),
    );
    expect(
      named.length,
      'no entry names the machine at all — the label is not reaching the copy',
    ).toBeGreaterThan(0);
    for (const id of named) {
      expect(
        pairingStateCopy(id, 'Kontour').message,
        `${id} dropped the label it was given`,
      ).toContain('Kontour');
    }
  });

  it('falls back to a nameable subject when the device has no label for the machine', () => {
    // A device reading this copy is a device without a credential, so
    // `devicePresentation.hostName` is unreachable by construction and an
    // unnamed machine is a real state, not an edge case.
    for (const id of PAIRING_STATE_COPY_IDS) {
      for (const label of [undefined, '', '   ']) {
        expect(
          pairingStateCopy(id, label).message,
          `${id} renders an empty subject for label ${JSON.stringify(label)}`,
        ).not.toMatch(/(^|\s)(declined|on|before)\s*[.…]/);
      }
    }
    expect(pairingStateCopy('declined-access-request', '  ').message).toBe(
      'The Station declined this access request.',
    );
    expect(pairingStateCopy('waiting-for-approval').message).toBe(
      'Waiting for approval on this Station…',
    );
  });

  it('keeps the two decline subjects distinct', () => {
    // Collapsing these is the tempting simplification and the one thing this
    // map must not do: the dialog is open for ONE request the reader just
    // made; the banner is about a device, on a Station they may not be
    // looking at.
    expect(pairingStateCopy('declined-access-request', 'Kontour').message).toBe(
      'Kontour declined this access request.',
    );
    expect(pairingStateCopy('declined-device', 'Kontour').message).toBe(
      'Kontour declined this device. Request access again if that was unexpected.',
    );
  });
});
