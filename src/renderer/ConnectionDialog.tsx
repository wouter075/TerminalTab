import { useState } from 'react';
import type { AppData } from '../shared/api';
import type { ConnectionInfo } from '../shared/types';
import { Modal } from './Modal';
import { ImportKeyForm } from './KeysDialog';
import { api, errMsg } from './util';

interface Props {
  data: AppData;
  connection?: ConnectionInfo;
  onClose(): void;
  onSaved(connect?: string): void;
}

export const COLORS = ['', '#61afef', '#98c379', '#e5c07b', '#e06c75', '#c678dd', '#56b6c2'];

export function ConnectionDialog({ data, connection, onClose, onSaved }: Props) {
  const [name, setName] = useState(connection?.name ?? '');
  const [host, setHost] = useState(connection?.host ?? '');
  const [port, setPort] = useState(String(connection?.port ?? 22));
  const [username, setUsername] = useState(connection?.username ?? '');
  const [keyId, setKeyId] = useState(connection?.keyId ?? '');
  const [group, setGroup] = useState(connection?.group ?? '');
  const [color, setColor] = useState(connection?.color ?? '');
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [keys, setKeys] = useState(data.keys);
  const [error, setError] = useState('');

  const groups = [...new Set(data.connections.map((c) => c.group).filter(Boolean))] as string[];

  const save = async (connect: boolean) => {
    setError('');
    try {
      const id = await api.saveConnection({
        id: connection?.id,
        name,
        host,
        port: Number(port),
        username,
        keyId: keyId || undefined,
        group,
        color,
        password,
      });
      onSaved(connect ? id : undefined);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const remove = async () => {
    if (!connection || !confirm(`Delete "${connection.name}"?`)) return;
    await api.deleteConnection(connection.id);
    onSaved();
  };

  /** Paste "user@host:port" into the host field to fill all three. */
  const onHostChange = (v: string) => {
    const m = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(v.trim());
    if (m && (m[1] || m[3])) {
      if (m[1]) setUsername(m[1]);
      setHost(m[2]);
      if (m[3]) setPort(m[3]);
    } else setHost(v);
  };

  return (
    <Modal
      title={connection ? 'Edit server' : 'Add server'}
      onClose={onClose}
      footer={
        <>
          {connection && (
            <button className="danger" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button onClick={() => save(false)}>Save</button>
          <button className="primary" onClick={() => save(true)}>
            Save &amp; connect
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save(true);
        }}
      >
        <label>
          Name
          <input value={name} placeholder="e.g. Web server (optional)" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row">
          <label className="grow">
            Host
            <input value={host} autoFocus placeholder="example.com or user@host:port" onChange={(e) => onHostChange(e.target.value)} />
          </label>
          <label style={{ width: 90 }}>
            Port
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <label>
          Username
          <input value={username} placeholder="ubuntu, ec2-user, root…" onChange={(e) => setUsername(e.target.value)} />
        </label>

        <label>
          Private key (.pem)
          <div className="row">
            <select className="grow" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">— none —</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setImporting(true)}>
              Import…
            </button>
          </div>
        </label>
        {importing && (
          <div className="inset">
            <ImportKeyForm
              onDone={(k) => {
                setImporting(false);
                if (k) {
                  setKeys((ks) => [...ks, k]);
                  setKeyId(k.id);
                }
              }}
            />
          </div>
        )}

        <label>
          Password {connection?.hasPassword && password === undefined && <span className="muted">(saved)</span>}
          <div className="row">
            <input
              className="grow"
              type="password"
              value={password ?? ''}
              placeholder={connection?.hasPassword ? '•••••••• (leave empty to keep)' : 'Optional, if not using a key'}
              onChange={(e) => setPassword(e.target.value || undefined)}
            />
            {connection?.hasPassword && (
              <button type="button" onClick={() => setPassword('')} title="Remove saved password">
                Clear
              </button>
            )}
          </div>
          {password === '' && <span className="muted">Saved password will be removed.</span>}
        </label>

        <div className="row">
          <label className="grow">
            Group
            <input value={group} list="groups" placeholder="Optional" onChange={(e) => setGroup(e.target.value)} />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label>
            Color
            <div className="swatches">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c || 'none'}
                  className={`swatch ${color === c ? 'selected' : ''}`}
                  style={{ background: c || 'transparent' }}
                  onClick={() => setColor(c)}
                  aria-label={c || 'No color'}
                />
              ))}
            </div>
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
