/**
 * Small line icons drawn inline, so they look the same everywhere. Emoji such as 🔑 or 🔒
 * show up as empty boxes on Linux systems without an emoji font.
 */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  key: 'M14.5 9.5a4 4 0 1 0-1.2 2.8L20 19M17 16l2-2M15 14l1.5-1.5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  trash: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, title }: { name: IconName; title?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
