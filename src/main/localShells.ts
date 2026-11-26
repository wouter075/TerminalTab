import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import type { LocalShell, SessionInfo, SessionStatus, EndReason } from '../shared/types';

// ---- shell detection ------------------------------------------------------

/** Output of `wsl.exe -l -q` (UTF-16LE unless WSL_UTF8=1) → distro names. */
export function parseWslList(out: Buffer): string[] {
  const text = out.includes(0) ? out.toString('utf16le') : out.toString('utf8');
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((l) => l && !/^docker-desktop(-data)?$/i.test(l));
}

const UNIX_SHELLS = ['bash', 'zsh', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'pwsh'];

/** /etc/shells → interactive shells, $SHELL first, without duplicates (e.g. /bin/bash and /usr/bin/bash). */
export function parseEtcShells(text: string, loginShell: string | undefined, realpath: (p: string) => string | null): LocalShell[] {
  const listed = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'));
  const candidates = [...(loginShell ? [loginShell] : []), ...listed];
  const seen = new Set<string>();
  const shells: LocalShell[] = [];
  for (const p of candidates) {
    const name = path.posix.basename(p);
    if (p !== loginShell && !UNIX_SHELLS.includes(name)) continue;
    const real = realpath(p);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    shells.push({ id: `unix:${p}`, name, file: p, args: [], kind: 'unix' });
  }
  return shells;
}

/** First existing file named `exe` on PATH. */
function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

function run(file: string, args: string[], timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'buffer', timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

async function detectWindows(): Promise<LocalShell[]> {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const sys32 = path.join(sysRoot, 'System32');
  const shells: LocalShell[] = [];
  const add = (s: LocalShell) => existsSync(s.file) && shells.push(s);

  add({ id: 'powershell', name: 'Windows PowerShell', file: path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], kind: 'powershell' });
  const pwsh = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), onPath('pwsh.exe')].find(
    (p) => p && existsSync(p),
  );
  if (pwsh) add({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo'], kind: 'powershell' });
  add({ id: 'cmd', name: 'Command Prompt', file: process.env.ComSpec ?? path.join(sys32, 'cmd.exe'), args: [], kind: 'cmd' });

  const git = onPath('git.exe');
  const bash = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    git ? path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe') : '',
  ].find((p) => p && existsSync(p));
  if (bash) add({ id: 'gitbash', name: 'Git Bash', file: bash, args: ['--login', '-i'], kind: 'gitbash' });

  const wsl = path.join(sys32, 'wsl.exe');
  if (existsSync(wsl)) {
    const out = await run(wsl, ['-l', '-q'], 8000);
    for (const distro of out ? parseWslList(out) : []) {
      shells.push({ id: `wsl:${distro}`, name: `${distro} (WSL)`, file: wsl, args: ['-d', distro, '--cd', '~'], kind: 'wsl' });
    }
  }
  return shells;
}

async function detectUnix(): Promise<LocalShell[]> {
  const text = await fs.readFile('/etc/shells', 'utf8').catch(() => '');
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const shells = parseEtcShells(text, process.env.SHELL, real);
  if (shells.length === 0 && existsSync('/bin/sh')) shells.push({ id: 'unix:/bin/sh', name: 'sh', file: '/bin/sh', args: [], kind: 'unix' });
  return shells;
}

export function detectShells(): Promise<LocalShell[]> {
  return process.platform === 'win32' ? detectWindows() : detectUnix();
}

// ---- running shells -------------------------------------------------------

type PtyModule = typeof import('node-pty');
let ptyModule: PtyModule | null = null;

