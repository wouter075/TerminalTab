import { useEffect, useState, type ReactNode } from 'react';
import type { ConnectionInfo, KeyInfo, SessionInfo, SessionStatus } from '../shared/types';

interface Props {
  connection?: ConnectionInfo;
  keyInfo?: KeyInfo;
  status: SessionStatus;
  message?: string;
  info?: SessionInfo;
  cols?: number;
  rows?: number;
  statsEnabled: boolean;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}d` : h > 0 ? `${h}h` : `${Math.floor((sec % 3600) / 60)}m`;
}

/** warn ≥ 75 %, bad ≥ 90 % */
function level(fraction: number): string {
  return fraction >= 0.9 ? 'bad' : fraction >= 0.75 ? 'warn' : '';
}

function Item({ children, title, className = '' }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`sb-item ${className}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  closed: 'Disconnected',
  error: 'Error',
};

export function StatusBar({ connection, keyInfo, status, message, info, cols, rows, statsEnabled }: Props) {
  // Re-render every second for the connected-time counter.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== 'connected') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  const live = status === 'connected' ? info : undefined;
  const srv = live?.server;
  const auth = keyInfo ? `🔑 ${keyInfo.name}` : connection?.hasPassword ? '🔒 password' : '⚠ no key';

  return (
    <div className="statusbar">
      <Item title={message ?? STATUS_LABEL[status]} className="sb-status">
        <span className={`status-dot ${status}`} />
        {status !== 'connected' && STATUS_LABEL[status]}
      </Item>
      {connection && (
        <Item title={`${connection.username}@${connection.host}:${connection.port}`} className="sb-host">
          {connection.username}@{connection.host}
          {connection.port !== 22 ? `:${connection.port}` : ''}
        </Item>
      )}
      {connection && <Item title={keyInfo?.fingerprint ?? 'Authentication'}>{auth}</Item>}

      {live && (
        <Item title={`Connected since ${new Date(live.connectedAt).toLocaleTimeString()}`}>
          ⏱ {fmtDuration((now - live.connectedAt) / 1000)}
        </Item>
      )}
      {live?.latencyMs !== undefined && (
        <Item
          title="Round-trip time to the server"
          className={live.latencyMs >= 300 ? 'bad' : live.latencyMs >= 120 ? 'warn' : ''}
        >
          ⚡ {live.latencyMs} ms
        </Item>
      )}

      <span className="sb-spacer" />

      {live && statsEnabled && srv === undefined && <Item className="muted">Reading server stats…</Item>}
      {srv && (
        <span className="sb-server">
          {srv.os && (
            <Item title={srv.os} className="sb-os">
              {srv.os}
            </Item>
          )}
          {srv.load1 !== undefined && (
            <Item
              title={`1-minute load average${srv.cores ? ` on ${srv.cores} cores` : ''}`}
              className={srv.cores ? level(srv.load1 / srv.cores) : ''}
            >
              CPU {srv.load1.toFixed(2)}
              {srv.cores ? `/${srv.cores}` : ''}
            </Item>
          )}
          {srv.memTotal !== undefined && srv.memUsed !== undefined && (
            <Item title="Memory used / total" className={level(srv.memUsed / srv.memTotal)}>
              RAM {fmtBytes(srv.memUsed)} / {fmtBytes(srv.memTotal)}
            </Item>
          )}
          {srv.diskTotal !== undefined && srv.diskUsed !== undefined && (
            <Item title="Disk used / total on /" className={level(srv.diskUsed / srv.diskTotal)}>
              Disk {fmtBytes(srv.diskUsed)} / {fmtBytes(srv.diskTotal)}
            </Item>
          )}
          {srv.uptimeSec !== undefined && (
            <Item title={`Server uptime: ${fmtDuration(srv.uptimeSec)}`}>up {fmtUptime(srv.uptimeSec)}</Item>
          )}
        </span>
      )}

      {cols !== undefined && rows !== undefined && (
        <Item title="Terminal size (columns × rows)">
          {cols}×{rows}
        </Item>
      )}
      {live && (
        <Item title="Data sent / received in this session">
          ↑ {fmtBytes(live.bytesOut)} ↓ {fmtBytes(live.bytesIn)}
        </Item>
      )}
    </div>
  );
}
