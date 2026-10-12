import { CreatePlusButton } from './CreatePlusButton';
import './PickerCreateAction.css';

export function PickerCreateAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="picker-create-action">
      <CreatePlusButton label={label} onClick={() => onClick()} />
    </div>
  );
}