/**
 * node-pty is a native module, so it isn't bundled: the packaged app ships it next to
 * app.asar (resources/node-pty, see forge.config.mts); in development it's in node_modules.
 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule;
  const req = createRequire(__filename);
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'node-pty');
  ptyModule = (packaged && existsSync(packaged) ? req(packaged) : req('node-pty')) as PtyModule;
  return ptyModule;
}

export interface LocalCallbacks {
  onData(sessionId: string, data: Uint8Array): void;
  onStatus(sessionId: string, status: SessionStatus, message?: string, reason?: EndReason): void;
  onInfo?(sessionId: string, info: SessionInfo): void;
}

interface LocalSession {
  pty: IPty;
  startedAt: number;
  bytesIn: number;
  bytesOut: number;
  closing?: boolean;
}

export class LocalShellManager {
  private sessions = new Map<string, LocalSession>();
  private shells: Promise<LocalShell[]> | null = null;
  private watched: string | null = null;
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cb: LocalCallbacks,
    private readonly detect: () => Promise<LocalShell[]> = detectShells,
  ) {}

  /** Installed shells (detected once; `fresh` looks again, e.g. after installing a WSL distro). */
  list(fresh = false): Promise<LocalShell[]> {
    if (!this.shells || fresh) this.shells = this.detect().catch(() => []);
    return this.shells;
  }

  async open(shellId: string, cols: number, rows: number): Promise<{ sessionId: string; shell: LocalShell }> {
    const shell = (await this.list()).find((s) => s.id === shellId);
    if (!shell) throw new Error('That shell is not installed on this PC');
    const pty = loadPty();
    const env = { ...process.env } as Record<string, string>;
    if (process.platform !== 'win32') {
      env.TERM = 'xterm-256color';
      env.COLORTERM = 'truecolor';
    }
    const term = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env,
      // The bundled conpty.dll: newer than the one in Windows 10, and node-pty's kill() then
      // doesn't fork a helper process (fork can't work with the RunAsNode fuse turned off).
      useConptyDll: true,
    });
    // node-pty rethrows pipe errors (e.g. EPIPE when input arrives just as the shell exits) as an
    // uncaught exception unless the app listens too; the exit itself is reported by onExit.
    (term as unknown as { on(event: 'error', l: (err: Error) => void): void }).on('error', () => undefined);
    const sessionId = randomUUID();
    const s: LocalSession ={ pty: term, startedAt: Date.now(), bytesIn: 0, bytesOut: 0 };
    this.sessions.set(sessionId, s);
    term.onData((d) => {
      const buf = Buffer.from(d, 'utf8');
      s.bytesIn += buf.length;
      this.cb.onData(sessionId, buf);
    });
    term.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
      if (this.watched === sessionId) this.watch(null);
      const message = s.closing ? 'Closed' : exitCode ? `${shell.name} exited with code ${exitCode}` : `${shell.name} exited`;
      this.cb.onStatus(sessionId, 'closed', message, s.closing ? 'user' : 'exit');
    });
    // Reported after the caller has the id (the renderer buffers early events anyway).
    setImmediate(() => {
      if (!this.sessions.has(sessionId)) return;
      this.cb.onStatus(sessionId, 'connected');
      if (this.watched === sessionId) this.emitInfo(sessionId);
    });
    return { sessionId, shell };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.bytesOut += Buffer.byteLength(data);
    s.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || cols < 1 || rows < 1) return;
    try {
      s.pty.resize(cols, rows);
    } catch {
      /* exited meanwhile */
    }
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.closing) return;
    s.closing = true;
    try {
      s.pty.kill();
    } catch {
      /* already gone */
    }
  }

  /** Live info for the visible tab (connected time and data counters in the status bar). */
  watch(sessionId: string | null): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watched = sessionId && this.sessions.has(sessionId) ? sessionId : null;
    if (!this.watched) return;
    const sid = this.watched;
    this.emitInfo(sid);
    this.watchTimer = setInterval(() => this.emitInfo(sid), 2000);
  }

  private emitInfo(sid: string): void {
    const s = this.sessions.get(sid);
    if (s) this.cb.onInfo?.(sid, { connectedAt: s.startedAt, bytesIn: s.bytesIn, bytesOut: s.bytesOut });
  }

  closeAll(): void {
    this.watch(null);
    for (const id of this.sessions.keys()) this.close(id);
  }
}
