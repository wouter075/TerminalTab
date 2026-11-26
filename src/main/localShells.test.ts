import { describe, expect, it } from 'vitest';
import type { EndReason, LocalShell, SessionStatus } from '../shared/types';
import { LocalShellManager, parseEtcShells, parseWslList } from './localShells';

describe('parseWslList', () => {
  it('reads UTF-16 output and skips Docker distros', () => {
    const out = Buffer.from('﻿Ubuntu\r\nDebian\r\ndocker-desktop\r\n\r\n', 'utf16le');
    expect(parseWslList(out)).toEqual(['Ubuntu', 'Debian']);
  });
  it('reads UTF-8 output (WSL_UTF8=1)', () => {
    expect(parseWslList(Buffer.from('Ubuntu-24.04\n'))).toEqual(['Ubuntu-24.04']);
  });
  it('returns nothing when no distro is installed', () => {
    expect(parseWslList(Buffer.alloc(0))).toEqual([]);
  });
});

describe('parseEtcShells', () => {
  const etc = ['# /etc/shells', '/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/rbash', '/usr/bin/dash', '/usr/bin/tmux', '/usr/bin/zsh', ''].join('\n');
  // /bin is a symlink to /usr/bin, like on current Ubuntu / Fedora.
  const real = (p: string) => p.replace(/^\/bin\//, '/usr/bin/');

  it('puts the login shell first and drops duplicates and non-shells', () => {
    const shells = parseEtcShells(etc, '/usr/bin/zsh', real);
    expect(shells.map((s) => s.name)).toEqual(['zsh', 'bash']);
    expect(shells[1].file).toBe('/bin/bash');
  });
  it('keeps an unusual login shell', () => {
    expect(parseEtcShells(etc, '/bin/sh', real).map((s) => s.name)).toEqual(['sh', 'bash', 'zsh']);
  });
  it('skips shells that are not installed', () => {
    expect(parseEtcShells(etc, undefined, (p) => (p.endsWith('zsh') ? null : real(p))).map((s) => s.name)).toEqual(['bash']);
  });
});

const win = process.platform === 'win32';
const testShell: LocalShell = win
  ? { id: 'cmd', name: 'cmd', file: process.env.ComSpec ?? 'cmd.exe', args: [], kind: 'cmd' }
  : { id: 'sh', name: 'sh', file: '/bin/sh', args: [], kind: 'unix' };

function harness() {
  const statuses: { status: SessionStatus; message?: string; reason?: EndReason }[] = [];
  let output = '';
  let mgr!: LocalShellManager;
  mgr = new LocalShellManager(
    {
      onData: (sid, d) => {
        const text = Buffer.from(d).toString('utf8');
        output += text;
        // ConPTY asks for the terminal's attributes and waits for the answer (xterm.js answers in the app).
        if (text.includes('\x1b[c')) mgr.write(sid, '\x1b[?61;4c');
      },
      onStatus: (_sid, status, message, reason) => statuses.push({ status, message, reason }),
    },
    async () => [testShell],
  );
  const waitFor = async (cond: () => boolean, ms = 15000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout; output: ${JSON.stringify(output.slice(-300))}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { statuses, get output() { return output; }, mgr, waitFor };
}

describe('LocalShellManager', () => {
  it('runs a shell, passes input and output, and reports a normal exit', async () => {
    const h = harness();
    const { sessionId } = await h.mgr.open(testShell.id, 80, 24);
    expect(h.mgr.has(sessionId)).toBe(true);
    await h.waitFor(() => h.statuses.some((s) => s.status === 'connected'));
    h.mgr.write(sessionId, 'echo hello-$((6*7))-%OS%\r'.replace(win ? '$((6*7))' : '%OS%', win ? '42' : 'x'));
    await h.waitFor(() => (win ? /hello-42-Windows_NT/ : /hello-42-x/).test(h.output));
    h.mgr.resize(sessionId, 100, 30);
    h.mgr.write(sessionId, 'exit\r');
    await h.waitFor(() => h.statuses.some((s) => s.status === 'closed'));
    expect(h.statuses.at(-1)).toMatchObject({ status: 'closed', reason: 'exit' });
    expect(h.mgr.has(sessionId)).toBe(false);
  }, 30000);

  it('reports a close from this side as "user"', async () => {
    const h = harness();
    const { sessionId } = await h.mgr.open(testShell.id, 80, 24);
    await h.waitFor(() => h.statuses.some((s) => s.status === 'connected'));
    h.mgr.close(sessionId);
    await h.waitFor(() => h.statuses.some((s) => s.status === 'closed'));
    expect(h.statuses.at(-1)).toMatchObject({ status: 'closed', reason: 'user' });
  }, 30000);

  it('refuses a shell that is not installed', async () => {
    await expect(harness().mgr.open('nope', 80, 24)).rejects.toThrow(/not installed/);
  });
});
