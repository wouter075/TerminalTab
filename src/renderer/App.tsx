import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../shared/api';
import type { ConnectionInfo, HostKeyPrompt, SessionInfo, SessionStatus, SyncStatus, VaultState } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { ConnectionDialog } from './ConnectionDialog';
import { KeysDialog } from './KeysDialog';
import { Logo } from './Logo';
import { Modal } from './Modal';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TerminalPane } from './TerminalPane';
import { UnlockScreen } from './UnlockScreen';
import { api } from './util';

interface Tab {
  id: string;
  connectionId: string;
  attempt: number;
  status: SessionStatus;
  message?: string;
  sessionId?: string | null;
  info?: SessionInfo;
  cols?: number;
  rows?: number;
}

type Dialog = { kind: 'conn'; connection?: ConnectionInfo } | { kind: 'keys' } | { kind: 'settings' } | null;

const EMPTY: AppData = { connections: [], keys: [], settings: DEFAULT_SETTINGS };
let tabSeq = 0;

export function App() {
  const [vaultState, setVaultState] = useState<VaultState | null>(null);
  const [data, setData] = useState<AppData>(EMPTY);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [hostPrompts, setHostPrompts] = useState<HostKeyPrompt[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'off' });
  const searchRef = useRef<HTMLInputElement>(null);

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
    const offLock = api.onLocked(() => {
      setVaultState('locked');
      setDialog(null);
      (document.activeElement as HTMLElement | null)?.blur();
    });
    const offHost = api.onHostKeyPrompt((p) => setHostPrompts((ps) => [...ps, p]));
    const offSync = api.onSyncStatus(setSyncStatus);
    // Servers/keys changed by a sync from another PC.
    const offData = api.onDataChanged(() => {
      api.getData().then(setData, () => undefined);
    });
    return () => {
      offLock();
      offHost();
      offSync();
      offData();
    };
  }, [refresh]);

  const connById = useMemo(() => new Map(data.connections.map((c) => [c.id, c])), [data.connections]);
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

  const patchTab = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const reconnect = (id: string) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === id ? { ...t, attempt: t.attempt + 1, status: 'connecting', info: undefined } : t)),
    );

  // Live status-bar info is only collected for the tab being viewed.
  const activeSessionId = tabs.find((t) => t.id === activeId)?.sessionId ?? null;
  useEffect(() => {
    api.watchSession(activeSessionId);
  }, [activeSessionId]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (vaultState !== 'unlocked' || !e.ctrlKey) return;
      if (e.code === 'KeyT') {
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
  }, [vaultState, activeId, tabs, closeTab]);

  const answerHost = (trust: boolean) => {
    const [p, ...rest] = hostPrompts;
    if (!p) return;
    api.answerHostKey(p.requestId, trust);
    setHostPrompts(rest);
  };

  if (vaultState === null) return null;

  const activeTab = tabs.find((t) => t.id === activeId);
  const prompt = hostPrompts[0];

  return (
    <>
      {vaultState === 'unlocked' || tabs.length > 0 ? (
        <div className="layout">
          <Sidebar
            ref={searchRef}
            connections={data.connections}
            openCounts={openCounts}
            onConnect={connect}
            onEdit={(c) => setDialog({ kind: 'conn', connection: c })}
            onAdd={() => setDialog({ kind: 'conn' })}
            onKeys={() => setDialog({ kind: 'keys' })}
            onSettings={() => setDialog({ kind: 'settings' })}
            onLock={() => api.lock()}
            syncStatus={syncStatus}
          />
          <main className="main">
            <div className="tabbar">
              {tabs.map((t) => {
                const c = connById.get(t.connectionId);
                return (
                  <div
                    key={t.id}
                    className={`tab ${t.id === activeId ? 'active' : ''}`}
                    style={{ borderTopColor: c?.color || undefined }}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        closeTab(t.id);
                      } else setActiveId(t.id);
                    }}
                    title={t.message}
                  >
                    <span className={`status-dot ${t.status}`} />
                    <span className="tab-title">{c?.name ?? 'Deleted server'}</span>
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
            </div>
            <div className="terminals">
              {tabs.map((t) => (
                <TerminalPane
                  key={t.id}
                  connectionId={t.connectionId}
                  attempt={t.attempt}
                  active={t.id === activeId && vaultState === 'unlocked'}
                  fontSize={data.settings.fontSize}
                  onStatus={(status, message) => patchTab(t.id, { status, message })}
                  onSession={(sessionId) => patchTab(t.id, { sessionId })}
                  onInfo={(info) => patchTab(t.id, { info })}
                  onSize={(cols, rows) => patchTab(t.id, { cols, rows })}
                  onDuplicate={() => connect(t.connectionId)}
                  onCloseTab={() => closeTab(t.id)}
                />
              ))}
              {activeTab && (activeTab.status === 'closed' || activeTab.status === 'error') && (
                <div className="reconnect-bar">
                  <span>{activeTab.message ?? 'Disconnected'}</span>
                  <button className="primary" onClick={() => reconnect(activeTab.id)}>
                    Reconnect
                  </button>
                  <button onClick={() => closeTab(activeTab.id)}>Close tab</button>
                </div>
              )}
              {tabs.length === 0 && (
                <div className="empty-state">
                  <Logo size={88} text={false} />
                  <p>Pick a server on the left to open it in a new tab.</p>
                  <p className="muted small">
                    Ctrl+T search · Ctrl+W close tab · Ctrl+Tab next tab · select to copy · right-click to paste
                  </p>
                </div>
              )}
            </div>
            {activeTab && (
              <StatusBar
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
      {vaultState === 'unlocked' && dialog?.kind === 'settings' && (
        <SettingsDialog
          settings={data.settings}
          syncRepo={data.sync?.repo}
          syncStatus={syncStatus}
          onClose={() => setDialog(null)}
          onChanged={refresh}
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
          {prompt.previous && (
            <p className="mono small">
              Previous: {prompt.previous}
            </p>
          )}
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
