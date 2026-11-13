import { useState, type FormEvent } from 'react';
import { Logo } from './Logo';
import { api, errMsg } from './util';

interface Props {
  mode: 'create' | 'unlock';
  onUnlocked(): void;
}

export function UnlockScreen({ mode, onUnlocked }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'create') {
      if (password.length < 8) return setError('Use at least 8 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }
    setBusy(true);
    try {
      if (mode === 'create') await api.createVault(password);
      else await api.unlock(password);
      setPassword('');
      setConfirm('');
      onUnlocked();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

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
      </form>
    </div>
  );
}
