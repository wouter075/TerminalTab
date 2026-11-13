import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { separator: true }
  | { separator?: false; label: string; shortcut?: string; disabled?: boolean; danger?: boolean; action(): void };

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

/** Small themed context menu, positioned at (x, y) and kept inside the window. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Capture phase so the click that closes the menu doesn't also reach the terminal.
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? 'danger-item' : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
