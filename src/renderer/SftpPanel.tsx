import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { RemoteEntry, TransferProgress } from '../shared/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { fmtBytes } from './StatusBar';
import { api, errMsg } from './util';

interface Props {
  /** Connected SSH session of the tab; null while disconnected. */
  sessionId: string | null;
  /** Last folder shown for this tab (kept in the tab's state). */
  path?: string;
  width: number;
  transfers: TransferProgress[];
  onPath(path: string): void;
  onWidth(width: number): void;
  /** Type `cd '<path>'` into the terminal. */
  onCd(path: string): void;
  onClose(): void;
}

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parent = (p: string) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');
/** Quote a path for a POSIX shell. */
export const shellQuote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  });
}

function fmtMode(mode: number, type: RemoteEntry['type']): string {
  const rwx = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return (type === 'dir' ? 'd' : type === 'link' ? 'l' : '-') + rwx(mode >> 6) + rwx(mode >> 3) + rwx(mode);
}

type Editing = { kind: 'rename'; name: string; value: string } | { kind: 'mkdir'; value: string } | null;

/** Side panel with the remote file system of the tab's server (over SFTP). */
export function SftpPanel({ sessionId, path, width, transfers, onPath, onWidth, onCd, onClose }: Props) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; path?: string } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: RemoteEntry } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(
    async (dir: string) => {
      if (!sessionId) return;
      const seq = ++loadSeq.current;
      setLoading(true);
      setError('');
      try {
        const res = await api.sftpList(sessionId, dir);
        if (seq !== loadSeq.current) return;
        setCwd(res.path);
        setPathInput(res.path);
        setEntries(res.entries);
        setSelected(new Set());
        onPath(res.path);
      } catch (err) {
        if (seq === loadSeq.current) setError(errMsg(err));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [sessionId, onPath],
  );

  // (Re)load when the session (re)connects.
  useEffect(() => {
    setCwd(null);
    setEntries([]);
    if (sessionId) load(path || '.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const refresh = () => cwd && load(cwd);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError('');
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const open = (e: RemoteEntry) => {
    if (!cwd) return;
    if (e.type === 'dir') load(join(cwd, e.name));
    else download([e]);
  };

  const download = (items: RemoteEntry[]) =>
    sessionId &&
    cwd &&
    run(async () => {
      const local = await api.sftpDownload(
        sessionId,
        items.map((e) => join(cwd, e.name)),
        items.length === 1 && items[0].type !== 'dir',
      );
      if (local) setNotice({ text: `Downloaded ${items.length === 1 ? items[0].name : `${items.length} items`}`, path: local });
    });

  const remove = (items: RemoteEntry[]) => {
    if (!sessionId || !cwd || items.length === 0) return;
    const dirs = items.filter((e) => e.type === 'dir').length;
    const what = items.length === 1 ? `"${items[0].name}"` : `${items.length} items`;
    if (!confirm(`Delete ${what}${dirs ? ' and everything in it' : ''} on the server? This cannot be undone.`)) return;
    run(async () => {
      for (const e of items) await api.sftpRemove(sessionId, join(cwd, e.name));
    }, refresh);
  };

  const submitEdit = () => {
    if (!editing || !sessionId || !cwd) return;
    const value = editing.value.trim();
    if (!value || value.includes('/')) return setEditing(null);
    if (editing.kind === 'rename') {
      if (value !== editing.name) run(() => api.sftpRename(sessionId, join(cwd, editing.name), join(cwd, value)), refresh);
    } else run(() => api.sftpMkdir(sessionId, join(cwd, value)), refresh);
    setEditing(null);
  };

  const upload = () =>
    sessionId &&
    cwd &&
    run(async () => {
      if (await api.sftpUploadPick(sessionId, cwd)) refresh();
    });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!sessionId || !cwd) return;
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) run(() => api.sftpUpload(sessionId, paths, cwd), refresh);
  };

  const clickRow = (e: ReactMouseEvent, entry: RemoteEntry) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.name)) next.delete(entry.name);
      else next.add(entry.name);
      setSelected(next);
    } else setSelected(new Set([entry.name]));
  };

  const selectedEntries = entries.filter((e) => selected.has(e.name));

  const menuItems = (entry?: RemoteEntry): MenuItem[] => {
    if (!cwd) return [];
    const items = entry ? (selected.has(entry.name) ? selectedEntries : [entry]) : [];
    const one = items.length === 1 ? items[0] : undefined;
    return [
      ...(items.length
        ? ([
            ...(one?.type === 'dir' ? [{ label: 'Open', action: () => open(one) }] : []),
            { label: items.length > 1 ? `Download ${items.length} items…` : 'Download…', action: () => download(items) },
            ...(one ? [{ label: 'Rename', action: () => setEditing({ kind: 'rename', name: one.name, value: one.name }) }] : []),
            {
              label: 'Copy path',
              action: () => navigator.clipboard.writeText(items.map((e) => join(cwd, e.name)).join('\n')),
            },
            ...(one?.type === 'dir' ? [{ label: 'cd into this folder', action: () => onCd(join(cwd, one.name)) }] : []),
            { label: 'Delete', danger: true, action: () => remove(items) },
            { separator: true },
          ] as MenuItem[])
        : []),
      { label: 'Upload files…', action: upload },
      { label: 'New folder', action: () => setEditing({ kind: 'mkdir', value: '' }) },
      { label: 'Refresh', action: refresh },
      { label: 'cd here in terminal', action: () => onCd(cwd) },
    ];
  };

  // Resize by dragging the left edge.
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => onWidth(Math.max(240, Math.min(900, startW + startX - ev.clientX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const crumbs = cwd ? cwd.split('/').filter(Boolean) : [];
  const running = transfers.filter((t) => t.state === 'running');

  return (
    <aside className="sftp" style={{ width }}>
      <div className="sftp-resize" onMouseDown={startResize} />
      <div className="sftp-header">
        <b>Files</b>
        <span className="spacer" />
        <button className="icon-btn" title="Home folder" disabled={!sessionId} onClick={() => load('.')}>
          <Icon name="home" />
        </button>
        <button className="icon-btn" title="Up one folder" disabled={!cwd || cwd === '/'} onClick={() => cwd && load(parent(cwd))}>
          <Icon name="up" />
        </button>
        <button className="icon-btn" title="Refresh" disabled={!cwd} onClick={refresh}>
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" title="New folder" disabled={!cwd} onClick={() => setEditing({ kind: 'mkdir', value: '' })}>
          <Icon name="newFolder" />
        </button>
        <button className="icon-btn" title="Upload files" disabled={!cwd} onClick={upload}>
          <Icon name="upload" />
        </button>
        <button className="icon-btn" title="Close (Ctrl+Shift+E)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {!sessionId ? (
        <div className="sftp-empty muted">Connect the tab to browse its files.</div>
      ) : (
        <>
          <form
            className="sftp-path"
            onSubmit={(e) => {
              e.preventDefault();
              if (pathInput.trim()) load(pathInput.trim());
            }}
          >
            <input value={pathInput} spellCheck={false} onChange={(e) => setPathInput(e.target.value)} title="Type a path and press Enter" />
          </form>
          {cwd && (
            <div className="sftp-crumbs">
              <button className="link-btn" onClick={() => load('/')}>
                /
              </button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  <button className="link-btn" onClick={() => load('/' + crumbs.slice(0, i + 1).join('/'))}>
                    {c}
                  </button>
                  {i < crumbs.length - 1 && <span className="muted">/</span>}
                </span>
              ))}
            </div>
          )}
          {error && <div className="sftp-error error small">{error}</div>}

          <div
            className={`sftp-list ${dragOver ? 'drag' : ''} ${loading ? 'loading' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragOver(true);
            }}
            onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
            onDrop={onDrop}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }}
            onMouseDown={(e) => e.target === e.currentTarget && setSelected(new Set())}
          >
            {editing?.kind === 'mkdir' && (
              <div className="sftp-row editing">
                <span className="sftp-icon">
                  <Icon name="folder" />
                </span>
                <input
                  autoFocus
                  placeholder="New folder name"
                  value={editing.value}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitEdit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onBlur={submitEdit}
                />
              </div>
            )}
            {entries.map((e) => (
              <div
                key={e.name}
                className={`sftp-row ${selected.has(e.name) ? 'selected' : ''}`}
                onClick={(ev) => clickRow(ev, e)}
                onDoubleClick={() => open(e)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (!selected.has(e.name)) setSelected(new Set([e.name]));
                  setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                }}
                title={`${e.name}\n${fmtMode(e.mode, e.type)}  ${e.type === 'dir' ? '' : fmtBytes(e.size)}`}
              >
                <span className={`sftp-icon ${e.type}`}>
                  <Icon name={e.type === 'dir' ? 'folder' : e.type === 'link' ? 'link' : 'file'} />
                </span>
                {editing?.kind === 'rename' && editing.name === e.name ? (
                  <input
                    autoFocus
                    value={editing.value}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') submitEdit();
                      if (ev.key === 'Escape') setEditing(null);
                    }}
                    onBlur={submitEdit}
                  />
                ) : (
                  <span className="sftp-name">{e.name}</span>
                )}
                <span className="sftp-size">{e.type === 'dir' ? '' : fmtBytes(e.size)}</span>
                <span className="sftp-date">{fmtDate(e.mtime)}</span>
              </div>
            ))}
            {!loading && cwd && entries.length === 0 && <div className="sftp-empty muted">Empty folder</div>}
            {dragOver && <div className="sftp-drop-hint">Drop to upload to {cwd}</div>}
          </div>
        </>
      )}

      {(running.length > 0 || notice) && (
        <div className="sftp-transfers">
          {running.map((t) => {
            const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
            return (
              <div key={t.id} className="transfer">
                <Icon name={t.direction === 'up' ? 'upload' : 'download'} />
                <span className="transfer-name" title={t.name}>
                  {t.name}
                </span>
                <span className="transfer-bar">
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="transfer-pct">{pct}%</span>
                <button className="icon-btn" title="Cancel" onClick={() => api.sftpCancel(t.id)}>
                  <Icon name="close" />
                </button>
              </div>
            );
          })}
          {notice && running.length === 0 && (
            <div className="transfer">
              <span className="ok">✓</span>
              <span className="transfer-name">{notice.text}</span>
              {notice.path && (
                <button className="link-btn" onClick={() => api.showItemInFolder(notice.path!)}>
                  Show in folder
                </button>
              )}
              <button className="icon-btn" title="Dismiss" onClick={() => setNotice(null)}>
                <Icon name="close" />
              </button>
            </div>
          )}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
    </aside>
  );
}
