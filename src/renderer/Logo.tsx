import iconUrl from './icon.png';

/** App icon plus the "TerminalTab" wordmark, matching logo/logo_with_text.jpg. */
export function Logo({ size = 22, text = true }: { size?: number; text?: boolean }) {
  return (
    <div className="logo" style={{ fontSize: size * 0.72 }}>
      <img src={iconUrl} width={size} height={size} alt="" draggable={false} />
      {text && (
        <span className="wordmark">
          Terminal<span className="wordmark-accent">Tab</span>
        </span>
      )}
    </div>
  );
}
