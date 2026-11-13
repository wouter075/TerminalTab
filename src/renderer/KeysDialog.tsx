import { useState } from 'react';
import type { PickedKeyFile } from '../shared/api';
import type { ConnectionInfo, KeyInfo } from '../shared/types';
import { Modal } from './Modal';
import { api, errMsg } from './util';

/** Pick a key file, then name it (and enter its passphrase if it is encrypted). */
export function ImportKeyForm({ onDone }: { onDone(key: KeyInfo | null): void }) {
  const [picked, setPicked] = useState<PickedKeyFile | null>(null);
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');

  const pick = async () => {
    setError('');
    try {
      const p = await api.pickKeyFile();
      if (!p) return;
      setPicked(p);
      setName(p.fileName.replace(/\.(pem|key|ppk)$/i, ''));
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const add = async () => {
    if (!picked) return;
    setError('');
    try {
      onDone(await api.addKey(picked.token, name, picked.encrypted ? passphrase : undefined));
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="form">
      {!picked ? (
        <div className="row">
          <button className="primary" type="button" onClick={pick}>
            Choose key file…
          </button>
          <button type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="muted">File: {picked.fileName}</div>
          <label>
            Key name
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          {picked.encrypted && (
            <label>
              Key passphrase
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </label>
          )}
          <div className="row">
            <button className="primary" type="button" onClick={add}>
              Save key
            </button>
            <button type="button" onClick={() => onDone(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

interface Props {
  keys: KeyInfo[];
  connections: ConnectionInfo[];
  onClose(): void;
  onChanged(): void;
}

export function KeysDialog({ keys, connections, onClose, onChanged }: Props) {
  const [importing, setImporting] = useState(keys.length === 0);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const usage = (id: string) => connections.filter((c) => c.keyId === id).length;

  const remove = async (k: KeyInfo) => {
    const n = usage(k.id);
    const msg = n ? `"${k.name}" is used by ${n} server(s). Delete it anyway?` : `Delete key "${k.name}"?`;
    if (!confirm(msg)) return;
    await api.deleteKey(k.id);
    onChanged();
  };

  const rename = async () => {
    if (!editing) return;
    await api.renameKey(editing.id, editing.name);
    setEditing(null);
    onChanged();
  };

  return (
    <Modal title="Private keys" onClose={onClose} width={520}>
      <p className="muted">Keys are stored inside your encrypted vault. The original file can be deleted after importing.</p>
      <ul className="list">
        {keys.map((k) => (
          <li key={k.id}>
            {editing?.id === k.id ? (
              <form
                className="row grow"
                onSubmit={(e) => {
                  e.preventDefault();
                  rename();
                }}
              >
                <input
                  className="grow"
                  value={editing.name}
                  autoFocus
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
                <button className="primary" type="submit">
                  Save
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="key-icon">🔑</span>
                <span className="grow">
                  {k.name}
                  <span className="muted small">
                    {' '}
                    · used by {usage(k.id)}
                    {k.hasPassphrase ? ' · passphrase' : ''}
                  </span>
                  {k.fingerprint && <div className="mono small muted">{k.fingerprint}</div>}
                </span>
                <button className="icon-btn" title="Rename" onClick={() => setEditing({ id: k.id, name: k.name })}>
                  ✎
                </button>
                <button className="icon-btn" title="Delete" onClick={() => remove(k)}>
                  🗑
                </button>
              </>
            )}
          </li>
        ))}
        {keys.length === 0 && <li className="muted">No keys yet.</li>}
      </ul>
      {importing ? (
        <div className="inset">
          <ImportKeyForm
            onDone={(k) => {
              setImporting(false);
              if (k) onChanged();
            }}
          />
        </div>
      ) : (
        <button className="primary" onClick={() => setImporting(true)}>
          Import .pem key…
        </button>
      )}
    </Modal>
  );
}
