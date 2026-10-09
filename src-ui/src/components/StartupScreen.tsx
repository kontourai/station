/** The same first-paint surface used before and after React takes over. */
export function StartupScreen({
  message = 'Opening Station…',
}: {
  message?: string;
}) {
  return (
    <div
      className="station-startup"
      role="status"
      aria-label={message}
      aria-busy="true"
    >
      <img
        className="station-startup__logo"
        src="/favicon.png"
        alt=""
        width="64"
        height="64"
      />
      <div className="station-startup__status" aria-hidden="true">
        <span className="station-startup__name">Station</span>
        <span className="station-startup__message">{message}</span>
        <span className="station-startup__progress" />
      </div>
    </div>
  );
}
