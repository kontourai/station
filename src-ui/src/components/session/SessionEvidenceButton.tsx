import './SessionEvidenceButton.css';

/**
 * "See what it did" for a session that has ENDED (station#4052 slice 3).
 *
 * A real `<button>` in the row's trailing slot — the `SessionProjectPill`
 * precedent (station#3027): `SplitPaneLayout` renders `trailing` as a SIBLING
 * of the row button because a button may not contain interactive content.
 *
 * The control renders only for genuinely terminal sessions whose detail
 * actually has the evidence region — the caller gates on the canonical
 * lifecycle fold, never a private re-derivation, and on the detail shape
 * (`revealHomeRegion`'s rule: never offer a control whose target may be
 * absent). Activation is a navigation, not a scroll-by-hand: the caller
 * routes through the same `/activity?session=<id>` deep-link path every
 * other surface uses, plus the one-shot `focus=evidence` intent the session
 * detail honors once.
 */
export function SessionEvidenceButton({
  sessionTitle,
  onActivate,
}: {
  sessionTitle: string;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      className="session-evidence-button"
      aria-label={`Evidence for ${sessionTitle}`}
      title={`Open ${sessionTitle} at its receipts and diagnostics`}
      onClick={onActivate}
    >
      Evidence
    </button>
  );
}
