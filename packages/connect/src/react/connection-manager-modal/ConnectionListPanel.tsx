import { type Ref, useState } from 'react';
import { connectionFailureCopy } from '../../core/environmentProfiles';
import type { SavedConnection } from '../../core/types';
import { ConnectionStatusDot } from '../ConnectionStatusDot';
import {
  type ConnectionStatus,
  connectionCardMeta,
  connectionDisplayLabel,
  injectedConnectionDotStatus,
  injectedConnectionStateLabel,
} from '../connection-manager-modal-utils';

interface ConnectionListPanelProps {
  connections: SavedConnection[];
  activeConnectionId?: string;
  editingId: string | null;
  editName: string;
  editUrl: string;
  credentialEntry: string;
  allowManualCredentials?: boolean;
  getStatus: (connection: SavedConnection) => ConnectionStatus;
  /** A live access request owns this row until it reaches a terminal result. */
  pendingConnectionId?: string;
  onSelect: (connection: SavedConnection) => void;
  onCheck: (connection: SavedConnection) => void;
  onStartEdit: (connection: SavedConnection) => void;
  onRemove: (connectionId: string) => void;
  onEditNameChange: (value: string) => void;
  onEditUrlChange: (value: string) => void;
  onCredentialEntryChange: (value: string) => void;
  onRemoveCredential: (connectionId: string) => void;
  onConfirmEndpoint: (connection: SavedConnection) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onAddManual: () => void;
  /** Re-run the pairing/access-request exchange for one saved-but-unpaired connection. */
  onRequestAccess: (connection?: SavedConnection) => void;
  /** Explicit host-default action; omitted outside a shared-profile desktop. */
  onMakeDefaultProfile?: (connection: SavedConnection) => void;
  /**
   * Ask the native host to start its configured durable service. Wired only on
   * a desktop with a local service; elsewhere the not-running local row shows
   * its state without a Restart control.
   */
  onRestartInjectedConnection?: (connection: SavedConnection) => void;
  onScanQr: () => void;
  onEnterPairingCode: () => void;
  enterPairingCodeRef?: Ref<HTMLButtonElement>;
  onViewDevices: () => void;
  onDiscover: () => void;
  /**
   * station#1794 (part A): the "Other Stations" entry point is hidden
   * entirely while no discovery provider is registered
   * (`connectionCandidateProviderCount()` via `useConnectionCandidates`) —
   * `registerConnectionCandidateProvider` has no production caller on any
   * platform today, so without this the entry point is a navigable dead
   * end: a modal that can only ever report its own absence. The panel
   * component itself is untouched and becomes reachable the moment a
   * provider registers (part B, out of scope here).
   */
  discoveryAvailable: boolean;
}

/**
 * One saved-connection card in the Stations sheet's normal (non-editing)
 * row shape. Extracted from an inline per-item IIFE (station#4512 review,
 * M6) so Forget's confirm can own PER-ROW local state — the same shape
 * `PairedDeviceList.tsx`'s `DeviceRow` already uses for its own revoke
 * confirm (`confirming ? <Confirm/Cancel> : <normal actions>`), which is
 * the precedent `ConnectionBannerSource.tsx`'s identity-mismatch "Remove
 * connection" control names as its own mechanism's origin.
 */
