import { authenticatedFetch } from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { downloadDiagnosticsBundle } from '../settings/diagnostics-download';

/**
 * Session archive plus a one-click diagnostics bundle download. Reuses the same
 * `GET /api/diagnostics/bundle` + `downloadDiagnosticsBundle` helper that
 * Settings → Diagnostics uses (the bundle is a redacted health/config snapshot
 * that includes recent server logs).
 */
export default function ArchiveTab({ apiBase }: { apiBase: string }) {
  const diagnosticsBundle = useMutation({
    mutationFn: async () => {
      const response = await authenticatedFetch(
        `${apiBase}/api/diagnostics/bundle`,
      );
      if (!response.ok) {
        throw new Error('The diagnostics bundle could not be generated.');
      }
      return response.blob();
    },
    onSuccess: downloadDiagnosticsBundle,
  });

  return (
    <section
      className="developer-tab developer-tab--archive"
      aria-label="Archive"
    >
      <div className="developer-tab__header-row">
        <button
          type="button"
          className="editor-btn"
          disabled={diagnosticsBundle.isPending}
          onClick={() => diagnosticsBundle.mutate(undefined)}
        >
          {diagnosticsBundle.isPending
            ? 'Preparing…'
            : 'Download diagnostics bundle'}
        </button>
      </div>
      {diagnosticsBundle.isError ? (
        <p role="alert">Unable to generate the diagnostics bundle.</p>
      ) : null}
    </section>
  );
}
