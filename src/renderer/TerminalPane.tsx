import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { EndReason, SessionInfo, SessionStatus } from '../shared/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { panes } from './panes';
import { subscribe } from './sessionBus';
import { fontStack, themeById } from './themes';
import { api, errMsg } from './util';

interface Props {
  tabId: string;
  connectionId: string;
  /** Bumping this re-opens the session in the same terminal (reconnect). */
  attempt: number;
  active: boolean;
  fontSize: number;
  fontFamily: string;
  theme: string;
  onStatus(status: SessionStatus, message?: string, reason?: EndReason): void;
  /** Current SSH session id (null while disconnected). */
  onSession(sessionId: string | null): void;
  onInfo(info: SessionInfo): void;
  onSize(cols: number, rows: number): void;
  onDuplicate(): void;
  onCloseTab(): void;
  onSnippets(): void;
  onToggleFiles(): void;
}

/** Keys the terminal must not swallow, so the app's shortcuts keep working. */
function isAppShortcut(e: KeyboardEvent): boolean {
  if (!e.ctrlKey) return false;
  if (e.code === 'KeyT' || e.code === 'KeyW' || e.code === 'Tab') return true;
  return e.shiftKey && (e.code === 'KeyP' || e.code === 'KeyE');
}

export function TerminalPane(props: Props) {
  const { tabId, connectionId, attempt, active, fontSize, fontFamily, theme } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  // Latest callbacks, so long-lived terminal handlers never call stale props.
  const cb = useRef(props);
  cb.current = props;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [find, setFind] = useState<{ open: boolean; term: string; caseSensitive: boolean; regex: boolean }>({
    open: false,
    term: '',
    caseSensitive: false,
    regex: false,
  });
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const colors = themeById(theme).colors;

  const setSession = (id: string | null) => {
    sessionRef.current = id;
    cb.current.onSession(id);
  };

  const openFind = useCallback(() => {
    const sel = termRef.current?.getSelection();
    setFind((f) => ({ ...f, open: true, term: sel && !sel.includes('\n') ? sel : f.term }));
    requestAnimationFrame(() => findInputRef.current?.select());
  }, []);

  // Create the terminal once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: fontStack(fontFamily),
      fontSize,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: colors,
    });
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    const offResults = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );

    // Copy on select, right-click menu, Ctrl+Shift+C / Ctrl+Shift+V, Ctrl+F.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => undefined);
    });
    const paste = () => navigator.clipboard.readText().then((t) => t && term.paste(t), () => undefined);
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
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        openFind();
        return false;
      }
      return !isAppShortcut(e);
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

    panes.set(tabId, {
      insert(text, run) {
        const sid = sessionRef.current;
        if (!sid) return false;
        term.paste(text); // honours bracketed paste, so multi-line text isn't run line by line
        if (run) api.write(sid, '\r');
        term.focus();
        return true;
      },
      focus: () => term.focus(),
    });

    return () => {
      panes.delete(tabId);
      offResults.dispose();
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
          cb.current.onStatus(e.status, e.message, e.reason);
          if (e.status === 'connecting' && e.message) term.write(`\x1b[90m${e.message}\x1b[0m\r\n`);
          if (e.status === 'error') term.write(`\r\n\x1b[31m✖ ${e.message ?? 'Error'}\x1b[0m\r\n`);
          if (e.status === 'closed') term.write(`\r\n\x1b[90m--- ${e.message ?? 'Disconnected'} ---\x1b[0m\r\n`);
          if (e.status === 'error' || e.status === 'closed') setSession(null);
        });
      })
      .catch((err) => {
        cb.current.onStatus('error', errMsg(err), 'lost');
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
    termRef.current.options.fontFamily = fontStack(fontFamily);
    fitRef.current?.fit();
  }, [fontSize, fontFamily]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = colors;
  }, [colors]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        if (!find.open) termRef.current?.focus();
        if (termRef.current) cb.current.onSize(termRef.current.cols, termRef.current.rows);
      });
    } else setMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---- search --------------------------------------------------------------
  const searchOptions = (incremental = false): ISearchOptions => ({
    caseSensitive: find.caseSensitive,
    regex: find.regex,
    incremental,
    decorations: {
      matchBackground: '#5a4a1a',
      matchOverviewRuler: '#e5c07b',
      activeMatchBackground: '#c08a1e',
      activeMatchColorOverviewRuler: '#ffb000',
    },
  });

  useEffect(() => {
    const search = searchRef.current;
    if (!search || !find.open) return;
    if (!find.term) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    try {
      search.findNext(find.term, searchOptions(true));
    } catch {
      setResults({ index: -1, count: 0 }); // invalid regex while typing
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.term, find.caseSensitive, find.regex, find.open]);

  const findStep = (back: boolean) => {
    const search = searchRef.current;
    if (!search || !find.term) return;
    try {
      if (back) search.findPrevious(find.term, searchOptions());
      else search.findNext(find.term, searchOptions());
    } catch {
      /* invalid regex */
    }
  };

  const closeFind = () => {
    searchRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    setFind((f) => ({ ...f, open: false }));
    setResults(null);
    termRef.current?.focus();
  };

  // ---- context menu --------------------------------------------------------
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
        { label: 'Find…', shortcut: 'Ctrl+F', action: openFind },
        { separator: true },
        { label: 'Snippets…', shortcut: 'Ctrl+Shift+P', disabled: !sessionRef.current, action: () => props.onSnippets() },
        { label: 'Files (SFTP)', shortcut: 'Ctrl+Shift+E', action: () => props.onToggleFiles() },
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
      <div
        className={`terminal-pane ${active ? 'active' : ''}`}
        style={{ background: colors.background, ['--term-bg' as string]: colors.background }}
      >
        <div className="terminal-host" ref={hostRef} />
        {find.open && (
          <div className="find-bar" onKeyDown={(e) => e.stopPropagation()}>
            <input
              ref={findInputRef}
              autoFocus
              placeholder="Find"
              value={find.term}
              onChange={(e) => setFind({ ...find, term: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  findStep(e.shiftKey);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  closeFind();
                }
              }}
            />
            <span className="find-count">
              {!find.term ? '' : results && results.count > 0 ? `${results.index + 1}/${results.count}` : 'No results'}
            </span>
            <button
              className={`icon-btn toggle ${find.caseSensitive ? 'on' : ''}`}
              title="Match case"
              onClick={() => setFind({ ...find, caseSensitive: !find.caseSensitive })}
            >
              Aa
            </button>
            <button
              className={`icon-btn toggle ${find.regex ? 'on' : ''}`}
              title="Regular expression"
              onClick={() => setFind({ ...find, regex: !find.regex })}
            >
              .*
            </button>
            <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => findStep(true)}>
              ↑
            </button>
            <button className="icon-btn" title="Next (Enter)" onClick={() => findStep(false)}>
              ↓
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={closeFind}>
              <Icon name="close" />
            </button>
          </div>
        )}
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
