import { useState } from 'react';
import type { Snippet } from '../shared/types';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { api, errMsg } from './util';

interface Props {
  snippets: Snippet[];
  onClose(): void;
  onChanged(): void;
}

type Draft = { id?: string; name: string; command: string; run: boolean };

/** Add, edit and delete saved commands. They sync with the vault. */
export function SnippetsDialog({ snippets, onClose, onChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(snippets.length === 0 ? { name: '', command: '', run: false } : null);
  const [error, setError] = useState('');

  const save = async () => {
    if (!draft) return;
    setError('');
    try {
      await api.saveSnippet(draft);
      setDraft(null);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const remove = async (s: Snippet) => {
    if (!confirm(`Delete snippet "${s.name}"?`)) return;
    await api.deleteSnippet(s.id);
    onChanged();
  };

  const sorted = [...snippets].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Modal title="Snippets" onClose={onClose} width={560}>
      <p className="muted">
        Saved commands you can insert into any tab with <b>Ctrl+Shift+P</b> or the right-click menu. They are stored in
        your encrypted vault and sync between PCs.
      </p>
      <ul className="list">
        {sorted.map((s) => (
          <li key={s.id}>
            <span className="key-icon">
              <Icon name="snippet" />
            </span>
            <span className="grow snippet-row">
              {s.name}
              {s.run && <span className="muted small"> · runs immediately</span>}
              <div className="mono small muted snippet-cmd">{s.command}</div>
            </span>
            <button
              className="icon-btn"
              title="Edit"
              onClick={() => setDraft({ id: s.id, name: s.name, command: s.command, run: s.run })}
            >
              ✎
            </button>
            <button className="icon-btn" title="Delete" onClick={() => remove(s)}>
              <Icon name="trash" />
            </button>
          </li>
        ))}
        {snippets.length === 0 && <li className="muted">No snippets yet.</li>}
      </ul>

      {draft ? (
        <form
          className="inset form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label>
            Name
            <input
              value={draft.name}
              autoFocus
              placeholder="e.g. Disk usage"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Command
            <textarea
              className="mono"
              rows={4}
              value={draft.command}
              placeholder={'df -h\nsudo systemctl status nginx'}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault();
                  save();
                }
              }}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.run} onChange={(e) => setDraft({ ...draft, run: e.target.checked })} />
            <span>
              Run immediately <span className="muted small">— press Enter after inserting</span>
            </span>
          </label>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <span className="spacer" />
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={!draft.command.trim()}>
              {draft.id ? 'Save' : 'Add snippet'}
            </button>
          </div>
        </form>
      ) : (
        <button className="primary" onClick={() => setDraft({ name: '', command: '', run: false })}>
          <Icon name="plus" /> New snippet
        </button>
      )}
    </Modal>
  );
}
