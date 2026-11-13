import { useState, type FormEvent } from 'react';
import { Logo } from './Logo';
import { NEW_TOKEN_URL } from './SyncSection';
import { api, errMsg } from './util';

interface Props {
  mode: 'create' | 'unlock';
  onUnlocked(): void;
}

export function UnlockScreen({ mode, onUnlocked }: Props) {
  const [restore, setRestore] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'create' && !restore) {
      if (password.length < 8) return setError('Use at least 8 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }
    setBusy(true);
    try {
      if (restore) await api.syncRestore(repo, token, password);
      else if (mode === 'create') await api.createVault(password);
      else await api.unlock(password);
      setPassword('');
      setConfirm('');
      setToken('');
      onUnlocked();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (r: boolean) => {
    setRestore(r);
    setError('');
  };

  if (restore) {
    return (
      <div className="unlock-screen">
        <form className="unlock-card" onSubmit={submit}>
          <Logo size={40} />
          <p className="muted">
            Restore your servers and keys from the private GitHub repository you sync with on your other PC.
          </p>
          <div className="form">
            <label>
              Repository
              <input value={repo} autoFocus placeholder="owner/terminaltab-vault" onChange={(e) => setRepo(e.target.value)} />
            </label>
            <label>
              GitHub token
              <input type="password" value={token} placeholder="github_pat_…" onChange={(e) => setToken(e.target.value)} />
              <span className="small">
                <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
                  Create a token
                </a>{' '}
                with <i>Contents: Read and write</i> on that repo.
              </span>
            </label>
            <label>
              Master password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          {error && <div className="error">{error}</div>}
          <button className="primary" type="submit" disabled={busy || !repo || !token || !password}>
            {busy ? 'Downloading…' : 'Restore from GitHub'}
          </button>
          <button type="button" className="link-btn" onClick={() => switchMode(false)}>
            ← Start with an empty vault instead
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="unlock-screen">
      <form className="unlock-card" onSubmit={submit}>
        <Logo size={40} />
        <p className="muted">
          {mode === 'create'
            ? 'Create a master password. It encrypts your saved servers and keys. It cannot be recovered if you forget it.'
            : 'Enter your master password to unlock your servers and keys.'}
        </p>
        <input
          type="password"
          placeholder="Master password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === 'create' && (
          <input
            type="password"
            placeholder="Confirm master password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? 'Working…' : mode === 'create' ? 'Create vault' : 'Unlock'}
        </button>
        {mode === 'create' && (
          <button type="button" className="link-btn" onClick={() => switchMode(true)}>
            Already using TerminalTab on another PC? Restore from GitHub
          </button>
        )}
      </form>
    </div>
  );
}
