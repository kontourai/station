/**
 * The managed policy refusal codes (#4515), alone in a module because the
 * provider failure table, which the UI's first-load bundle carries, needs
 * them; importing them from `./managed-policy-status.js` would put that
 * whole module, and everything later chunks use from it, in the entry
 * chunk. `./managed-policy-status.js` and `./managed-policy.js` re-export
 * them.
 */

/**
 * The refusal code every surface uses for a capability the managed policy
 * turned off. Clients key on it to show the managed message instead of
 * offering a retry.
 */
export const MANAGED_POLICY_CAPABILITY_DISABLED_CODE =
  'managed-policy-capability-disabled' as const;

/**
 * #4519: the refusal code for remote access the managed policy forbids: a
 * pairing offer, a relay invitation, LAN discovery, or a credential of a
 * device paired before the policy. Clients key on it to show the managed
 * message instead of offering a retry.
 */
export const MANAGED_POLICY_REMOTE_CLIENTS_CODE =
  'managed-policy-remote-clients' as const;

/**
 * #4522: the refusal code every update surface answers with when the
 * managed policy forbids an update check, download or install. Clients key
 * on it to show the policy sentence instead of offering a retry.
 */
export const MANAGED_POLICY_UPDATES_REFUSED_CODE =
  'managed-policy-updates-refused' as const;

/**
 * #4520: the refusal code for an engine the managed policy does not allow,
 * and for a launch that cannot honor a locked pin. Clients key on it to show
 * the managed message instead of offering a retry.
 */
export const MANAGED_POLICY_ENGINE_REFUSED_CODE =
  'managed-policy-engine-refused' as const;
