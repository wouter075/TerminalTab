import { forwardRef, useEffect, useMemo, useState } from 'react';
import { LOCAL_PREFIX, type ConnectionInfo, type LocalShell, type SyncStatus, type UpdateInfo } from '../shared/types';
import { ContextMenu } from './ContextMenu';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { ago } from './SyncSection';
import { api } from './util';

interface Props {
  connections: ConnectionInfo[];
  shells: LocalShell[];
  openCounts: Map<string, number>;
  onConnect(id: string): void;
  onOpenShell(id: string): void;
  onEdit(c: ConnectionInfo): void;
  onAdd(): void;
  onImport(): void;
  onKeys(): void;
  onSnippets(): void;
  onSettings(): void;
  onLock(): void;
  syncStatus: SyncStatus;
  update: UpdateInfo;
}

const SHELLS_OPEN_KEY = 'terminaltab.shellsOpen';
function loadShellsOpen(): boolean {
  try {
    return localStorage.getItem(SHELLS_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  { connections, shells, openCounts, onConnect, onOpenShell, onEdit, onAdd, onImport, onKeys, onSnippets, onSettings, onLock, syncStatus, update },
  searchRef,
) {
  const [query, setQuery] = useState('');
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [shellsOpen, setShellsOpen] = useState(loadShellsOpen);
  const toggleShells = () => {
    setShellsOpen(!shellsOpen);
    try {
      localStorage.setItem(SHELLS_OPEN_KEY, shellsOpen ? '0' : '1');
    } catch {
      /* private mode */
    }
  };
  const q = query.trim().toLowerCase();
  const visibleShells = shells.filter((s) => !q || s.name.toLowerCase().includes(q));
  // Keep "Synced 3 min ago" fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = connections.filter(
      (c) => !q || [c.name, c.host, c.username, c.group].some((v) => v?.toLowerCase().includes(q)),
    );
    const map = new Map<string, ConnectionInfo[]>();
    for (const c of filtered.sort((a, b) => a.name.localeCompare(b.name))) {
      const g = c.group || '';
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [connections, query]);

  const first = groups[0]?.[1][0];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <Logo size={24} />
        <button
          className="icon-btn"
          title="Add server"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAddMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            { label: 'Add server…', action: onAdd },
            { label: 'Import from SSH config / PuTTY…', action: onImport },
            ...(shells.length ? [{ separator: true as const }] : []),
            ...shells.map((s) => ({ label: `Open ${s.name}`, action: () => onOpenShell(s.id) })),
          ]}
        />
      )}
      <input
        ref={searchRef}
        className="search"
        placeholder="Search servers  (Ctrl+T)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (first || (q && visibleShells[0]))) {
            if (first) onConnect(first.id);
            else onOpenShell(visibleShells[0].id);
            setQuery('');
          }
          if (e.key === 'Escape') setQuery('');
        }}
      />
      <div className="conn-list">
        {visibleShells.length > 0 && (
          <div>
            <button className="group-label group-toggle" onClick={toggleShells} aria-expanded={shellsOpen || !!q}>
              <span className={`chevron ${shellsOpen || q ? 'open' : ''}`}>›</span> This PC
            </button>
            {(shellsOpen || !!q) &&
              visibleShells.map((s) => {
                const n = openCounts.get(LOCAL_PREFIX + s.id);
                return (
                  <div
                    key={s.id}
                    className="conn shell"
                    role="button"
                    tabIndex={0}
                    title={`${s.file} ${s.args.join(' ')}\nClick to open a new tab`}
                    onClick={() => onOpenShell(s.id)}
                    onKeyDown={(e) => e.key === 'Enter' && onOpenShell(s.id)}
                  >
                    <span className="conn-icon">
                      <Icon name="prompt" />
                    </span>
                    <span className="conn-text">
                      <span className="conn-name">{s.name}</span>
                    </span>
                    {!!n && (
                      <span className="badge" title={`${n} open tab${n === 1 ? '' : 's'}`}>
                        {n}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        )}
        {groups.map(([group, items]) => (
          <div key={group || '__none'}>
            {(group || groups.length > 1 || visibleShells.length > 0) && (
              <div className="group-label">{group || (groups.length > 1 ? 'Ungrouped' : 'Servers')}</div>
            )}
            {items.map((c) => (
              <div
                key={c.id}
                className="conn"
                role="button"
                tabIndex={0}
                title={`${c.username}@${c.host}:${c.port}\nClick to open a new tab`}
                onClick={() => onConnect(c.id)}
                onKeyDown={(e) => e.key === 'Enter' && onConnect(c.id)}
              >
                <span className="conn-color" style={{ background: c.color || 'var(--border)' }} />
                <span className="conn-text">
                  <span className="conn-name">{c.name}</span>
                  <span className="conn-sub">
                    {c.username}@{c.host}
                    {c.port !== 22 ? `:${c.port}` : ''}
                  </span>
                </span>
                {!!openCounts.get(c.id) && (
                  <span className="badge" title={`${openCounts.get(c.id)} open tab${openCounts.get(c.id) === 1 ? '' : 's'}`}>
                    {openCounts.get(c.id)}
                  </span>
                )}
                <button
                  className="icon-btn conn-edit"
                  title="Edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(c);
                  }}
                >
                  ✎
                </button>
              </div>
            ))}
          </div>
        ))}
        {connections.length === 0 && (
          <div className="empty-hint">
            No servers yet.
            <button className="primary" onClick={onAdd}>
              Add your first server
            </button>
            <button className="link-btn" onClick={onImport}>
              or import from SSH config / PuTTY
            </button>
          </div>
        )}
        {connections.length > 0 && groups.length === 0 && <div className="empty-hint">No matches.</div>}
      </div>
      {update.state === 'downloaded' && (
        <button className="update-line" onClick={() => api.restartToUpdate()} title="Restart TerminalTab to install the update">
          <Icon name="download" /> {update.version ? `Version ${update.version}` : 'Update'} ready — restart
        </button>
      )}
      {update.state === 'available' && (
        <button className="update-line" onClick={() => window.open(update.url)} title={update.url}>
          <Icon name="download" /> Version {update.version} available — download
        </button>
      )}
      {syncStatus.state !== 'off' && (
        <button
          className={`sync-line ${syncStatus.state}`}
          onClick={onSettings}
          title={syncStatus.message ?? `Syncing with github.com/${syncStatus.repo}`}
        >
          <span className={`sync-dot ${syncStatus.state}`} />
          {syncStatus.state === 'syncing'
            ? 'Syncing…'
            : syncStatus.state === 'ok'
              ? `Synced ${ago(syncStatus.lastSyncAt)}`
              : syncStatus.state === 'needs-password'
                ? 'Sync needs your password'
                : 'Sync failed — click for details'}
        </button>
      )}
      <div className="sidebar-footer">
        <button onClick={onKeys} title="Private keys">
          <Icon name="key" /> Keys
        </button>
        <button onClick={onSnippets} title="Snippets (Ctrl+Shift+P to insert)">
          <Icon name="snippet" /> Snippets
        </button>
        <button onClick={onSettings} title="Settings">
          <Icon name="gear" />
        </button>
        <button onClick={onLock} title="Lock vault">
          <Icon name="lock" />
        </button>
      </div>
    </aside>
  );
});
