import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../shared/api';
import type {
  ConnectionInfo,
  EndReason,
  HostKeyPrompt,
  LocalShell,
  SessionInfo,
  SessionStatus,
  SyncStatus,
  TransferProgress,
  UpdateInfo,
  VaultState,
} from '../shared/types';
import { DEFAULT_SETTINGS, isLocalTarget, LOCAL_PREFIX, localShellId } from '../shared/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { COLORS, ConnectionDialog } from './ConnectionDialog';
import { Icon } from './Icon';
import { ImportDialog } from './ImportDialog';
import { KeysDialog } from './KeysDialog';
import { Logo } from './Logo';
import { Modal } from './Modal';
import { Palette } from './Palette';
import { panes } from './panes';
import { SettingsDialog } from './SettingsDialog';
import { SftpPanel, shellQuote } from './SftpPanel';
import { Sidebar } from './Sidebar';
import { SnippetsDialog } from './SnippetsDialog';
import { StatusBar } from './StatusBar';
import { TerminalPane } from './TerminalPane';
import { UnlockScreen } from './UnlockScreen';
import { api } from './util';

interface Tab {
  id: string;
  /** Connection id, or `local:<shell id>` for a shell on this PC. */
  connectionId: string;
  attempt: number;
  status: SessionStatus;
  message?: string;
  sessionId?: string | null;
  info?: SessionInfo;
  cols?: number;
  rows?: number;
  /** The tab was connected at least once (so a drop is worth reconnecting). */
  wasConnected?: boolean;
  /** Automatic reconnect: when the next try happens, and how many tries so far. */
  retryAt?: number;
  retries?: number;
  /** Name / colour set for this tab only (right-click a tab). color 'none' hides the server's colour. */
  title?: string;
  color?: string;
  /** SFTP side panel. */
  files?: boolean;
  filesPath?: string;
}

type Dialog =
  | { kind: 'conn'; connection?: ConnectionInfo }
  | { kind: 'keys' }
  | { kind: 'settings' }
  | { kind: 'snippets' }
  | { kind: 'import' }
  | null;

const EMPTY: AppData = { connections: [], keys: [], snippets: [], settings: DEFAULT_SETTINGS };
/** Seconds to wait before each automatic reconnect attempt. */
const RETRY_DELAYS = [2, 5, 10, 30];
const SFTP_WIDTH_KEY = 'terminaltab.sftpWidth';
let tabSeq = 0;

function loadSftpWidth(): number {
  try {
    return Number(localStorage.getItem(SFTP_WIDTH_KEY)) || 380;
  } catch {
    return 380;
  }
}

