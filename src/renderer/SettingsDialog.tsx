import { useState } from 'react';
import type { Settings, SyncStatus } from '../shared/types';
import { Modal } from './Modal';
import { SyncSection } from './SyncSection';
import { api, errMsg } from './util';

interface Props {
  settings: Settings;
  syncRepo?: string;
  syncStatus: SyncStatus;
  onClose(): void;
  onChanged(): void;
}

export function SettingsDialog({ settings, syncRepo, syncStatus, onClose, onChanged }: Props) {
  const [autoLock, setAutoLock] = useState(String(settings.autoLockMinutes));
  const [fontSize, setFontSize] = useState(String(settings.fontSize));
  const [serverStats, setServerStats] = useState(settings.serverStats);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    await api.saveSettings({ autoLockMinutes: Number(autoLock), fontSize: Number(fontSize), serverStats });
    onChanged();
    onClose();
  };

  const changePw = async () => {
    setMsg(null);
    if (newPw !== newPw2) return setMsg({ ok: false, text: 'New passwords do not match.' });
    try {
      await api.changePassword(oldPw, newPw);
      setOldPw('');
      setNewPw('');
      setNewPw2('');
      setMsg({ ok: true, text: 'Master password changed.' });
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    }
  };

  return (
    <Modal
      width={540}
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <div className="row">
          <label className="grow">
            Auto-lock after (minutes, 0 = never)
            <input value={autoLock} inputMode="numeric" onChange={(e) => setAutoLock(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="grow">
            Terminal font size
            <input value={fontSize} inputMode="numeric" onChange={(e) => setFontSize(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>

        <label className="check">
          <input type="checkbox" checked={serverStats} onChange={(e) => setServerStats(e.target.checked)} />
          <span>
            Show server stats in the status bar
            <span className="muted small">
              {' '}
              — OS, CPU load, memory and disk of the visible tab's server. Runs a small read-only command
              over the connection every 10 seconds (Linux servers).
            </span>
          </span>
        </label>

        <h3>Change master password</h3>
        <input type="password" placeholder="Current password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        <input type="password" placeholder="New password (min. 8)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        <input type="password" placeholder="Confirm new password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
        <div className="row">
          <button onClick={changePw} disabled={!oldPw || !newPw}>
            Change password
          </button>
          {msg && <span className={msg.ok ? 'ok' : 'error'}>{msg.text}</span>}
        </div>

        <h3>Sync with GitHub</h3>
        <SyncSection repo={syncRepo} status={syncStatus} onChanged={onChanged} />
      </div>
    </Modal>
  );
}
