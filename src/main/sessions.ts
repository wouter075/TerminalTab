import { createHash, randomUUID } from 'node:crypto';
import { Client, utils, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { Connection, EndReason, KeyEntry, ServerStats, SessionInfo, SessionStatus } from '../shared/types';
import { parseStats, STATS_SCRIPT } from './serverStats';

export interface SessionCallbacks {
  onData(sessionId: string, data: Uint8Array): void;
  /** `reason` is set when the session ends ('closed' / 'error'). */
  onStatus(sessionId: string, status: SessionStatus, message?: string, reason?: EndReason): void;
  /** Resolve true to trust the host key. */
  verifyHostKey(hostPort: string, fingerprint: string): Promise<boolean>;
  /** Live stats for the watched session (see SessionManager.watch). */
  onInfo?(sessionId: string, info: SessionInfo): void;
  /** Whether to poll server stats (read on every poll so settings changes apply immediately). */
  serverStatsEnabled?(): boolean;
}

/** How often the watched session is refreshed, in ticks of INFO_TICK_MS. */
const INFO_TICK_MS = 2000;
const PING_EVERY = 3; // 6 s
const STATS_EVERY = 5; // 10 s
const MAX_STATS_FAILURES = 3;

/** ssh2 internals used to time a keepalive round trip (same mechanism ssh2 uses for keepaliveInterval). */
interface ClientInternals {
  _callbacks?: ((err: boolean) => void)[];
  _protocol?: { ping(): void };
}

interface Session {
  client: Client;
  stream?: ClientChannel;
  cols: number;
  rows: number;
  connectedAt?: number;
  bytesIn: number;
  bytesOut: number;
  latencyMs?: number;
  pinging?: boolean;
  server?: ServerStats | null;
  fetchingStats?: boolean;
  statsFailures: number;
  /** close() was called from this side. */
  closing?: boolean;
}

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Public-key fingerprint of a private key, in the same format as `ssh-keygen -lf`. */
export function keyFingerprint(pem: string, passphrase?: string): { type: string; fingerprint: string } | null {
  const parsed = utils.parseKey(pem, passphrase);
  if (parsed instanceof Error) return null;
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  return { type: k.type, fingerprint: fingerprintOf(k.getPublicSSH()) };
}

/** Explain an authentication failure in terms of what was actually offered. */
export function describeAuthFailure(conn: Connection, key: KeyEntry | undefined): string {
  const who = `${conn.username}@${conn.host}`;
  if (!key && !conn.password) {
    return `No private key or password is set for this server. Edit the server and select a key.`;
  }
  const parts: string[] = [];
  if (key) {
    const fp = keyFingerprint(key.pem, key.passphrase);
    parts.push(`key "${key.name}"${fp ? ` (${fp.type} ${fp.fingerprint})` : ''}`);
  }
  if (conn.password) parts.push('the saved password');
  return (
    `${who} rejected ${parts.join(' and ')}. Check the username, and that the matching public key ` +
    `is in ~/.ssh/authorized_keys on the server (compare with: ssh-keygen -lf ~/.ssh/authorized_keys).`
  );
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private watched: string | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private tick = 0;

  constructor(private readonly cb: SessionCallbacks) {}

  /** Start sending live info for one session (the visible tab); null stops it. */
  watch(sessionId: string | null): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watched = sessionId;
    if (!sessionId) return;
    this.tick = 0;
    this.refresh();
    this.watchTimer = setInterval(() => this.refresh(), INFO_TICK_MS);
  }

  private refresh(): void {
    const sid = this.watched;
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!sid || !s?.stream) return;
    const n = this.tick++;
    if (n % PING_EVERY === 0) this.ping(sid, s);
    if (n % STATS_EVERY === 0) this.pollStats(sid, s);
    this.emitInfo(sid, s);
  }

  private emitInfo(sid: string, s: Session): void {
    if (sid !== this.watched || !s.connectedAt) return;
    const statsOn = this.cb.serverStatsEnabled?.() ?? true;
    this.cb.onInfo?.(sid, {
      connectedAt: s.connectedAt,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      latencyMs: s.latencyMs,
      server: statsOn ? s.server : null,
    });
  }

  private ping(sid: string, s: Session): void {
    const c = s.client as unknown as ClientInternals;
    if (s.pinging || !c._callbacks || !c._protocol) return;
    s.pinging = true;
    const t0 = performance.now();
    // The server answers keepalive@openssh.com with success or failure; either way it's a round trip.
    c._callbacks.push(() => {
      s.pinging = false;
      s.latencyMs = Math.round(performance.now() - t0);
      this.emitInfo(sid, s);
    });
    c._protocol.ping();
  }

  private pollStats(sid: string, s: Session): void {
    if (s.fetchingStats || s.statsFailures >= MAX_STATS_FAILURES) return;
    if (!(this.cb.serverStatsEnabled?.() ?? true)) return;
    s.fetchingStats = true;
    const done = (stats: ServerStats | null) => {
      if (!s.fetchingStats) return;
      s.fetchingStats = false;
      if (stats) {
        s.statsFailures = 0;
        s.server = stats;
      } else if (++s.statsFailures >= MAX_STATS_FAILURES) {
        s.server = null;
      }
      this.emitInfo(sid, s);
    };
    const timer = setTimeout(() => done(null), 8000);
    try {
      s.client.exec('sh -s', (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return done(null);
        }
        let out = '';
        stream.on('data', (d: Buffer) => (out += d.toString('utf8')));
        stream.stderr.on('data', () => undefined);
        stream.on('close', () => {
          clearTimeout(timer);
          done(parseStats(out));
        });
        stream.end(STATS_SCRIPT);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  }

  open(conn: Connection, key: KeyEntry | undefined, cols: number, rows: number): string {
    const sessionId = randomUUID();
    const client = new Client();
    const session: Session = { client, cols, rows, bytesIn: 0, bytesOut: 0, statsFailures: 0 };
    this.sessions.set(sessionId, session);
    const hostPort = `${conn.host}:${conn.port}`;
    let ended = false;
    let shellExited = false;
    let hostRejected = false;
    const end = (status: SessionStatus, message: string | undefined, reason: EndReason) => {
      if (ended) return;
      ended = true;
      this.sessions.delete(sessionId);
      this.cb.onStatus(sessionId, status, message, session.closing ? 'user' : reason);
    };

    this.cb.onStatus(sessionId, 'connecting', `Connecting to ${conn.username}@${hostPort}…`);

    client
      .on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (err, stream) => {
          if (err) {
            end('error', err.message, 'lost');
            client.end();
            return;
          }
          session.stream = stream;
          session.connectedAt = Date.now();
          this.cb.onStatus(sessionId, 'connected');
          const onData = (d: Buffer) => {
            session.bytesIn += d.length;
            this.cb.onData(sessionId, d);
          };
          stream.on('data', onData);
          stream.stderr.on('data', onData);
          if (this.watched === sessionId) this.refresh();
          stream.on('exit', () => (shellExited = true));
          stream.on('close', () => {
            client.end();
            end('closed', shellExited ? 'Session ended' : 'Connection lost', shellExited ? 'exit' : 'lost');
          });
        });
      })
      .on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        // Answer password-style prompts with the saved password, if any.
        finish(prompts.map(() => conn.password ?? ''));
      })
      .on('error', (err: Error & { level?: string }) => {
        if (err.level === 'client-authentication') end('error', describeAuthFailure(conn, key), 'auth');
        else if (hostRejected) end('error', 'Host key not trusted', 'hostkey');
        else end('error', err.message, 'lost');
      })
      .on('close', () => end('closed', shellExited ? 'Session ended' : 'Connection lost', shellExited ? 'exit' : 'lost'));

    const config: ConnectConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      tryKeyboard: !!conn.password,
      hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => {
        const answer = (ok: boolean) => {
          if (!ok) hostRejected = true;
          verify(ok);
        };
        this.cb.verifyHostKey(hostPort, fingerprintOf(hostKey)).then(answer, () => answer(false));
      },
    } as ConnectConfig;
    if (key) {
      config.privateKey = key.pem;
      if (key.passphrase) config.passphrase = key.passphrase;
    }
    if (conn.password) config.password = conn.password;

    try {
      client.connect(config);
    } catch (err) {
      // e.g. unparseable private key / wrong passphrase
      end('error', (err as Error).message, 'auth');
    }
    return sessionId;
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (!s?.stream) return;
    s.bytesOut += Buffer.byteLength(data);
    s.stream.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.cols = cols;
    s.rows = rows;
    s.stream?.setWindow(rows, cols, 0, 0);
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.closing = true;
    s.client.end();
  }

  /** The ssh2 client of a connected session (used for SFTP). */
  getClient(sessionId: string): Client | undefined {
    const s = this.sessions.get(sessionId);
    return s?.stream ? s.client : undefined;
  }

  closeAll(): void {
    this.watch(null);
    for (const s of this.sessions.values()) s.client.end();
  }
}
