import { useState } from 'react';
import { Button } from '../Button';
import { EngineSignInPanel } from './EngineSignInPanel';

/**
 * The sign-in panel behind one button, for the add flow's "Setup required"
 * result. Nothing is read from the server until the person opens it, so the
 * result itself stays a plain rendering of the add attempt.
 */
export function EngineSignInDisclosure({
  connectionId,
  engineName,
}: {
  connectionId: string;
  engineName: string;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <EngineSignInPanel connectionId={connectionId} />;
  return (
    <span className="acp-add-dialog__result-action">
      <Button size="sm" onClick={() => setOpen(true)}>
        Sign in to {engineName}
      </Button>
    </span>
  );
}
