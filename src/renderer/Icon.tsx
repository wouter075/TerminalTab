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
  snippet: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14',
  gear: 'M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  folder: 'M3 6.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1h-8l-2-2.5H4a1 1 0 0 0-1 1.5z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  link: 'M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7L12 7M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7L12 17',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  up: 'M12 19V5M6 11l6-6 6 6',
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  newFolder: 'M3 6.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1h-8l-2-2.5H4a1 1 0 0 0-1 1.5zM12 10.5v6M9 13.5h6',
  files: 'M3 6.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1h-8l-2-2.5H4a1 1 0 0 0-1 1.5zM7 12h10M7 15h6',
  import: 'M12 3v11M7 9l5 5 5-5M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4',
  close: 'M6 6l12 12M18 6L6 18',
  prompt: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
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
