import { randomUUID } from 'node:crypto';
import type { DeviceAccessProposal } from '@kontourai/station-contracts/device-toolchain';
import type { DeviceToolchainService } from './toolchain/device-toolchain-service.js';

type Owner = { principalId: string; sessionId: string };

const MINUTE = 60_000;

export class DeviceAccessProposals {
  readonly #entries = new Map<
    string,
    { owner: Owner; proposal: DeviceAccessProposal }
  >();

  constructor(private readonly service: DeviceToolchainService) {}

  #read(id: string) {
    const entry = this.#entries.get(id);
    if (
      entry?.proposal.state === 'pending' &&
      entry.proposal.expiresAt <= Date.now()
    ) {
      entry.proposal = { ...entry.proposal, state: 'expired' };
    }
    return entry;
  }

  propose(owner: Owner) {
    if (this.service.agentAccessEnabled())
      return { ok: true, state: 'already-enabled' };
    for (const [id, entry] of this.#entries) {
      if (entry.proposal.expiresAt + 60 * MINUTE <= Date.now()) {
        this.#entries.delete(id);
      } else if (
        this.#read(id)?.proposal.state === 'pending' &&
        entry.owner.principalId === owner.principalId &&
        entry.owner.sessionId === owner.sessionId
      ) {
        return { ok: true, proposal: entry.proposal };
      }
    }
    if (this.#entries.size >= 256)
      return { ok: false, code: 'too-many-proposals' };
    const proposal: DeviceAccessProposal = {
      id: randomUUID(),
      state: 'pending',
      version: this.service.toolchain.pin('agent-device').version,
      expiresAt: Date.now() + 10 * MINUTE,
    };
    this.#entries.set(proposal.id, { owner, proposal });
    return { ok: true, proposal };
  }

  read(id: string, owner?: Owner) {
    const entry = this.#read(id);
    if (
      !entry ||
      (owner &&
        (entry.owner.principalId !== owner.principalId ||
          entry.owner.sessionId !== owner.sessionId))
    )
      return undefined;
    return entry.proposal;
  }

  decide(id: string, decision: 'approve' | 'decline') {
    const entry = this.#read(id);
    if (entry?.proposal.state !== 'pending') return entry?.proposal;
    if (decision === 'approve' && !this.service.agentAccessEnabled()) {
      this.service.setAgentAccess(true, { consent: true });
    }
    entry.proposal = {
      ...entry.proposal,
      state: decision === 'approve' ? 'approved' : 'declined',
    };
    return entry.proposal;
  }
}
