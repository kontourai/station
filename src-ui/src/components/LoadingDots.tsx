type Props = {
  className?: string;
};

export function LoadingDots({ className }: Props) {
  return (
    <span className={`loading-dots-inline ${className || ''}`}>
      <span>●</span>
      <span>●</span>
      <span>●</span>
    </span>
  );
}
