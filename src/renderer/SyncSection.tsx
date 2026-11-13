import { useState } from 'react';
import type { SyncStatus } from '../shared/types';
import { api, errMsg } from './util';

export const NEW_REPO_URL = 'https://github.com/new?name=terminaltab-vault&visibility=private';
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function ago(ts?: number): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

/** Short instructions shared by Settings and the restore screen. */
export function TokenHelp() {
  return (
    <ol className="help-steps muted small">
      <li>
        Create a <b>private</b> repository, e.g.{' '}
        <a href={NEW_REPO_URL} target="_blank" rel="noreferrer">
          terminaltab-vault
        </a>
        .
      </li>
      <li>
        Create a{' '}
        <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
          fine-grained token
        </a>
        : <i>Only select repositories</i> → that repo, permission <i>Contents: Read and write</i>.
      </li>
      <li>Paste both below. The token is stored inside your encrypted vault.</li>
    </ol>
  );
}

interface Props {
  repo?: string;
  status: SyncStatus;
  onChanged(): void;
}

export function SyncSection({ repo, status, onChanged }: Props) {
  const [repoInput, setRepoInput] = useState(repo ?? '');
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(!repo);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    run(async () => {
      await api.syncConnect(repoInput, token || undefined);
      setToken('');
      setEditing(false);
    });

  if (!repo || editing) {
    return (
      <div className="form">
        <p className="muted small">
          Sync your servers and keys between PCs through a private GitHub repository. Only the encrypted vault is
          uploaded.
        </p>
        <TokenHelp />
        <label>
          Repository
          <input value={repoInput} placeholder="owner/terminaltab-vault" onChange={(e) => setRepoInput(e.target.value)} />
        </label>
        <label>
          Token
          <input
            type="password"
            value={token}
            placeholder={repo ? 'Leave empty to keep the saved token' : 'github_pat_…'}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button className="primary" disabled={busy || !repoInput || (!repo && !token)} onClick={connect}>
            {busy ? 'Checking…' : repo ? 'Save' : 'Connect & sync'}
          </button>
          {repo && (
            <button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  const label: Record<SyncStatus['state'], string> = {
    off: 'Off',
    syncing: 'Syncing…',
    ok: `Synced ${ago(status.lastSyncAt)}`,
    error: 'Sync failed',
    'needs-password': 'Needs the master password from your other PC',
  };

  return (
    <div className="form">
      <div className="sync-card">
        <div>
          <span className={`sync-dot ${status.state}`} />
          <b>{label[status.state]}</b>
        </div>
        <div className="muted small">
          Repository:{' '}
          <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
            {repo}
          </a>
        </div>
        {status.message && status.state !== 'ok' && (
          <div className={status.state === 'error' ? 'error small' : 'small'}>{status.message}</div>
        )}
      </div>

      {status.state === 'needs-password' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const s = await api.syncNow(password);
              if (s.state === 'needs-password') throw new Error(s.message ?? 'Wrong password');
              setPassword('');
            });
          }}
        >
          <input
            className="grow"
            type="password"
            placeholder="Master password used on the other PC"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy || !password}>
            Unlock &amp; sync
          </button>
        </form>
      )}
      {status.state === 'needs-password' && (
        <p className="muted small">This PC will switch to that master password as well.</p>
      )}

      {status.weakPassword && (
        <p className="warn small">
          ⚠ Your master password is short. Because the encrypted vault is stored on GitHub, use a long one (e.g. four or
          five random words) — change it above.
        </p>
      )}

      {error && <div className="error">{error}</div>}
      <div className="row">
        <button disabled={busy || status.state === 'syncing'} onClick={() => run(() => api.syncNow())}>
          Sync now
        </button>
        <button disabled={busy} onClick={() => setEditing(true)}>
          Change repo / token
        </button>
        <span className="spacer" />
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            confirm('Stop syncing this PC? Nothing is deleted on GitHub or here.') && run(() => api.syncDisconnect())
          }
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