function ConnectionRow({
  connection,
  activeConnectionId,
  pendingConnectionId,
  onSelect,
  onCheck,
  onStartEdit,
  onRemove,
  onConfirmEndpoint,
  onRequestAccess,
  onMakeDefaultProfile,
  onRestartInjectedConnection,
  getStatus,
}: {
  connection: SavedConnection;
  activeConnectionId?: string;
  pendingConnectionId?: string;
  onSelect: (connection: SavedConnection) => void;
  onCheck: (connection: SavedConnection) => void;
  onStartEdit: (connection: SavedConnection) => void;
  onRemove: (connectionId: string) => void;
  onConfirmEndpoint: (connection: SavedConnection) => void;
  onRequestAccess: (connection?: SavedConnection) => void;
  onMakeDefaultProfile?: (connection: SavedConnection) => void;
  onRestartInjectedConnection?: (connection: SavedConnection) => void;
  getStatus: (connection: SavedConnection) => ConnectionStatus;
}) {
  // station#4512 review (M6) — Forget removed a saved connection on a
  // SINGLE tap, with only a disabled `title` distinguishing it from every
  // other icon button in the row. Two deliberate taps now, and the confirm
  // step is also where "Removes it from this device only" lives — the one
  // statement of Forget's blast radius the sheet used to carry as a
  // standing header subtitle (station#4513 deleted that intro sentence).
  // Saying it only in the moment a reader is about to act on it is the more
  // honest home for a fact that was previously true of every row, all the
  // time, whether or not anyone was about to tap Forget.
  const [forgetArmed, setForgetArmed] = useState(false);

  // The desktop-supervised local server is always listed so its state is
  // visible even when it is not running. A not-running local server has no
  // base to select or probe, so the row is inert (state in place of URL, no
  // select/check/edit/remove) and offers only a Restart control.
  const localServerState = injectedConnectionStateLabel(connection);
  const isLocalServerDown = localServerState !== null;
  const isInjected = Boolean(connection.injected);
  const isSharedStationProfile = connection.id.startsWith('station-profile:');
  // A supervised local server's dot reflects its lifecycle phase (the
  // browser never health-probes the loopback base); everything else keeps
  // the active-id/health-driven dot.
  const dotStatus =
    injectedConnectionDotStatus(connection) ?? getStatus(connection);
  const meta = connectionCardMeta(
    connection,
    connection.id === pendingConnectionId,
  );

  return (
    <div
      className={`station-connect-row${connection.id === activeConnectionId ? ' station-connect-row--active' : ''}${isLocalServerDown ? ' station-connect-row--inactive' : ''}`}
    >
      {!isLocalServerDown && (
        <button
          type="button"
          className="station-connect-row__select"
          aria-label={`Select ${connectionDisplayLabel(connection)}`}
          aria-pressed={connection.id === activeConnectionId}
          onClick={() => onSelect(connection)}
        />
      )}
      <span className="station-connect-row__status">
        <ConnectionStatusDot status={dotStatus} size={8} />
      </span>
      <div className="station-connect-row__body">
        <div className="station-connect-row__name-line">
          <div className="station-connect-row__name">
            {connection.name || connection.url}
          </div>
          {connection.id === activeConnectionId && (
            <span className="station-connect-chip">Active</span>
          )}
        </div>
        {isLocalServerDown ? (
          <div role="status" className="station-connect-row__state">
            {localServerState}
          </div>
        ) : (
          <div className="station-connect-row__url">{connection.url}</div>
        )}
        {!isInjected && connection.endpoints.length > 1 && (
          <div className="station-connect-row__meta">
            {connection.endpoints.length} saved access paths
          </div>
        )}
        {/*
         * station#4513 — ONE status line for the card's dominant condition
         * (precedence: pending-approval > identity-mismatch >
         * authentication-failed > credential-required > any other observed
         * failure), instead of stacking every prose block a connection
         * happens to carry at once. The CLI-sharing note that used to
         * render here for a shared profile is dropped as redundant with
         * the disabled Edit button's own title/aria-label just below
         * (editing a shared profile is never reachable from this screen).
         * The full explanation (`connectionFailureCopy`'s `.action`
         * sentence) moves to the edit view instead of stacking here too —
         * see `ConnectionListPanel`'s edit-view branch (station#4512 review
         * L7: this used to say "see that block below", true before the M6
         * extraction pulled the non-editing row into its OWN component —
         * the edit view is a different branch of a ternary in a different
         * function now, not a sibling block in this one).
         *
         * station#4512 review (H2/L5): the status TEXT is its own `<span>`
         * with `role="status"` — a locator (and a screen reader's live
         * announcement) needs an element whose exact text IS the status,
         * not the status concatenated with a button's label (the old
         * single-`div` shape read "Credential requiredRequest access" as
         * one string — `tests/connect-remote-auth-recovery.spec.ts` expects
         * an exact-text `Credential required`). The action button sits
         * OUTSIDE the `role="status"` node for the same reason blocking a
         * device's approval banner from re-reading itself on every render
         * would be wrong here too: an interactive control inside a live
         * region gets announced as part of the status update, which is not
         * what a live region is for.
         */}
        {meta && (
          <div className="station-connect-row__meta station-connect-row__meta--warning">
            <span role="status">{meta.line}</span>
            {meta.action === 'request-access' && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRequestAccess(connection);
                }}
                aria-label={meta.actionAriaLabel}
                className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
              >
                {meta.actionLabel}
              </button>
            )}
          </div>
        )}
        {forgetArmed && (
          <div
            role="status"
            className="station-connect-row__meta station-connect-row__meta--warning"
          >
            Removes it from this device only.
          </div>
        )}
        {connection.endpointCandidate && (
          <div className="station-connect-row__meta station-connect-row__meta--warning">
            Proposed endpoint: {connection.endpointCandidate.url}
            {connection.endpointCandidate.state === 'confirmation-required' && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onConfirmEndpoint(connection);
                }}
                className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
              >
                Verify and use endpoint
              </button>
            )}
            {connection.endpointCandidate.state === 'verification-failed' &&
              ' (verification failed)'}
          </div>
        )}
      </div>
      <div className="station-connect-row__actions">
        {isInjected ? (
          // The local server is host-managed: it is neither editable nor
          // removable from here (the store no-ops those anyway), so its
          // only affordance is restarting it when it is down.
          isLocalServerDown &&
          onRestartInjectedConnection && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRestartInjectedConnection(connection);
              }}
              className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
            >
              Restart
            </button>
          )
        ) : forgetArmed ? (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setForgetArmed(false);
                onRemove(connection.id);
              }}
              aria-label={`Confirm forgetting ${connectionDisplayLabel(connection)}`}
              className="station-connect-btn station-connect-btn--danger station-connect-btn--inline"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setForgetArmed(false);
              }}
              className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {onMakeDefaultProfile && isSharedStationProfile && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onMakeDefaultProfile(connection);
                }}
                title="Make this the CLI default"
                aria-label={`Make ${connectionDisplayLabel(connection)} the CLI default`}
                className="station-connect-icon-btn"
              >
                ★
              </button>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCheck(connection);
              }}
              title="Check reachability"
              aria-label="Check reachability"
              className="station-connect-icon-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onStartEdit(connection);
              }}
              disabled={isSharedStationProfile}
              title={
                isSharedStationProfile
                  ? 'Edit this Station with station stations'
                  : 'Edit Station'
              }
              aria-label={
                isSharedStationProfile
                  ? 'Shared Station editing is available in the CLI'
                  : 'Edit Station'
              }
              className="station-connect-icon-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setForgetArmed(true);
              }}
              disabled={isSharedStationProfile}
              title={
                isSharedStationProfile
                  ? 'Forget this Station with station stations'
                  : 'Forget Station'
              }
              aria-label={
                isSharedStationProfile
                  ? 'Shared Station forgetting is available in the CLI'
                  : 'Forget Station'
              }
              className="station-connect-icon-btn station-connect-icon-btn--danger"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ConnectionListPanel({
  connections,
  activeConnectionId,
  editingId,
  editName,
  editUrl,
  credentialEntry,
  allowManualCredentials = true,
  getStatus,
  pendingConnectionId,
  onSelect,
  onCheck,
  onStartEdit,
  onRemove,
  onEditNameChange,
  onEditUrlChange,
  onCredentialEntryChange,
  onRemoveCredential,
  onConfirmEndpoint,
  onSaveEdit,
  onCancelEdit,
  onAddManual,
  onRequestAccess,
  onMakeDefaultProfile,
  onRestartInjectedConnection,
  onScanQr,
  onEnterPairingCode,
  enterPairingCodeRef,
  onViewDevices,
  onDiscover,
  discoveryAvailable,
}: ConnectionListPanelProps) {
  return (
    <>
      <div className="station-connect-list">
        {connections.length === 0 && (
          <p className="station-connect-empty">No Stations saved yet.</p>
        )}
        {connections.map((connection) =>
          editingId === connection.id ? (
            <div key={connection.id} className="station-connect-edit">
              {/*
               * station#4513 — the full explanation the row's own one-line
               * meta collapsed to a summary. This is the ONE other place it
               * may render (never alongside the row's short line, since the
               * row is not shown while editing this same card).
               */}
              {connection.lastError &&
                connection.lastError.reason !== 'awaiting-approval' && (
                  <div
                    role="status"
                    className="station-connect-row__meta station-connect-row__meta--warning"
                  >
                    {(() => {
                      const failureCopy = connectionFailureCopy(
                        connection.lastError.reason,
                        connectionDisplayLabel(connection),
                        connection.url,
                      );
                      return `${failureCopy.summary} ${failureCopy.action}`;
                    })()}
                  </div>
                )}
              <input
                type="text"
                value={editName}
                onChange={(event) => onEditNameChange(event.target.value)}
                placeholder="Name"
                className="station-connect-input"
              />
              <input
                type="text"
                value={editUrl}
                onChange={(event) => onEditUrlChange(event.target.value)}
                placeholder="http://192.168.1.x:3141"
                className="station-connect-input"
              />
              {allowManualCredentials && (
                <label className="station-connect-edit__label">
                  {connection.credentialState === 'device-session'
                    ? 'Paired device session'
                    : connection.credentialState === 'saved'
                      ? 'Replace access credential'
                      : 'Remote access credential'}
                  {connection.credentialState === 'device-session' ? (
                    <span className="station-connect-edit__hint">
                      This browser keeps its paired-device credential in a
                      secure, HttpOnly cookie. Use the host's paired-device list
                      to revoke it. Enter an operator credential below only as
                      another direct connection method.
                    </span>
                  ) : connection.credentialState !== 'saved' ? (
                    <span className="station-connect-edit__hint">
                      Station protects remote connections with a credential
                      generated on the host computer. Localhost does not require
                      one. On the host, run{' '}
                      <code>./station environment credential show</code>, then
                      paste the result below.
                    </span>
                  ) : null}
                  <input
                    type="password"
                    value={credentialEntry}
                    onChange={(event) =>
                      onCredentialEntryChange(event.target.value)
                    }
                    placeholder={
                      connection.credentialState === 'saved'
                        ? 'Enter a replacement'
                        : connection.credentialState === 'device-session'
                          ? 'Optional operator credential'
                          : 'Paste the Station environment credential'
                    }
                    autoComplete="off"
                    aria-label="Station access credential"
                    className="station-connect-input"
                  />
                </label>
              )}
              <div className="station-connect-btn-row">
                <button
                  type="button"
                  onClick={onSaveEdit}
                  className="station-connect-btn station-connect-btn--primary"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="station-connect-btn station-connect-btn--secondary"
                >
                  Cancel
                </button>
                {allowManualCredentials &&
                  connection.credentialState === 'saved' && (
                    <button
                      type="button"
                      onClick={() => onRemoveCredential(connection.id)}
                      className="station-connect-btn station-connect-btn--secondary"
                    >
                      Remove credential
                    </button>
                  )}
              </div>
            </div>
          ) : (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              activeConnectionId={activeConnectionId}
              pendingConnectionId={pendingConnectionId}
              onSelect={onSelect}
              onCheck={onCheck}
              onStartEdit={onStartEdit}
              onRemove={onRemove}
              onConfirmEndpoint={onConfirmEndpoint}
              onRequestAccess={onRequestAccess}
              onMakeDefaultProfile={onMakeDefaultProfile}
              onRestartInjectedConnection={onRestartInjectedConnection}
              getStatus={getStatus}
            />
          ),
        )}
      </div>

      <div className="station-connect-footer">
        {/* station#4513: the second of the sheet's two intro sentences —
            deleted; the labeled buttons below already say what each does. */}
        <button
          type="button"
          onClick={() => onRequestAccess()}
          className="station-connect-btn station-connect-btn--primary"
        >
          Request access
        </button>
        <button
          type="button"
          onClick={onAddManual}
          className="station-connect-btn station-connect-btn--secondary"
        >
          Add a Station address
        </button>
        <button
          type="button"
          onClick={onScanQr}
          className="station-connect-btn station-connect-btn--secondary"
        >
          Scan a QR code
        </button>
        <button
          ref={enterPairingCodeRef}
          type="button"
          onClick={onEnterPairingCode}
          className="station-connect-btn station-connect-btn--secondary"
        >
          Enter a pairing code
        </button>
        {discoveryAvailable && (
          <button
            type="button"
            onClick={onDiscover}
            className="station-connect-btn station-connect-btn--secondary"
          >
            Find other Stations
          </button>
        )}
        <button
          type="button"
          onClick={onViewDevices}
          className="station-connect-footer__devices"
        >
          Paired devices
        </button>
      </div>
    </>
  );
}
