import { StationExtensionsAccess } from '../../components/registry/StationExtensionsAccess';
import type { PreviewData } from './types';

export function InstallPreviewExtensionAccess({
  preview,
}: {
  preview: PreviewData;
}) {
  const customCode = preview.hasBundle || Boolean(preview.manifest?.entrypoint);
  return customCode ? (
    <StationExtensionsAccess onlyWhenOff installation />
  ) : null;
}
