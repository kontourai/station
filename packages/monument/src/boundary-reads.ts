/** The read-only boundary capability needed to admit queued input. */
export interface SessionTurnBoundaryReadAuthority {
  hasPossibleEffect(
    threadId: string,
  ): { kind: 'available'; active: boolean } | { kind: 'unavailable' };
}
