import { useEffect, useMemo, useState } from 'react';
import type { ImportCandidate } from '../shared/types';
import { Modal } from './Modal';
import { api, errMsg } from './util';

interface Props {
  onClose(): void;
  onImported(): void;
}

const SOURCE_LABEL: Record<ImportCandidate['source'], string> = {
  'ssh-config': 'SSH config',
  putty: 'PuTTY sessions',
};

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Import servers (and their keys) from ~/.ssh/config and saved PuTTY sessions. */
export function ImportDialog({ onClose, onImported }: Props) {
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [passphrases, setPassphrases] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ connections: number; keys: number } | null>(null);

  useEffect(() => {
    api.scanImports().then(
      (c) => {
        setCandidates(c);
        setChecked(new Set(c.filter((x) => !x.exists).map((x) => x.id)));
      },
      (err) => setError(errMsg(err)),
    );
  }, []);

  const groups = useMemo(() => {
    const m = new Map<ImportCandidate['source'], ImportCandidate[]>();
    for (const c of candidates ?? []) m.set(c.source, [...(m.get(c.source) ?? []), c]);
    return [...m.entries()];
  }, [candidates]);

  // Encrypted key files used by the selected servers (each asked once).
  const encryptedKeys = useMemo(() => {
    const paths = new Set<string>();
    for (const c of candidates ?? [])
      if (checked.has(c.id) && c.keyPath && c.keyEncrypted && !c.keyExisting) paths.add(c.keyPath);
    return [...paths];
  }, [candidates, checked]);

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const apply = async () => {
    setError('');
    setBusy(true);
    try {
      setDone(await api.applyImports([...checked], passphrases));
      onImported();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = done ? (
    <>
      <span className="spacer" />
      <button className="primary" onClick={onClose}>
        Done
      </button>
    </>
  ) : (
    <>
      <span className="muted small">{checked.size} selected</span>
      <span className="spacer" />
      <button onClick={onClose}>Cancel</button>
      <button
        className="primary"
        disabled={busy || checked.size === 0 || encryptedKeys.some((p) => !passphrases[p])}
        onClick={apply}
      >
        {busy ? 'Importing…' : 'Import'}
      </button>
    </>
  );

  return (
    <Modal title="Import servers" onClose={onClose} width={620} footer={footer}>
      {done ? (
        <p className="ok">
          Imported {done.connections} server{done.connections === 1 ? '' : 's'}
          {done.keys ? ` and ${done.keys} key${done.keys === 1 ? '' : 's'}` : ''}. Keys are copied into your encrypted vault.
        </p>
      ) : candidates === null && !error ? (
        <p className="muted">Looking for servers…</p>
      ) : (
        <>
          <p className="muted">
            Servers found in your SSH config{navigator.userAgent.includes('Windows') ? ' and PuTTY' : ''}. Key files are copied into
            the vault; servers you already have are not selected.
          </p>
          {candidates?.length === 0 && (
            <p className="muted">
              Nothing found. TerminalTab reads <span className="mono">~/.ssh/config</span>
              {navigator.userAgent.includes('Windows') ? ' and the saved sessions of PuTTY' : ''}.
            </p>
          )}
          <div className="import-list">
            {groups.map(([source, items]) => (
              <div key={source}>
                <div className="group-label">
                  {SOURCE_LABEL[source]}
                  <button
                    className="link-btn small"
                    onClick={() => {
                      const ids = items.map((c) => c.id);
                      const all = ids.every((id) => checked.has(id));
                      const next = new Set(checked);
                      ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
                      setChecked(next);
                    }}
                  >
                    {items.every((c) => checked.has(c.id)) ? 'none' : 'all'}
                  </button>
                </div>
                {items.map((c) => (
                  <label key={c.id} className={`import-row ${c.exists ? 'exists' : ''}`}>
                    <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="grow">
                      <b>{c.name}</b>{' '}
                      <span className="muted small">
                        {c.username}@{c.host}
                        {c.port !== 22 ? `:${c.port}` : ''}
                      </span>
                      <div className="small">
                        {c.keyPath ? (
                          c.keyProblem ? (
                            <span className="warn">⚠ {c.keyProblem}</span>
                          ) : (
                            <span className="muted">
                              Key: {baseName(c.keyPath)}
                              {c.keyExisting ? ` (already in vault as "${c.keyExisting}")` : c.keyEncrypted ? ' (passphrase needed)' : ''}
                            </span>
                          )
                        ) : (
                          <span className="muted">No key file — add a key or password after importing</span>
                        )}
                        {c.exists && <span className="muted"> · already saved</span>}
                        {c.note && <div className="warn">⚠ {c.note}</div>}
                      </div>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          {encryptedKeys.length > 0 && (
            <div className="inset form">
              <b className="small">Passphrases for encrypted keys</b>
              {encryptedKeys.map((p) => (
                <label key={p}>
                  {baseName(p)}
                  <input
                    type="password"
                    value={passphrases[p] ?? ''}
                    onChange={(e) => setPassphrases({ ...passphrases, [p]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
