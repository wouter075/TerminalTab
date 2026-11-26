import { useEffect, useState } from 'react';
import type { LocalShell, Settings, SyncStatus } from '../shared/types';
import { Modal } from './Modal';
import { FONT_SUGGESTIONS, THEMES } from './themes';
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
  const [theme, setTheme] = useState(settings.theme);
  const [fontFamily, setFontFamily] = useState(settings.fontFamily);
  const [autoReconnect, setAutoReconnect] = useState(settings.autoReconnect);
  const [logDir, setLogDir] = useState(settings.logDir);
  const [checkUpdates, setCheckUpdates] = useState(settings.checkUpdates);
  const [defaultShell, setDefaultShell] = useState(settings.defaultShell);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    api.localShells().then(setShells, () => undefined);
  }, []);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    await api.saveSettings({
      autoLockMinutes: Number(autoLock),
      fontSize: Number(fontSize),
      serverStats,
      theme,
      fontFamily,
      autoReconnect,
      logDir,
      checkUpdates,
      defaultShell,
    });
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

        <h3>Appearance</h3>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-swatch ${theme === t.id ? 'selected' : ''}`}
              onClick={() => setTheme(t.id)}
              title={t.name}
            >
              <span className="theme-preview" style={{ background: t.colors.background, color: t.colors.foreground }}>
                <span style={{ color: t.colors.green }}>user@host</span>:<span style={{ color: t.colors.blue }}>~</span>$ ls
                <br />
                <span style={{ color: t.colors.blue }}>docs</span> <span style={{ color: t.colors.red }}>error</span>{' '}
                <span style={{ color: t.colors.yellow }}>warn</span>
              </span>
              <span className="theme-name">{t.name}</span>
            </button>
          ))}
        </div>
        <label>
          Terminal font
          <input
            list="font-suggestions"
            value={fontFamily}
            placeholder="Default (Cascadia Mono / Consolas / DejaVu Sans Mono)"
            onChange={(e) => setFontFamily(e.target.value)}
          />
          <datalist id="font-suggestions">
            {FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <span className="muted small">Any font installed on this PC; falls back to the default if it isn't.</span>
        </label>

        <h3>Connections</h3>
        <label className="check">
          <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
          <span>
            Reconnect automatically
            <span className="muted small"> — when a connection drops (network, sleep, server restart). Not after you exit the shell.</span>
          </span>
        </label>
        <div className="form-field">
          <span>Session logs</span>
          <div className="row">
            <input className="grow mono small" readOnly value={logDir} placeholder="Off" />
            <button
              type="button"
              onClick={async () => {
                const dir = await api.pickLogDir();
                if (dir) setLogDir(dir);
              }}
            >
              Choose folder…
            </button>
            {logDir && (
              <button type="button" onClick={() => setLogDir('')}>
                Turn off
              </button>
            )}
          </div>
          <span className="muted small">
            Saves everything shown in each tab as a text file per server. Logs are <b>not encrypted</b> and can contain
            sensitive output.
          </span>
        </div>

        <h3>Local shells</h3>
        <div className="form-field">
          <span>Default shell</span>
          <div className="row">
            <select
              className="grow"
              value={shells.some((s) => s.id === defaultShell) ? defaultShell : ''}
              onChange={(e) => setDefaultShell(e.target.value)}
            >
              <option value="">{shells[0] ? `${shells[0].name} (first found)` : 'None found'}</option>
              {shells.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={scanning}
              title="Look for shells again, e.g. after installing PowerShell 7 or a WSL distro"
              onClick={async () => {
                setScanning(true);
                try {
                  setShells(await api.localShells(true));
                  onChanged();
                } finally {
                  setScanning(false);
                }
              }}
            >
              {scanning ? 'Looking…' : 'Find shells again'}
            </button>
          </div>
          <span className="muted small">
            Opened by Ctrl+Shift+T and listed under <i>This PC</i>. Local shells don't use the vault, but like SSH tabs
            they can't be typed into while TerminalTab is locked.
          </span>
        </div>

        <h3>Updates</h3>
        <label className="check">
          <input type="checkbox" checked={checkUpdates} onChange={(e) => setCheckUpdates(e.target.checked)} />
          <span>
            Check for new versions
            <span className="muted small">
              {' '}
              — {navigator.userAgent.includes('Windows')
                ? 'downloaded in the background and installed when you restart'
                : 'shows a notice with a download link'}
              . You're on version {APP_VERSION}.
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
