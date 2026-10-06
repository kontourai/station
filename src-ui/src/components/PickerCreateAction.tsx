import { Button } from './Button';
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
      <Button
        variant="primary"
        className="picker-create-action__button"
        aria-label={label}
        title={label}
        onClick={onClick}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M10 4v12M4 10h12" />
        </svg>
      </Button>
    </div>
  );
}
