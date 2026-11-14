import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ChangelogPreference } from './ChangelogPreference';
import { ReleaseHistory, ReleaseNotes } from './ReleaseNotes';

export function WhatsNewDialog({
  version,
  nativeApp,
  serverKey,
  onClose,
}: {
  version: string;
  nativeApp: boolean;
  serverKey?: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={`Updated ${serverKey ? 'server' : 'to Station'} ${version}`}
      closeLabel="Close what’s new"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ReleaseNotes version={version} nativeApp={nativeApp} />
      <ReleaseHistory />
      <ChangelogPreference />
    </Dialog>
  );
}
