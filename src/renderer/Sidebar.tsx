import { forwardRef, useEffect, useMemo, useState } from 'react';
import type { ConnectionInfo, SyncStatus } from '../shared/types';
import { Logo } from './Logo';
import { ago } from './SyncSection';

interface Props {
  connections: ConnectionInfo[];
  openCounts: Map<string, number>;
  onConnect(id: string): void;
  onEdit(c: ConnectionInfo): void;
  onAdd(): void;
  onKeys(): void;
  onSettings(): void;
  onLock(): void;
  syncStatus: SyncStatus;
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  { connections, openCounts, onConnect, onEdit, onAdd, onKeys, onSettings, onLock, syncStatus },
  searchRef,
) {
  const [query, setQuery] = useState('');
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
        <button className="icon-btn" title="Add server" onClick={onAdd}>
          ＋
        </button>
      </div>
      <input
        ref={searchRef}
        className="search"
        placeholder="Search servers  (Ctrl+T)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) {
            onConnect(first.id);
            setQuery('');
          }
          if (e.key === 'Escape') setQuery('');
        }}
      />
      <div className="conn-list">
        {groups.map(([group, items]) => (
          <div key={group || '__none'}>
            {(group || groups.length > 1) && <div className="group-label">{group || 'Ungrouped'}</div>}
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
          </div>
        )}
        {connections.length > 0 && groups.length === 0 && <div className="empty-hint">No matches.</div>}
      </div>
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
        <button onClick={onKeys}>🔑 Keys</button>
        <button onClick={onSettings}>⚙ Settings</button>
        <button onClick={onLock} title="Lock vault">
          🔒
        </button>
      </div>
    </aside>
  );
});
