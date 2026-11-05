import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ChangelogPreference } from './ChangelogPreference';
import { ReleaseHistory, ReleaseNotes } from './ReleaseNotes';

export function WhatsNewDialog({
  version,
  nativeApp,
  onClose,
}: {
  version: string;
  nativeApp: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={`Updated to Station ${version}`}
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