export function App() {
  const [vaultState, setVaultState] = useState<VaultState | null>(null);
  const [data, setData] = useState<AppData>(EMPTY);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [palette, setPalette] = useState<{ snippetsOnly: boolean } | null>(null);
  const [hostPrompts, setHostPrompts] = useState<HostKeyPrompt[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'off' });
  const [transfers, setTransfers] = useState<Map<string, TransferProgress>>(new Map());
  const [update, setUpdate] = useState<UpdateInfo>({ state: 'none' });
  const [sftpWidth, setSftpWidth] = useState(loadSftpWidth);
  const [now, setNow] = useState(Date.now());
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef(data.settings);
  settingsRef.current = data.settings;

  const refresh = useCallback(async () => {
    const state = await api.vaultState();
    setVaultState(state);
    if (state === 'unlocked') {
      setData(await api.getData());
      setSyncStatus(await api.syncStatus());
    }
  }, []);

  useEffect(() => {
    refresh();
    api.updateStatus().then(setUpdate, () => undefined);
    const offs = [
      api.onLocked(() => {
        setVaultState('locked');
        setDialog(null);
        setPalette(null);
        (document.activeElement as HTMLElement | null)?.blur();
      }),
      api.onHostKeyPrompt((p) => setHostPrompts((ps) => [...ps, p])),
      api.onSyncStatus(setSyncStatus),
      // Servers/keys/snippets changed by a sync from another PC.
      api.onDataChanged(() => {
        api.getData().then(setData, () => undefined);
      }),
      api.onTransfer((p) =>
        setTransfers((m) => {
          const next = new Map(m);
          if (p.state === 'running') next.set(p.id, p);
          else next.delete(p.id);
          return next;
        }),
      ),
      api.onUpdate(setUpdate),
    ];
    return () => offs.forEach((off) => off());
  }, [refresh]);

  // Shells on this PC (detected once in the main process).
  useEffect(() => {
    if (vaultState === 'unlocked') api.localShells().then(setShells, () => undefined);
  }, [vaultState]);

  useEffect(() => {
    try {
      localStorage.setItem(SFTP_WIDTH_KEY, String(sftpWidth));
    } catch {
      /* private mode */
    }
  }, [sftpWidth]);

  const connById = useMemo(() => new Map(data.connections.map((c) => [c.id, c])), [data.connections]);
  const shellById = useMemo(() => new Map(shells.map((s) => [s.id, s])), [shells]);
  const defaultShell = shellById.get(data.settings.defaultShell) ?? shells[0];
  const defaultTitle = (t: Tab) =>
    isLocalTarget(t.connectionId)
      ? (shellById.get(localShellId(t.connectionId))?.name ?? 'Local shell')
      : (connById.get(t.connectionId)?.name ?? 'Deleted server');
  const tabTitle = (t: Tab) => t.title ?? defaultTitle(t);
  /** Colour shown on the tab: its own, else the server's ('' = none). */
  const tabColor = (t: Tab) => (t.color === 'none' ? '' : (t.color ?? connById.get(t.connectionId)?.color ?? ''));
  const openCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tabs) m.set(t.connectionId, (m.get(t.connectionId) ?? 0) + 1);
    return m;
  }, [tabs]);

  const connect = useCallback((connectionId: string) => {
    const id = `tab-${++tabSeq}`;
    setTabs((ts) => [...ts, { id, connectionId, attempt: 0, status: 'connecting' }]);
    setActiveId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? (next[Math.min(i, next.length - 1)]?.id ?? null) : cur));
      return next;
    });
  }, []);

  const openShell = useCallback((shellId: string) => connect(LOCAL_PREFIX + shellId), [connect]);

  const patchTab = useCallback(
    (id: string, patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [],
  );

  const reconnect = useCallback(
    (id: string, manual = true) =>
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id
            ? {
                ...t,
                attempt: t.attempt + 1,
                status: 'connecting',
                info: undefined,
                retryAt: undefined,
                retries: manual ? 0 : t.retries,
              }
            : t,
        ),
      ),
    [],
  );

  /** Status from a terminal pane; schedules an automatic reconnect when the connection was lost. */
  const onTabStatus = useCallback((id: string, status: SessionStatus, message?: string, reason?: EndReason) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        if (status === 'connected') return { ...t, status, message, wasConnected: true, retries: 0, retryAt: undefined };
        if (status !== 'closed' && status !== 'error') return { ...t, status, message };
        const retries = t.retries ?? 0;
        const retry =
          reason === 'lost' && t.wasConnected && settingsRef.current.autoReconnect && retries < RETRY_DELAYS.length;
        return {
          ...t,
          status,
          message,
          retryAt: retry ? Date.now() + RETRY_DELAYS[retries] * 1000 : undefined,
          retries: retry ? retries + 1 : retries,
        };
      }),
    );
  }, []);

  // Drive automatic reconnects (and the countdown shown in the reconnect bar).
  const pendingRetry = tabs.some((t) => t.retryAt);
  useEffect(() => {
    if (!pendingRetry) return;
    const timer = setInterval(() => {
      const t0 = Date.now();
      setNow(t0);
      if (vaultState !== 'unlocked') return; // wait until unlocked
      for (const t of tabs) if (t.retryAt && t.retryAt <= t0) reconnect(t.id, false);
    }, 250);
    return () => clearInterval(timer);
  }, [pendingRetry, tabs, vaultState, reconnect]);

  // Live status-bar info is only collected for the tab being viewed.
  const activeTab = tabs.find((t) => t.id === activeId);
  const activeSessionId = activeTab?.sessionId ?? null;
  useEffect(() => {
    api.watchSession(activeSessionId);
  }, [activeSessionId]);

  const toggleFiles = useCallback(
    (id?: string | null) => {
      const tabId = id ?? activeId;
      if (!tabId) return;
      setTabs((ts) =>
        ts.map((t) => (t.id === tabId && !isLocalTarget(t.connectionId) ? { ...t, files: !t.files } : t)),
      );
    },
    [activeId],
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (vaultState !== 'unlocked' || !e.ctrlKey) return;
      if (e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        setPalette((p) => (p ? null : { snippetsOnly: false }));
      } else if (e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        toggleFiles();
      } else if (e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        if (defaultShell) openShell(defaultShell.id);
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.code === 'KeyW' && activeId) {
        e.preventDefault();
        closeTab(activeId);
      } else if (e.code === 'Tab' && tabs.length > 1) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === activeId);
        const n = (i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        setActiveId(tabs[n].id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [vaultState, activeId, tabs, closeTab, toggleFiles, defaultShell, openShell]);

  const answerHost = (trust: boolean) => {
    const [p, ...rest] = hostPrompts;
    if (!p) return;
    api.answerHostKey(p.requestId, trust);
    setHostPrompts(rest);
  };

  // The input's blur fires after Enter / Esc too; only the first ending counts.
  const renameDone = useRef(false);
  const lastRenamed = useRef<string | null>(null);
  useEffect(() => {
    renameDone.current = false;
    if (renamingId) lastRenamed.current = renamingId;
    else if (lastRenamed.current) {
      // Back to the terminal once the input is gone (focusing earlier loses it to <body>).
      const id = lastRenamed.current;
      lastRenamed.current = null;
      setTimeout(() => panes.get(id)?.focus(), 0);
    }
  }, [renamingId]);
  const finishRename = (id: string, value: string | null) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setRenamingId(null);
    if (value !== null) {
      const name = value.trim();
      setTabs((ts) =>
        ts.map((t) => (t.id === id ? { ...t, title: name && name !== defaultTitle(t) ? name : undefined } : t)),
      );
    }
  };

  /** Keep this tab's name and colour on the saved server (synced to other PCs too). */
  const saveTabToServer = async (t: Tab) => {
    const c = connById.get(t.connectionId);
    if (!c) return;
    await api.saveConnection({
      id: c.id,
      name: t.title ?? c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      keyId: c.keyId,
      group: c.group,
      color: t.color === undefined ? c.color : t.color === 'none' ? '' : t.color,
    });
    setTabs((ts) => ts.map((x) => (x.connectionId === c.id ? { ...x, title: undefined, color: undefined } : x)));
    await refresh();
  };

  const tabMenuItems = (t: Tab): MenuItem[] => {
    const local = isLocalTarget(t.connectionId);
    const custom = t.title !== undefined || t.color !== undefined;
    const conn = connById.get(t.connectionId);
    return [
      { label: 'Rename tab…', shortcut: 'Double-click', action: () => setRenamingId(t.id) },
      {
        swatches: COLORS,
        selected: tabColor(t),
        label: 'Colour',
        onPick: (color) => patchTab(t.id, { color: color === (conn?.color ?? '') ? undefined : color || 'none' }),
      },
      ...(custom
        ? [
            { label: 'Reset name and colour', action: () => patchTab(t.id, { title: undefined, color: undefined }) },
            ...(!local && conn
              ? [{ label: 'Save as server name and colour', action: () => void saveTabToServer(t) }]
              : []),
          ]
        : []),
      { separator: true },
      { label: 'Duplicate tab', action: () => connect(t.connectionId) },
      { label: 'Close tab', shortcut: 'Ctrl+W', danger: true, action: () => closeTab(t.id) },
    ];
  };

  const closePalette = useCallback(() => {
    setPalette(null);
    if (activeId) requestAnimationFrame(() => panes.get(activeId)?.focus());
  }, [activeId]);

  if (vaultState === null) return null;

  const prompt = hostPrompts[0];
  const activeConnected = !!activeTab?.sessionId && activeTab.status === 'connected';
  const activeTransfers = [...transfers.values()].filter((t) => t.sessionId === activeTab?.sessionId);
  const activeIsLocal = !!activeTab && isLocalTarget(activeTab.connectionId);
  const activeLocal = activeIsLocal ? shellById.get(localShellId(activeTab.connectionId)) : undefined;

  return (
    <>
      {vaultState === 'unlocked' || tabs.length > 0 ? (
        <div className="layout">
          <Sidebar
            ref={searchRef}
            connections={data.connections}
            shells={shells}
            openCounts={openCounts}
            onConnect={connect}
            onOpenShell={openShell}
            onEdit={(c) => setDialog({ kind: 'conn', connection: c })}
            onAdd={() => setDialog({ kind: 'conn' })}
            onImport={() => setDialog({ kind: 'import' })}
            onKeys={() => setDialog({ kind: 'keys' })}
            onSnippets={() => setDialog({ kind: 'snippets' })}
            onSettings={() => setDialog({ kind: 'settings' })}
            onLock={() => api.lock()}
            syncStatus={syncStatus}
            update={update}
          />
          <main className="main">
            <div className="tabbar">
              <div className="tabs">
                {tabs.map((t) => {
                  const local = isLocalTarget(t.connectionId);
                  const color = tabColor(t);
                  return (
                    <div
                      key={t.id}
                      className={`tab ${t.id === activeId ? 'active' : ''}`}
                      style={{ borderTopColor: color || undefined }}
                      onMouseDown={(e) => {
                        if (renamingId === t.id) return;
                        if (e.button === 1) {
                          e.preventDefault();
                          closeTab(t.id);
                        } else setActiveId(t.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setActiveId(t.id);
                        setTabMenu({ id: t.id, x: e.clientX, y: e.clientY });
                      }}
                      onDoubleClick={() => setRenamingId(t.id)}
                      title={t.title ? `${t.title} — ${defaultTitle(t)}${t.message ? `\n${t.message}` : ''}` : t.message}
                    >
                      <span className={`status-dot ${t.retryAt ? 'connecting' : t.status}`} />
                      {local && (
                        <span className="tab-kind" title="Shell on this PC">
                          <Icon name="prompt" />
                        </span>
                      )}
                      {renamingId === t.id ? (
                        <input
                          className="tab-rename"
                          autoFocus
                          defaultValue={tabTitle(t)}
                          aria-label="Tab name"
                          onFocus={(e) => e.target.select()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') finishRename(t.id, e.currentTarget.value);
                            else if (e.key === 'Escape') finishRename(t.id, null);
                          }}
                          onBlur={(e) => finishRename(t.id, e.currentTarget.value)}
                        />
                      ) : (
                        <span className="tab-title">{tabTitle(t)}</span>
                      )}
                      <button
                        className="tab-close"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => closeTab(t.id)}
                        aria-label="Close tab"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {shells.length > 0 && (
                  <button
                    className="icon-btn new-shell"
                    title={`New local shell${defaultShell ? ` (Ctrl+Shift+T opens ${defaultShell.name})` : ''}`}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setShellMenu({ x: r.left, y: r.bottom + 4 });
                    }}
                  >
                    <Icon name="plus" />
                  </button>
                )}
              </div>
              {tabMenu && tabs.some((t) => t.id === tabMenu.id) && (
                <ContextMenu
                  x={tabMenu.x}
                  y={tabMenu.y}
                  onClose={() => setTabMenu(null)}
                  items={tabMenuItems(tabs.find((t) => t.id === tabMenu.id)!)}
                />
              )}
              {shellMenu && (
                <ContextMenu
                  x={shellMenu.x}
                  y={shellMenu.y}
                  onClose={() => setShellMenu(null)}
                  items={shells.map((sh) => ({
                    label: sh.name,
                    shortcut: sh.id === defaultShell?.id ? 'Ctrl+Shift+T' : undefined,
                    action: () => openShell(sh.id),
                  }))}
                />
              )}
              {activeTab && (
                <div className="tabbar-actions">
                  <button
                    className="icon-btn"
                    title="Snippets (Ctrl+Shift+P)"
                    onClick={() => setPalette({ snippetsOnly: true })}
                  >
                    <Icon name="snippet" />
                  </button>
                  {!activeIsLocal && (
                    <button
                      className={`icon-btn ${activeTab.files ? 'on' : ''}`}
                      title="Files — SFTP (Ctrl+Shift+E)"
                      onClick={() => toggleFiles()}
                    >
                      <Icon name="files" />
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="terminals">
              <div className="terminal-area">
                {tabs.map((t) => (
                  <TerminalPane
                    key={t.id}
                    tabId={t.id}
                    connectionId={t.connectionId}
                    attempt={t.attempt}
                    active={t.id === activeId && vaultState === 'unlocked' && !palette}
                    fontSize={data.settings.fontSize}
                    fontFamily={data.settings.fontFamily}
                    theme={data.settings.theme}
                    onStatus={(status, message, reason) => onTabStatus(t.id, status, message, reason)}
                    onSession={(sessionId) => patchTab(t.id, { sessionId })}
                    onInfo={(info) => patchTab(t.id, { info })}
                    onSize={(cols, rows) => patchTab(t.id, { cols, rows })}
                    onDuplicate={() => connect(t.connectionId)}
                    onCloseTab={() => closeTab(t.id)}
                    onSnippets={() => setPalette({ snippetsOnly: true })}
                    onToggleFiles={() => toggleFiles(t.id)}
                  />
                ))}
                {activeTab && (activeTab.status === 'closed' || activeTab.status === 'error') && (
                  <div className="reconnect-bar">
                    <span>
                      {activeTab.retryAt
                        ? `${activeTab.message ?? 'Connection lost'} — reconnecting in ${Math.max(
                            0,
                            Math.ceil((activeTab.retryAt - now) / 1000),
                          )} s…`
                        : (activeTab.message ?? 'Disconnected')}
                    </span>
                    <button className="primary" onClick={() => reconnect(activeTab.id)}>
                      {activeTab.retryAt ? 'Now' : activeIsLocal ? 'Restart' : 'Reconnect'}
                    </button>
                    {activeTab.retryAt ? (
                      <button onClick={() => patchTab(activeTab.id, { retryAt: undefined })}>Cancel</button>
                    ) : (
                      <button onClick={() => closeTab(activeTab.id)}>Close tab</button>
                    )}
                  </div>
                )}
                {tabs.length === 0 && (
                  <div className="empty-state">
                    <Logo size={88} text={false} />
                    <p>Pick a server on the left to open it in a new tab.</p>
                    {defaultShell && (
                      <p>
                        <button onClick={() => openShell(defaultShell.id)}>
                          <Icon name="prompt" /> Open {defaultShell.name}
                        </button>
                      </p>
                    )}
                    <p className="muted small">
                      Ctrl+T search · Ctrl+Shift+T local shell · Ctrl+W close tab · Ctrl+Tab next tab · Ctrl+F find · Ctrl+Shift+P snippets ·
                      Ctrl+Shift+E files · select to copy · right-click for more
                    </p>
                  </div>
                )}
              </div>
              {activeTab?.files && (
                <SftpPanel
                  key={activeTab.id}
                  sessionId={activeConnected ? activeTab.sessionId! : null}
                  path={activeTab.filesPath}
                  width={sftpWidth}
                  transfers={activeTransfers}
                  onPath={(p) => patchTab(activeTab.id, { filesPath: p })}
                  onWidth={setSftpWidth}
                  onCd={(p) => panes.get(activeTab.id)?.insert(`cd ${shellQuote(p)}`, true)}
                  onClose={() => toggleFiles(activeTab.id)}
                />
              )}
            </div>
            {activeTab && (
              <StatusBar
                local={activeIsLocal ? (activeLocal?.name ?? 'Local shell') : undefined}
                connection={connById.get(activeTab.connectionId)}
                keyInfo={data.keys.find((k) => k.id === connById.get(activeTab.connectionId)?.keyId)}
                status={activeTab.status}
                message={activeTab.message}
                info={activeTab.info}
                cols={activeTab.cols}
                rows={activeTab.rows}
                statsEnabled={data.settings.serverStats}
              />
            )}
          </main>
        </div>
      ) : null}

      {vaultState !== 'unlocked' && (
        <div className="lock-overlay">
          <UnlockScreen mode={vaultState === 'missing' ? 'create' : 'unlock'} onUnlocked={refresh} />
        </div>
      )}

      {vaultState === 'unlocked' && palette && (
        <Palette
          snippets={data.snippets}
          connections={data.connections}
          shells={shells}
          onShell={openShell}
          canInsert={activeConnected}
          snippetsOnly={palette.snippetsOnly}
          onSnippet={(s) => activeId && panes.get(activeId)?.insert(s.command, s.run)}
          onServer={connect}
          onManageSnippets={() => setDialog({ kind: 'snippets' })}
          onClose={closePalette}
        />
      )}

      {vaultState === 'unlocked' && dialog?.kind === 'conn' && (
        <ConnectionDialog
          data={data}
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          onSaved={async (connectId) => {
            setDialog(null);
            await refresh();
            if (connectId) connect(connectId);
          }}
        />
      )}
      {vaultState === 'unlocked' && dialog?.kind === 'keys' && (
        <KeysDialog keys={data.keys} connections={data.connections} onClose={() => setDialog(null)} onChanged={refresh} />
      )}
      {vaultState === 'unlocked' && dialog?.kind === 'snippets' && (
        <SnippetsDialog snippets={data.snippets} onClose={() => setDialog(null)} onChanged={refresh} />
      )}
      {vaultState === 'unlocked' && dialog?.kind === 'import' && (
        <ImportDialog onClose={() => setDialog(null)} onImported={refresh} />
      )}
      {vaultState === 'unlocked' && dialog?.kind === 'settings' && (
        <SettingsDialog
          settings={data.settings}
          syncRepo={data.sync?.repo}
          syncStatus={syncStatus}
          onClose={() => setDialog(null)}
          onChanged={() => {
            refresh();
            api.localShells().then(setShells, () => undefined);
          }}
        />
      )}

      {prompt && vaultState === 'unlocked' && (
        <Modal title={prompt.previous ? '⚠ Host key changed!' : 'New host'} onClose={() => answerHost(false)} width={520}>
          {prompt.previous ? (
            <p className="error">
              The host key for <b>{prompt.hostPort}</b> is different from the one you trusted before. This can mean the
              server was reinstalled — or that someone is intercepting the connection.
            </p>
          ) : (
            <p>
              First connection to <b>{prompt.hostPort}</b>. Verify the fingerprint if you can, then trust it.
            </p>
          )}
          {prompt.previous && <p className="mono small">Previous: {prompt.previous}</p>}
          <p className="mono small">Fingerprint: {prompt.fingerprint}</p>
          <div className="modal-footer flush">
            <span className="spacer" />
            <button onClick={() => answerHost(false)}>Cancel</button>
            <button className={prompt.previous ? 'danger' : 'primary'} onClick={() => answerHost(true)} autoFocus>
              Trust &amp; connect
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
