/** Keep the independent review outside the tool's description. */
export function GuardianApprovalReason({ reason }: { reason?: string }) {
  if (!reason) return null;
  return (
    <p className="attention-item__detail">
      <strong>Approval guardian</strong>
      <br />
      <q>{reason}</q>
    </p>
  );
}
