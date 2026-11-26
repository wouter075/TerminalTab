import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionInfo, LocalShell, Snippet } from '../shared/types';
import { Icon } from './Icon';

type Item =
  | { kind: 'snippet'; id: string; title: string; sub: string; snippet: Snippet }
  | { kind: 'server'; id: string; title: string; sub: string; conn: ConnectionInfo }
  | { kind: 'shell'; id: string; title: string; sub: string }
  | { kind: 'action'; id: string; title: string; sub: string; run(): void };

interface Props {
  snippets: Snippet[];
  connections: ConnectionInfo[];
  shells: LocalShell[];
  onShell(id: string): void;
  /** A connected tab is active, so snippets can be inserted. */
  canInsert: boolean;
  /** Start in snippets-only mode (from the terminal's right-click menu). */
  snippetsOnly?: boolean;
  onSnippet(s: Snippet): void;
  onServer(id: string): void;
  onManageSnippets(): void;
  onClose(): void;
}

/** Score `text` against `query` as a subsequence; higher is better, -1 = no match. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx; // contiguous match wins
  let score = 0;
  let pos = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, pos);
    if (found < 0) return -1;
    score += found === pos ? 5 : 1;
    pos = found + 1;
  }
  return score;
}

const firstLine = (s: string) => {
  const line = s.split('\n')[0];
  return s.includes('\n') ? `${line} …` : line;
};

/** Ctrl+Shift+P: insert a snippet into the active tab, or open a server. */
export function Palette({
  snippets,
  connections,
  shells,
  onShell,
  canInsert,
  snippetsOnly,
  onSnippet,
  onServer,
  onManageSnippets,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const all: Item[] = [
      ...snippets.map((s): Item => ({ kind: 'snippet', id: s.id, title: s.name, sub: firstLine(s.command), snippet: s })),
      ...(snippetsOnly
        ? []
        : connections.map(
            (c): Item => ({ kind: 'server', id: c.id, title: c.name, sub: `${c.username}@${c.host}`, conn: c }),
          )),
      ...(snippetsOnly
        ? []
        : shells.map((sh): Item => ({ kind: 'shell', id: sh.id, title: sh.name, sub: 'Local shell on this PC' }))),
      { kind: 'action', id: 'manage', title: 'Manage snippets…', sub: 'Add, edit or delete snippets', run: onManageSnippets },
    ];
    if (!query.trim()) return all;
    return all
      .map((it) => ({ it, score: Math.max(fuzzyScore(it.title, query), fuzzyScore(it.sub, query) - 50) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.it);
  }, [snippets, connections, shells, snippetsOnly, query, onManageSnippets]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === 'snippet' && !canInsert) return;
    onClose();
    if (it.kind === 'snippet') onSnippet(it.snippet);
    else if (it.kind === 'server') onServer(it.id);
    else if (it.kind === 'shell') onShell(it.id);
    else it.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          className="palette-input"
          placeholder={snippetsOnly ? 'Search snippets…' : 'Search snippets, servers and shells…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(items[sel]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => {
            const disabled = it.kind === 'snippet' && !canInsert;
            return (
              <div
                key={`${it.kind}-${it.id}`}
                className={`palette-item ${i === sel ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                onMouseMove={() => setSel(i)}
                onClick={() => choose(it)}
                title={it.kind === 'snippet' ? it.snippet.command : undefined}
              >
                <span className="palette-icon">
                  <Icon
                    name={
                      it.kind === 'snippet' ? 'snippet' : it.kind === 'server' ? 'server' : it.kind === 'shell' ? 'prompt' : 'gear'
                    }
                  />
                </span>
                <span className="palette-text">
                  <span className="palette-title">{it.title}</span>
                  <span className={`palette-sub ${it.kind === 'snippet' ? 'mono' : ''}`}>{it.sub}</span>
                </span>
                <span className="palette-kind">
                  {it.kind === 'snippet'
                    ? disabled
                      ? 'no connected tab'
                      : it.snippet.run
                        ? 'run'
                        : 'insert'
                    : it.kind === 'server' || it.kind === 'shell'
                      ? 'open'
                      : ''}
                </span>
              </div>
            );
          })}
          {items.length === 0 && <div className="palette-empty muted">Nothing found.</div>}
        </div>
        <div className="palette-hint muted small">↑↓ to choose · Enter · Esc to close</div>
      </div>
    </div>
  );
}
