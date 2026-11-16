import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { SessionInfo, SessionStatus } from '../shared/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { subscribe } from './sessionBus';
import { api, errMsg } from './util';

interface Props {
  connectionId: string;
  /** Bumping this re-opens the session in the same terminal (reconnect). */
  attempt: number;
  active: boolean;
  fontSize: number;
  onStatus(status: SessionStatus, message?: string): void;
  /** Current SSH session id (null while disconnected). */
  onSession(sessionId: string | null): void;
  onInfo(info: SessionInfo): void;
  onSize(cols: number, rows: number): void;
  onDuplicate(): void;
  onCloseTab(): void;
}

const THEME = {
  background: '#0f1115',
  foreground: '#d6dae2',
  cursor: '#8ab4ff',
  selectionBackground: '#2c3e66',
  black: '#1b1e25',
  brightBlack: '#5c6370',
  red: '#e06c75',
  brightRed: '#ff7a85',
  green: '#98c379',
  brightGreen: '#b5e890',
  yellow: '#e5c07b',
  brightYellow: '#ffd88a',
  blue: '#61afef',
  brightBlue: '#82c4ff',
  magenta: '#c678dd',
  brightMagenta: '#de97f5',
  cyan: '#56b6c2',
  brightCyan: '#7fd8e3',
  white: '#d6dae2',
  brightWhite: '#ffffff',
};

export function TerminalPane(props: Props) {
  const { connectionId, attempt, active, fontSize } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  // Latest callbacks, so long-lived terminal handlers never call stale props.
  const cb = useRef(props);
  cb.current = props;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const setSession = (id: string | null) => {
    sessionRef.current = id;
    cb.current.onSession(id);
  };

  // Create the terminal once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", "Courier New", monospace',
      fontSize,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    // Copy on select, right-click menu, Ctrl+Shift+C / Ctrl+Shift+V.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => undefined);
    });
    const paste = () =>
      navigator.clipboard.readText().then((t) => t && term.paste(t), () => undefined);
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    hostRef.current!.addEventListener('contextmenu', onContext);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => undefined);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        paste();
        return false;
      }
      // Let app-level shortcuts through to the window.
      if (e.ctrlKey && (e.code === 'KeyT' || e.code === 'KeyW' || e.code === 'Tab')) return false;
      return true;
    });

    term.onData((d) => sessionRef.current && api.write(sessionRef.current, d));
    term.onResize(({ cols, rows }) => {
      cb.current.onSize(cols, rows);
      if (sessionRef.current) api.resize(sessionRef.current, cols, rows);
    });

    const ro = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) fit.fit();
    });
    ro.observe(hostRef.current!);

    return () => {
      ro.disconnect();
      hostRef.current?.removeEventListener('contextmenu', onContext);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open (or re-open) the SSH session.
  useEffect(() => {
    const term = termRef.current!;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let sid: string | null = null;
    fitRef.current?.fit();
    if (attempt > 0) term.write('\r\n\x1b[90m--- reconnecting ---\x1b[0m\r\n');

    api
      .openSession(connectionId, term.cols, term.rows)
      .then((id) => {
        sid = id;
        if (cancelled) {
          api.closeSession(id);
          return;
        }
        setSession(id);
        unsubscribe = subscribe(id, (e) => {
          if (e.kind === 'data') {
            term.write(e.data);
            return;
          }
          if (e.kind === 'info') {
            cb.current.onInfo(e.info);
            return;
          }
          cb.current.onStatus(e.status, e.message);
          if (e.status === 'connecting' && e.message) term.write(`\x1b[90m${e.message}\x1b[0m\r\n`);
          if (e.status === 'error') term.write(`\r\n\x1b[31m✖ ${e.message ?? 'Error'}\x1b[0m\r\n`);
          if (e.status === 'closed') term.write(`\r\n\x1b[90m--- ${e.message ?? 'Disconnected'} ---\x1b[0m\r\n`);
          if (e.status === 'error' || e.status === 'closed') setSession(null);
        });
      })
      .catch((err) => {
        cb.current.onStatus('error', errMsg(err));
        term.write(`\r\n\x1b[31m✖ ${errMsg(err)}\x1b[0m\r\n`);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (sid) api.closeSession(sid);
      setSession(null);
    };
  }, [connectionId, attempt]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
        if (termRef.current) cb.current.onSize(termRef.current.cols, termRef.current.rows);
      });
    } else setMenu(null);
  }, [active]);

  const term = termRef.current;
  const menuItems: MenuItem[] = term
    ? [
        {
          label: 'Copy',
          shortcut: 'Ctrl+Shift+C',
          disabled: !term.hasSelection(),
          action: () => navigator.clipboard.writeText(term.getSelection()).catch(() => undefined),
        },
        {
          label: 'Paste',
          shortcut: 'Ctrl+Shift+V',
          disabled: !sessionRef.current,
          action: () => navigator.clipboard.readText().then((t) => t && term.paste(t), () => undefined),
        },
        { label: 'Select all', action: () => term.selectAll() },
        { separator: true },
        { label: 'Clear screen', action: () => term.clear() },
        { label: 'Duplicate tab', action: () => props.onDuplicate() },
        { separator: true },
        { label: 'Close tab', shortcut: 'Ctrl+W', danger: true, action: () => props.onCloseTab() },
      ]
    : [];

  return (
    <>
      {/* Padding lives on the outer pane: FitAddon measures the host's full height, so the host must have none. */}
      <div className={`terminal-pane ${active ? 'active' : ''}`}>
        <div className="terminal-host" ref={hostRef} />
      </div>
      {menu && active && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => {
            closeMenu();
            term?.focus();
          }}
        />
      )}
    </>
  );
}
